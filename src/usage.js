import path from 'node:path';
import fs from 'node:fs';

import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { getConfigValue } from './util.js';
import { getUserDirectories } from './users.js';
import { resolveUserChannel } from './managed-channels.js';

const USAGE_FILE_NAME = 'usage-stats.json';
const FLUSH_INTERVAL_MS = 10 * 1000;
const MAX_CAPTURED_BYTES = 256 * 1024;
const MAX_TRACKED_MODELS = 50;
const TOKENS_PER_UNIT = 1_000_000;

/** Numeric counter fields; everything else (e.g. the channel name) is metadata. */
const COUNTER_KEYS = ['requests', 'errors', 'promptTokens', 'completionTokens', 'totalTokens', 'cost'];

/**
 * @typedef {object} UsageCounters
 * @property {number} requests Number of LLM requests
 * @property {number} errors Number of failed LLM requests
 * @property {number} promptTokens Input tokens
 * @property {number} completionTokens Output tokens
 * @property {number} totalTokens Total tokens
 * @property {number} cost Estimated cost in the configured currency
 */

/**
 * @typedef {object} UserUsageStats
 * @property {string} handle User handle
 * @property {number} updated Last update timestamp
 * @property {number} lastActive Timestamp of the last LLM request
 * @property {UsageCounters} totals Lifetime counters
 * @property {Record<string, UsageCounters>} days Per-day counters (YYYY-MM-DD)
 * @property {Record<string, UsageCounters & { channel?: string }>} models Per-model counters
 */

/** In-memory counters that are flushed to disk periodically. */
const pending = new Map();

/** Pending flush timer, so writes are batched instead of hitting the disk per request. */
let flushTimer = null;

/**
 * Returns the effective usage statistics configuration.
 * @returns {{ enabled: boolean, retentionDays: number, currency: string }} Config
 */
export function getUsageConfig() {
    return {
        enabled: getConfigValue('usageStats.enabled', true),
        retentionDays: getConfigValue('usageStats.retentionDays', 90),
        currency: getConfigValue('usageStats.currency', '¥'),
    };
}

/**
 * Returns the path to the usage file of a user.
 * The file lives inside the user's own data directory, so it is removed
 * together with the account.
 * @param {import('./users.js').UserDirectoryList} directories User directories
 * @returns {string} Path
 */
function getUsagePath(directories) {
    return path.join(directories.root, USAGE_FILE_NAME);
}

/**
 * Creates an empty set of counters.
 * @returns {UsageCounters} Zeroed counters
 */
function emptyCounters() {
    return Object.fromEntries(COUNTER_KEYS.map(key => [key, 0]));
}

/**
 * Creates an empty statistics record.
 * @param {string} handle User handle
 * @returns {UserUsageStats} Empty stats
 */
function emptyStats(handle) {
    return { handle, updated: 0, lastActive: 0, totals: emptyCounters(), days: {}, models: {} };
}

/**
 * Normalizes a parsed stats object, so old or partial files stay usable.
 * @param {string} handle User handle
 * @param {object} raw Parsed file contents
 * @returns {UserUsageStats} Normalized stats
 */
function normalizeStats(handle, raw) {
    const stats = emptyStats(handle);

    if (!raw || typeof raw !== 'object') {
        return stats;
    }

    stats.updated = Number(raw.updated) || 0;
    stats.lastActive = Number(raw.lastActive) || 0;
    Object.assign(stats.totals, pickCounters(raw.totals));

    for (const [day, counters] of Object.entries(raw.days ?? {})) {
        stats.days[day] = pickCounters(counters);
    }

    for (const [model, counters] of Object.entries(raw.models ?? {})) {
        stats.models[model] = { ...pickCounters(counters), channel: counters?.channel ?? '' };
    }

    return stats;
}

/**
 * Copies the known counter fields of an object.
 * @param {object} source Source object
 * @returns {UsageCounters} Counters
 */
function pickCounters(source) {
    const counters = emptyCounters();

    if (!source || typeof source !== 'object') {
        return counters;
    }

    for (const key of COUNTER_KEYS) {
        counters[key] = Number(source[key]) || 0;
    }

    return counters;
}

/**
 * Adds counters into a target object in place. Non-numeric metadata
 * fields (like the channel name) are left untouched.
 * @param {UsageCounters} target Target counters
 * @param {UsageCounters} delta Counters to add
 * @returns {void}
 */
function addCounters(target, delta) {
    for (const key of COUNTER_KEYS) {
        target[key] = (Number(target[key]) || 0) + (Number(delta[key]) || 0);
    }

    target.cost = Math.round(target.cost * 1e6) / 1e6;
}

/**
 * Reads the usage statistics of a user from disk.
 * @param {import('./users.js').UserDirectoryList} directories User directories
 * @returns {UserUsageStats} Usage statistics
 */
export function readUserStats(directories) {
    if (!directories?.root) {
        return emptyStats('');
    }

    try {
        return normalizeStats(path.basename(directories.root), JSON.parse(fs.readFileSync(getUsagePath(directories), 'utf8')));
    } catch {
        return emptyStats(path.basename(directories.root));
    }
}

/**
 * Removes per-day counters that are older than the retention period.
 * @param {UserUsageStats} stats Stats to prune (mutated in place)
 * @param {number} retentionDays Number of days to keep
 * @returns {UserUsageStats} The same stats object
 */
function pruneOldDays(stats, retentionDays) {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
        return stats;
    }

    const days = Object.keys(stats.days).sort();
    const excess = days.length - retentionDays;

    for (let i = 0; i < excess; i++) {
        delete stats.days[days[i]];
    }

    const models = Object.keys(stats.models);

    if (models.length > MAX_TRACKED_MODELS) {
        const ranked = models
            .map(model => ({ model, total: stats.models[model].totalTokens ?? 0 }))
            .sort((a, b) => b.total - a.total)
            .slice(MAX_TRACKED_MODELS);

        for (const { model } of ranked) {
            delete stats.models[model];
        }
    }

    return stats;
}

/**
 * Returns the local date key (YYYY-MM-DD) of a timestamp.
 * @param {number} [timestamp] Timestamp, defaults to now
 * @returns {string} Date key
 */
function toDayKey(timestamp = Date.now()) {
    const date = new Date(timestamp);
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Queues a usage delta for a user. Counters are kept in memory and flushed
 * to disk every few seconds to keep the write load low.
 * @param {object} entry Usage entry
 * @param {import('./users.js').UserDirectoryList} entry.directories User directories
 * @param {string} entry.handle User handle
 * @param {string|null} [entry.model] Model name
 * @param {string|null} [entry.channelName] Managed channel name
 * @param {number} [entry.promptTokens] Input tokens
 * @param {number} [entry.completionTokens] Output tokens
 * @param {number} [entry.cost] Estimated cost
 * @param {boolean} [entry.ok] Whether the request succeeded
 * @returns {void}
 */
export function recordUsage(entry) {
    const config = getUsageConfig();
    const handle = entry?.handle;

    if (!config.enabled || !handle || !entry?.directories?.root) {
        return;
    }

    const delta = {
        requests: 1,
        errors: entry.ok === false ? 1 : 0,
        promptTokens: Math.max(Number(entry.promptTokens) || 0, 0),
        completionTokens: Math.max(Number(entry.completionTokens) || 0, 0),
        totalTokens: 0,
        cost: Math.max(Number(entry.cost) || 0, 0),
    };
    delta.totalTokens = delta.promptTokens + delta.completionTokens;

    const queued = pending.get(handle) ?? { directories: entry.directories, deltas: [], at: Date.now() };
    queued.deltas.push({ ...delta, model: entry.model ?? null, channelName: entry.channelName ?? null, at: Date.now() });
    pending.set(handle, queued);

    if (!flushTimer) {
        flushTimer = setTimeout(() => {
            flushTimer = null;
            flushUsage();
        }, FLUSH_INTERVAL_MS);
        flushTimer.unref?.();
    }
}

/**
 * Writes all queued usage deltas to disk.
 * @returns {void}
 */
export function flushUsage() {
    if (!pending.size) {
        return;
    }

    const entries = [...pending.entries()];
    pending.clear();

    for (const [handle, queued] of entries) {
        try {
            const config = getUsageConfig();
            const stats = readUserStats(queued.directories);

            for (const delta of queued.deltas) {
                const { model, channelName, at, ...counters } = delta;
                const dayKey = toDayKey(at);

                addCounters(stats.totals, counters);
                stats.days[dayKey] = stats.days[dayKey] ?? emptyCounters();
                addCounters(stats.days[dayKey], counters);

                const modelKey = model || '未知模型';
                stats.models[modelKey] = stats.models[modelKey] ?? { ...emptyCounters(), channel: '' };
                addCounters(stats.models[modelKey], counters);

                if (channelName) {
                    stats.models[modelKey].channel = channelName;
                }

                stats.lastActive = Math.max(stats.lastActive, at);
            }

            stats.updated = Date.now();
            pruneOldDays(stats, config.retentionDays);

            fs.mkdirSync(queued.directories.root, { recursive: true });
            writeFileAtomicSync(getUsagePath(queued.directories), JSON.stringify(stats, null, 2));
        } catch (error) {
            console.error(`Failed to write usage stats for ${handle}:`, error);
        }
    }
}

// Do not lose buffered counters when the process shuts down
process.on('exit', () => flushUsage());

/**
 * Extracts token usage from a (possibly streamed) LLM response body.
 * Handles OpenAI-style `usage`, Anthropic-style `input_tokens`/`output_tokens`
 * and Google-style `usageMetadata`. Streamed counters are cumulative, so the
 * maximum of every occurrence is used.
 * @param {string} text Response body text
 * @returns {{ promptTokens: number, completionTokens: number }|null} Usage or null
 */
export function extractUsage(text) {
    if (!text) {
        return null;
    }

    let promptTokens = 0;
    let completionTokens = 0;
    let found = false;

    for (const pattern of [/"usage"\s*:\s*(\{[^{}]*\})/g, /"usageMetadata"\s*:\s*(\{[^{}]*\})/g]) {
        for (const match of text.matchAll(pattern)) {
            try {
                const usage = JSON.parse(match[1]);
                const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount) || 0;
                const completion = Number(usage.completion_tokens ?? usage.output_tokens ?? usage.candidatesTokenCount) || 0;

                if (prompt || completion) {
                    found = true;
                    promptTokens = Math.max(promptTokens, prompt);
                    completionTokens = Math.max(completionTokens, completion);
                }
            } catch {
                // Partial or malformed fragment: ignore it
            }
        }
    }

    return found ? { promptTokens, completionTokens } : null;
}

/**
 * Estimates the cost of a request based on the channel pricing.
 * @param {object|null} channel Managed channel record
 * @param {number} promptTokens Input tokens
 * @param {number} completionTokens Output tokens
 * @returns {number} Estimated cost
 */
export function estimateCost(channel, promptTokens, completionTokens) {
    const priceInput = Number(channel?.priceInput) || 0;
    const priceOutput = Number(channel?.priceOutput) || 0;

    if (!priceInput && !priceOutput) {
        return 0;
    }

    const cost = (promptTokens / TOKENS_PER_UNIT) * priceInput + (completionTokens / TOKENS_PER_UNIT) * priceOutput;
    return Math.round(cost * 1e6) / 1e6;
}

/**
 * Express middleware that records LLM usage (requests, tokens, cost) per user.
 * The response body is captured (bounded, tail kept) to read the usage counters
 * that providers return, including streaming responses.
 * @param {import('express').Request} request Express request
 * @param {import('express').Response} response Express response
 * @param {import('express').NextFunction} next Next handler
 * @returns {void}
 */
export function usageTrackingMiddleware(request, response, next) {
    try {
        const handle = request.user?.profile?.handle;

        if (!getUsageConfig().enabled || !handle) {
            return next();
        }

        const chunks = [];
        let captured = 0;
        const originalWrite = response.write.bind(response);
        const originalEnd = response.end.bind(response);

        /**
         * Keeps the tail of the response body for usage parsing.
         * @param {Buffer|string} chunk Response chunk
         * @returns {void}
         */
        const collect = (chunk) => {
            try {
                if (!chunk) {
                    return;
                }

                const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
                chunks.push(text);
                captured += text.length;

                // Keep only the tail: usage counters arrive at the very end
                while (captured > MAX_CAPTURED_BYTES && chunks.length > 1) {
                    captured -= chunks.shift().length;
                }
            } catch {
                // Never let accounting break a response
            }
        };

        response.write = function (chunk, ...args) {
            collect(chunk);
            return originalWrite(chunk, ...args);
        };

        response.end = function (chunk, ...args) {
            if (chunk && typeof chunk !== 'function') {
                collect(chunk);
            }

            return originalEnd(chunk, ...args);
        };

        response.on('finish', () => {
            try {
                const body = request.body ?? {};
                const model = String(body.model ?? body.model_name ?? body.model_id ?? '').slice(0, 100) || null;
                const channel = request.user?.profile?.admin === true ? null : resolveUserChannel(request.user.directories);
                const usage = extractUsage(chunks.join(''));
                const promptTokens = usage?.promptTokens ?? 0;
                const completionTokens = usage?.completionTokens ?? 0;

                recordUsage({
                    handle,
                    model,
                    channelName: channel?.name ?? null,
                    promptTokens,
                    completionTokens,
                    cost: estimateCost(channel, promptTokens, completionTokens),
                    ok: response.statusCode < 400,
                    directories: request.user.directories,
                });
            } catch {
                // Accounting must never surface an error to the user
            }
        });

        return next();
    } catch (error) {
        console.error('Usage tracking middleware failed:', error);
        return next();
    }
}

/**
 * Sums a list of counter objects.
 * @param {UsageCounters[]} list Counters
 * @returns {UsageCounters} Combined counters
 */
function sumCounters(list) {
    const total = emptyCounters();

    for (const counters of list) {
        addCounters(total, counters);
    }

    return total;
}

/**
 * Returns the date keys of the last N days, oldest first.
 * @param {number} days Number of days
 * @returns {string[]} Date keys
 */
function lastDayKeys(days) {
    const keys = [];

    for (let i = days - 1; i >= 0; i--) {
        keys.push(toDayKey(Date.now() - (i * 24 * 60 * 60 * 1000)));
    }

    return keys;
}

/**
 * Builds a summary of the usage of a single user.
 * @param {import('./users.js').UserDirectoryList} directories User directories
 * @param {number} [seriesDays=14] Number of days in the returned series
 * @returns {object} Summary for the UI
 */
export function summarizeUserUsage(directories, seriesDays = 14) {
    flushUsage();
    const stats = readUserStats(directories);
    const dayKeys = lastDayKeys(seriesDays);
    const inRange = (key) => dayKeys.includes(key);

    const todayKey = toDayKey();
    const weekKeys = lastDayKeys(7);
    const monthKeys = lastDayKeys(30);

    return {
        handle: stats.handle,
        lastActive: stats.lastActive,
        totals: stats.totals,
        today: stats.days[todayKey] ?? emptyCounters(),
        week: sumCounters(weekKeys.map(key => stats.days[key]).filter(Boolean)),
        month: sumCounters(monthKeys.map(key => stats.days[key]).filter(Boolean)),
        series: dayKeys.map(day => ({ day, ...(stats.days[day] ?? emptyCounters()) })),
        models: Object.entries(stats.models)
            .map(([model, counters]) => ({ model, ...counters }))
            .sort((a, b) => b.totalTokens - a.totalTokens),
        activeDays: Object.keys(stats.days).filter(inRange).length,
        currency: getUsageConfig().currency,
    };
}

/**
 * Builds a site-wide usage summary across users.
 * @param {string[]} handles User handles to include
 * @param {number} [seriesDays=14] Number of days in the returned series
 * @returns {object} Summary for the admin UI
 */
export function summarizeSiteUsage(handles, seriesDays = 14) {
    flushUsage();
    const dayKeys = lastDayKeys(seriesDays);
    const perUser = [];
    const perModel = new Map();
    const series = new Map(dayKeys.map(day => [day, { day, ...emptyCounters() }]));
    const totals = emptyCounters();
    let activeUsers = 0;

    for (const handle of handles) {
        const stats = readUserStats(getUserDirectories(handle));

        if (!stats.totals.requests) {
            continue;
        }

        activeUsers++;
        addCounters(totals, stats.totals);
        perUser.push({
            handle,
            lastActive: stats.lastActive,
            totals: stats.totals,
            today: stats.days[toDayKey()] ?? emptyCounters(),
            week: sumCounters(lastDayKeys(7).map(day => stats.days[day]).filter(Boolean)),
        });

        for (const day of dayKeys) {
            if (stats.days[day]) {
                addCounters(series.get(day), stats.days[day]);
            }
        }

        for (const [model, counters] of Object.entries(stats.models)) {
            const existing = perModel.get(model) ?? { model, channel: counters.channel ?? '', ...emptyCounters(), users: 0 };
            addCounters(existing, counters);
            existing.users += 1;
            existing.channel = counters.channel || existing.channel;
            perModel.set(model, existing);
        }
    }

    perUser.sort((a, b) => b.totals.totalTokens - a.totals.totalTokens || b.totals.requests - a.totals.requests);

    return {
        totals,
        activeUsers,
        series: [...series.values()],
        models: [...perModel.values()].sort((a, b) => b.totalTokens - a.totalTokens),
        users: perUser,
        currency: getUsageConfig().currency,
        retentionDays: getUsageConfig().retentionDays,
    };
}
