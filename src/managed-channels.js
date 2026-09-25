import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { getConfigValue } from './util.js';
import { SECRET_KEYS } from './endpoints/secrets.js';

const MANAGED_DIR_NAME = '_managed';
const CHANNELS_FILE_NAME = 'channels.json';
const SELECTION_FILE_NAME = 'managed-channel.json';

export const CHANNEL_TYPES = {
    OPENAI_COMPATIBLE: 'openai-compatible',
    ANTHROPIC: 'anthropic',
    GOOGLE: 'google',
    TEXT_COMPLETIONS: 'text-completions',
};

const CHANNEL_TYPE_LABELS = {
    [CHANNEL_TYPES.OPENAI_COMPATIBLE]: 'OpenAI 兼容',
    [CHANNEL_TYPES.ANTHROPIC]: 'Anthropic (Claude)',
    [CHANNEL_TYPES.GOOGLE]: 'Google (Gemini)',
    [CHANNEL_TYPES.TEXT_COMPLETIONS]: '文本补全 (Kobold 兼容)',
};

/**
 * Returns the type label for the UI.
 * @param {string} type Channel type
 * @returns {string} Human-readable label
 */
export function getChannelTypeLabel(type) {
    return CHANNEL_TYPE_LABELS[type] ?? type;
}

/**
 * Returns the effective managed channel configuration.
 * @returns {{ enabled: boolean, restrictNonAdmins: boolean }} Config
 */
export function getManagedChannelConfig() {
    return {
        enabled: getConfigValue('managedChannels.enabled', true),
        restrictNonAdmins: getConfigValue('managedChannels.restrictNonAdmins', true),
    };
}

/**
 * Returns the managed storage directory.
 * @returns {string} Path
 */
function getManagedDir() {
    return path.join(globalThis.DATA_ROOT, MANAGED_DIR_NAME);
}

/**
 * Returns the path to the channels file.
 * @returns {string} Path
 */
function getChannelsPath() {
    return path.join(getManagedDir(), CHANNELS_FILE_NAME);
}

/**
 * Reads all managed channels.
 * @returns {object[]} Channel records
 */
export function listChannels() {
    try {
        const raw = fs.readFileSync(getChannelsPath(), 'utf8');
        const channels = JSON.parse(raw);
        return Array.isArray(channels) ? channels : [];
    } catch {
        return [];
    }
}

/**
 * Persists the managed channels.
 * @param {object[]} channels Channel records
 * @returns {void}
 */
function saveChannels(channels) {
    fs.mkdirSync(getManagedDir(), { recursive: true });
    writeFileAtomicSync(getChannelsPath(), JSON.stringify(channels, null, 2));
}

/**
 * Converts a channel record into a view model safe to send to clients.
 * The API key is never included; only a masked hint is returned.
 * @param {object} channel Channel record
 * @param {boolean} [withKey=false] Whether to include the raw key (admin editing)
 * @returns {object} View model
 */
export function toViewModel(channel, withKey = false) {
    return {
        id: channel.id,
        name: channel.name,
        type: channel.type,
        typeLabel: getChannelTypeLabel(channel.type),
        url: channel.url,
        models: channel.models ?? [],
        priceInput: Number(channel.priceInput) || 0,
        priceOutput: Number(channel.priceOutput) || 0,
        enabled: channel.enabled !== false,
        created: channel.created ?? 0,
        keyHint: channel.key ? `${channel.key.slice(0, 3)}…${channel.key.slice(-3)}` : '',
        ...(withKey ? { key: channel.key ?? '' } : {}),
    };
}

/**
 * Creates or updates a managed channel.
 * @param {object} input Channel input
 * @returns {object} The saved channel record
 */
export function saveChannel(input) {
    const channels = listChannels();
    const existing = input.id ? channels.find(c => c.id === input.id) : null;

    const channel = {
        id: existing?.id ?? crypto.randomBytes(4).toString('hex'),
        name: String(input.name ?? '').trim().slice(0, 60) || '未命名渠道',
        type: Object.values(CHANNEL_TYPES).includes(input.type) ? input.type : CHANNEL_TYPES.OPENAI_COMPATIBLE,
        url: String(input.url ?? '').trim().slice(0, 500),
        // Keep the previous key when the update leaves it empty
        key: String(input.key ?? '').trim() || (existing?.key ?? ''),
        models: Array.isArray(input.models)
            ? [...new Set(input.models.map(m => String(m).trim().slice(0, 100)).filter(Boolean))].slice(0, 200)
            : [],
        // Optional pricing (per 1M tokens), used for the usage statistics
        priceInput: Math.max(Number(input.priceInput) || 0, 0),
        priceOutput: Math.max(Number(input.priceOutput) || 0, 0),
        enabled: input.enabled !== false,
        created: existing?.created ?? Date.now(),
    };

    if (existing) {
        channels[channels.indexOf(existing)] = channel;
    } else {
        channels.push(channel);
    }

    saveChannels(channels);
    return channel;
}

/**
 * Deletes a managed channel.
 * @param {string} id Channel ID
 * @returns {boolean} True if the channel existed and was removed
 */
export function deleteChannel(id) {
    const channels = listChannels();
    const filtered = channels.filter(c => c.id !== id);

    if (filtered.length === channels.length) {
        return false;
    }

    saveChannels(filtered);
    return true;
}

/**
 * Returns the enabled channels visible to regular users.
 * @returns {object[]} View models without keys
 */
export function listEnabledChannels() {
    return listChannels().filter(c => c.enabled !== false).map(c => toViewModel(c, false));
}

/**
 * Reads the channel selection of a user.
 * @param {import('./users.js').UserDirectoryList} directories User directories
 * @returns {{ channelId: string|null, model: string|null }} Selection
 */
export function getUserSelection(directories) {
    try {
        const raw = fs.readFileSync(path.join(directories.root, SELECTION_FILE_NAME), 'utf8');
        const selection = JSON.parse(raw);
        return {
            channelId: selection?.channelId ?? null,
            model: selection?.model ?? null,
        };
    } catch {
        return { channelId: null, model: null };
    }
}

/**
 * Persists the channel selection of a user.
 * @param {import('./users.js').UserDirectoryList} directories User directories
 * @param {{ channelId: string|null, model: string|null }} selection Selection
 * @returns {void}
 */
export function setUserSelection(directories, selection) {
    fs.mkdirSync(directories.root, { recursive: true });
    writeFileAtomicSync(
        path.join(directories.root, SELECTION_FILE_NAME),
        JSON.stringify({ channelId: selection.channelId ?? null, model: selection.model ?? null }, null, 2),
    );
}

/**
 * Resolves the channel that serves a user's requests.
 * Falls back to the first enabled channel when the user has no valid selection.
 * @param {import('./users.js').UserDirectoryList} directories User directories
 * @returns {object|null} Channel record or null when no channels are configured
 */
export function resolveUserChannel(directories) {
    const enabled = listChannels().filter(c => c.enabled !== false);

    if (!enabled.length) {
        return null;
    }

    const selection = getUserSelection(directories);
    return enabled.find(c => c.id === selection.channelId) ?? enabled[0];
}

/**
 * Builds a directories object whose API key secrets are served from the
 * managed channel, so the channel key never reaches the client or its files.
 * @param {import('./users.js').UserDirectoryList} directories User directories
 * @param {object} channel Channel record
 * @returns {import('./users.js').UserDirectoryList} Wrapped directories
 */
function withManagedSecrets(directories, channel) {
    const managedSecrets = {};

    for (const key of Object.values(SECRET_KEYS)) {
        managedSecrets[key] = channel.key ?? '';
    }

    return Object.assign(Object.create(directories), { __managedSecrets: managedSecrets });
}

/**
 * Express middleware that pins non-admin users to a managed channel.
 * The API URL and key are forced server-side; users cannot bring their own.
 * Does nothing when managed channels are disabled or none are configured.
 * @param {import('express').Request} request Express request
 * @param {import('express').Response} response Express response
 * @param {import('express').NextFunction} next Next handler
 * @returns {void}
 */
export function managedChannelsMiddleware(request, response, next) {
    try {
        const config = getManagedChannelConfig();

        if (!config.enabled || !config.restrictNonAdmins) {
            return next();
        }

        if (request.user?.profile?.admin === true) {
            return next();
        }

        const channel = resolveUserChannel(request.user.directories);

        if (!channel) {
            // No channels configured: fall back to unrestricted behavior
            return next();
        }

        const body = request.body ?? {};
        const requestedModel = body.model ?? body.model_name ?? null;

        if (Array.isArray(channel.models) && channel.models.length > 0 && requestedModel && !channel.models.includes(requestedModel)) {
            return response.status(403).json({ error: `模型 ${requestedModel} 不可用，请在「模型」页面选择可用模型` });
        }

        // Force the request onto the managed channel
        request.user.directories = withManagedSecrets(request.user.directories, channel);

        switch (channel.type) {
            case CHANNEL_TYPES.ANTHROPIC:
                body.chat_completion_source = 'claude';
                body.reverse_proxy = channel.url;
                body.proxy_password = channel.key;
                break;
            case CHANNEL_TYPES.GOOGLE:
                body.chat_completion_source = 'makersuite';
                body.reverse_proxy = channel.url;
                body.proxy_password = channel.key;
                break;
            case CHANNEL_TYPES.TEXT_COMPLETIONS:
                body.api_server = channel.url;
                body.server_url = channel.url;
                break;
            case CHANNEL_TYPES.OPENAI_COMPATIBLE:
            default:
                body.chat_completion_source = 'custom';
                body.custom_url = channel.url;
                body.custom_api_key = channel.key;
                body.reverse_proxy = channel.url;
                body.proxy_password = channel.key;
                break;
        }

        return next();
    } catch (error) {
        console.error('Managed channel middleware failed:', error);
        return response.sendStatus(500);
    }
}

/**
 * Express middleware that blocks secret (API key) modifications for users
 * pinned to managed channels.
 * @param {import('express').Request} request Express request
 * @param {import('express').Response} response Express response
 * @param {import('express').NextFunction} next Next handler
 * @returns {void}
 */
export function blockSecretWritesMiddleware(request, response, next) {
    try {
        const config = getManagedChannelConfig();

        if (!config.enabled || !config.restrictNonAdmins) {
            return next();
        }

        if (request.user?.profile?.admin === true) {
            return next();
        }

        // Only allow reading secrets; writes are reserved for admins
        if (request.method === 'POST' && !['/read', '/find', '/view', '/settings'].includes(request.path)) {
            return response.status(403).json({ error: 'API 密钥由管理员统一配置，普通用户不可修改' });
        }

        return next();
    } catch (error) {
        console.error('Block secret writes middleware failed:', error);
        return response.sendStatus(500);
    }
}
