import path from 'node:path';
import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import crypto from 'node:crypto';

import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { RateLimiterMemory } from 'rate-limiter-flexible';

import { getConfigValue } from '../util.js';
import { read } from '../character-card-parser.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';
import { requireAdminMiddleware } from '../users.js';

const GALLERY_DIR_NAME = '_gallery';
const ITEMS_DIR_NAME = 'items';
const ID_REGEXP = /^[a-f0-9]{12}$/;
const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 32;
const MAX_TITLE_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_REPORT_REASON_LENGTH = 500;
const MAX_VERSION_HISTORY = 20;

const GALLERY_ENABLED = getConfigValue('gallery.enabled', true);
const ALLOW_PUBLISH = getConfigValue('gallery.allowPublish', true);
const REQUIRE_APPROVAL = getConfigValue('gallery.requireApproval', false);
const DEFAULT_PAGE_SIZE = getConfigValue('gallery.pageSize', 24);

const publishLimiter = new RateLimiterMemory({
    points: 30,
    duration: 3600,
});

export const router = express.Router();

// The entire gallery can be disabled via config
router.use((request, response, next) => {
    if (!GALLERY_ENABLED) {
        return response.sendStatus(404);
    }

    return next();
});

/**
 * Returns the root directory of the gallery storage.
 * @returns {string} Path to the gallery root
 */
function getGalleryRoot() {
    return path.join(globalThis.DATA_ROOT, GALLERY_DIR_NAME);
}

/**
 * Returns the directory that stores gallery items.
 * @returns {string} Path to the items directory
 */
function getItemsDir() {
    return path.join(getGalleryRoot(), ITEMS_DIR_NAME);
}

/**
 * Creates gallery directories if they do not exist.
 * @returns {void}
 */
function ensureGalleryDirs() {
    fs.mkdirSync(getItemsDir(), { recursive: true });
}

/**
 * Returns the path to the item metadata file.
 * @param {string} id Item ID
 * @returns {string} Path to the JSON file
 */
function itemJsonPath(id) {
    return path.join(getItemsDir(), `${id}.json`);
}

/**
 * Returns the path to the item image file (the character card PNG).
 * @param {string} id Item ID
 * @returns {string} Path to the PNG file
 */
function itemImagePath(id) {
    return path.join(getItemsDir(), `${id}.png`);
}

/**
 * Checks that the item ID is well-formed.
 * @param {string} id Item ID
 * @returns {boolean} True if valid
 */
function isValidId(id) {
    return typeof id === 'string' && ID_REGEXP.test(id);
}

/**
 * Reads an item record from disk.
 * @param {string} id Item ID
 * @returns {Promise<object|null>} The item record or null
 */
async function readRecord(id) {
    if (!isValidId(id)) {
        return null;
    }

    try {
        const raw = await fsPromises.readFile(itemJsonPath(id), 'utf8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

/**
 * Writes an item record to disk atomically.
 * @param {object} record Item record
 * @returns {Promise<void>}
 */
async function writeRecord(record) {
    ensureGalleryDirs();
    writeFileAtomicSync(itemJsonPath(record.id), JSON.stringify(record, null, 2));
}

/**
 * Reads all item records from disk.
 * @returns {Promise<object[]>} Array of item records
 */
async function allRecords() {
    ensureGalleryDirs();
    const files = await fsPromises.readdir(getItemsDir());
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    const records = await Promise.all(jsonFiles.map(f => readRecord(f.replace('.json', ''))));
    return records.filter(r => r && !r.deleted);
}

/**
 * Removes an item's files from disk.
 * @param {string} id Item ID
 * @returns {Promise<void>}
 */
async function removeItemFiles(id) {
    for (const p of [itemJsonPath(id), itemImagePath(id)]) {
        try {
            await fsPromises.unlink(p);
        } catch {
            // Already gone
        }
    }
}

/**
 * Converts an item record into a view model safe to send to clients.
 * @param {object} record Item record
 * @param {string} handle Handle of the requesting user
 * @param {boolean} isAdmin Whether the requesting user is an admin
 * @returns {object} View model
 */
function toViewModel(record, handle, isAdmin) {
    const { reports, likes, claimedBy, ...rest } = record;
    return {
        ...rest,
        likes: Array.isArray(likes) ? likes.length : 0,
        liked: Array.isArray(likes) && likes.includes(handle),
        claimed: Array.isArray(claimedBy) && claimedBy.includes(handle),
        isOwner: record.author === handle,
        reports: isAdmin ? (reports ?? []) : (reports?.length ?? 0),
    };
}

/**
 * Sanitizes and trims a list of tags.
 * @param {unknown} tags Raw tags
 * @returns {string[]} Sanitized tags
 */
function sanitizeTags(tags) {
    if (!Array.isArray(tags)) {
        return [];
    }

    return [...new Set(tags
        .filter(t => typeof t === 'string')
        .map(t => t.trim().slice(0, MAX_TAG_LENGTH))
        .filter(Boolean))].slice(0, MAX_TAGS);
}

/**
 * Gets a nested property of an object, used to read card fields.
 * @param {object} obj Object to read from
 * @param {string} key Dot-separated path
 * @returns {unknown} Value or undefined
 */
function deepGet(obj, key) {
    return key.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), obj);
}

/**
 * Extracts displayable metadata from a character card object.
 * @param {object} card Parsed character card
 * @returns {{ name: string, description: string, tags: string[], creator: string }}
 */
function extractCardMeta(card) {
    const get = (key) => {
        const value = deepGet(card, `data.${key}`) ?? deepGet(card, key);
        if (Array.isArray(value)) {
            return value.map(v => (typeof v === 'string' ? v : deepGet(v, 'name') ?? '')).filter(Boolean).join(', ');
        }
        return typeof value === 'string' ? value : '';
    };

    return {
        name: get('name').trim() || 'Unnamed',
        description: get('description').trim(),
        tags: get('tags').split(/[,，]/).map(t => t.trim()).filter(Boolean),
        creator: get('creator').trim(),
    };
}

/**
 * Reads and parses a character card PNG from the user's directory.
 * @param {string} fileName File name inside the user's characters directory
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {Promise<{ card: object, meta: object }>} Parsed card and metadata
 */
async function readUserCard(fileName, directories) {
    const filePath = path.join(directories.characters, sanitize(fileName));

    if (!filePath.startsWith(directories.characters)) {
        throw new Error('Invalid file path');
    }

    if (!fs.existsSync(filePath)) {
        throw new Error('Character file not found');
    }

    const raw = read(await fsPromises.readFile(filePath));

    if (!raw) {
        throw new Error('Character card has no embedded data');
    }

    const card = JSON.parse(raw);
    return { card, meta: extractCardMeta(card) };
}

/**
 * Returns a non-conflicting file name inside the user's characters directory.
 * @param {string} baseName Desired base name
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {string} Unique file name (without extension)
 */
function getUniqueCharacterName(baseName, directories) {
    const clean = sanitize(baseName) || 'character';
    let name = clean;
    let counter = 1;

    while (fs.existsSync(path.join(directories.characters, `${name}.png`))) {
        name = `${clean}_${counter}`;
        counter++;

        if (counter > 10000) {
            throw new Error('Could not find a free file name');
        }
    }

    return name;
}

/**
 * Verifies that the user is allowed to modify the item.
 * @param {object} record Item record
 * @param {import('express').Request} request Express request
 * @returns {boolean} True if allowed
 */
function canModify(record, request) {
    return record.author === request.user.profile.handle || request.user.profile.admin === true;
}

router.post('/list', async (request, response) => {
    try {
        const handle = request.user.profile.handle;
        const isAdmin = request.user.profile.admin === true;
        const { q, sort, tag, mine, page, limit } = request.body ?? {};
        const pageSize = Math.min(Math.max(parseInt(limit) || DEFAULT_PAGE_SIZE, 1), 100);
        const currentPage = Math.max(parseInt(page) || 1, 1);
        const query = typeof q === 'string' ? q.trim().toLowerCase() : '';

        let items = await allRecords();

        // Only public items are listed; unlisted items are accessible by direct link or by the owner
        items = items.filter(item => item.visibility === 'public' || item.author === handle);
        items = items.filter(item => !item.hidden || item.author === handle || isAdmin);

        if (mine === true) {
            items = items.filter(item => item.author === handle);
        }

        if (typeof tag === 'string' && tag) {
            items = items.filter(item => (item.tags ?? []).some(t => t.toLowerCase() === tag.toLowerCase()));
        }

        if (query) {
            items = items.filter(item => {
                const haystack = [item.title, item.description, item.author, item.authorName, item.cardName, ...(item.tags ?? [])]
                    .join(' ')
                    .toLowerCase();
                return haystack.includes(query);
            });
        }

        const sorters = {
            new: (a, b) => (b.updated ?? b.created ?? 0) - (a.updated ?? a.created ?? 0),
            hot: (a, b) => ((b.likes?.length ?? 0) * 3 + (b.downloads ?? 0)) - ((a.likes?.length ?? 0) * 3 + (a.downloads ?? 0)),
            downloads: (a, b) => (b.downloads ?? 0) - (a.downloads ?? 0),
        };

        items.sort(sorters[sort] ?? sorters.new);

        const total = items.length;
        const start = (currentPage - 1) * pageSize;
        const paged = items.slice(start, start + pageSize);

        return response.json({
            items: paged.map(item => toViewModel(item, handle, isAdmin)),
            total,
            page: currentPage,
            pages: Math.max(Math.ceil(total / pageSize), 1),
        });
    } catch (error) {
        console.error('Gallery list failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/item', async (request, response) => {
    try {
        const record = await readRecord(request.body?.id);

        if (!record || record.deleted) {
            return response.sendStatus(404);
        }

        const handle = request.user.profile.handle;
        const isAdmin = request.user.profile.admin === true;

        if (record.hidden && record.author !== handle && !isAdmin) {
            return response.sendStatus(404);
        }

        if (record.visibility !== 'public' && record.author !== handle && !isAdmin) {
            // Unlisted items are only visible to the owner and admins on this endpoint
            return response.sendStatus(404);
        }

        return response.json(toViewModel(record, handle, isAdmin));
    } catch (error) {
        console.error('Gallery item failed:', error);
        return response.sendStatus(500);
    }
});

router.get('/image/:id', async (request, response) => {
    try {
        const id = request.params.id;

        if (!isValidId(id)) {
            return response.sendStatus(400);
        }

        const imagePath = itemImagePath(id);

        if (!fs.existsSync(imagePath)) {
            return response.sendStatus(404);
        }

        response.setHeader('Cache-Control', 'public, max-age=3600');
        return response.sendFile(path.resolve(imagePath));
    } catch (error) {
        console.error('Gallery image failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/tags', async (request, response) => {
    try {
        const handle = request.user.profile.handle;
        const items = await allRecords();
        const counts = new Map();

        for (const item of items) {
            if (item.hidden || item.deleted) {
                continue;
            }

            if (item.visibility !== 'public' && item.author !== handle) {
                continue;
            }

            for (const tag of item.tags ?? []) {
                counts.set(tag, (counts.get(tag) ?? 0) + 1);
            }
        }

        const tags = [...counts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 30)
            .map(([tag, count]) => ({ tag, count }));

        return response.json({ tags });
    } catch (error) {
        console.error('Gallery tags failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/publish', getFileNameValidationFunction('avatar_url'), async (request, response) => {
    try {
        const handle = request.user.profile.handle;

        if (!ALLOW_PUBLISH) {
            return response.status(403).json({ error: 'Publishing is disabled by the administrator' });
        }

        try {
            await publishLimiter.consume(handle);
        } catch {
            return response.status(429).json({ error: 'Too many publications, please try again later' });
        }

        const avatarUrl = request.body?.avatar_url;

        if (typeof avatarUrl !== 'string' || !avatarUrl) {
            return response.status(400).json({ error: 'Missing character file' });
        }

        const { meta } = await readUserCard(avatarUrl, request.user.directories);

        const title = String(request.body?.title ?? meta.name).trim().slice(0, MAX_TITLE_LENGTH) || meta.name;
        const description = String(request.body?.description ?? meta.description ?? '').trim().slice(0, MAX_DESCRIPTION_LENGTH);
        const tags = sanitizeTags(request.body?.tags ?? meta.tags);
        const visibility = request.body?.visibility === 'unlisted' ? 'unlisted' : 'public';

        // One published item per character file
        const existing = (await allRecords()).find(item => item.author === handle && item.sourceFile === avatarUrl);

        if (existing) {
            return response.status(409).json({ error: 'This character is already published. Use "update" to publish a new version.', id: existing.id });
        }

        const now = Date.now();
        const record = {
            id: crypto.randomBytes(6).toString('hex'),
            type: 'character',
            title,
            description,
            tags,
            visibility,
            author: handle,
            authorName: request.user.profile.name || handle,
            cardName: meta.name,
            sourceFile: avatarUrl,
            created: now,
            updated: now,
            version: 1,
            versions: [{ version: 1, date: now, note: String(request.body?.note ?? '').trim().slice(0, 500) }],
            downloads: 0,
            likes: [],
            claimedBy: [],
            reports: [],
            hidden: REQUIRE_APPROVAL,
            deleted: false,
        };

        ensureGalleryDirs();
        await fsPromises.copyFile(path.join(request.user.directories.characters, avatarUrl), itemImagePath(record.id));
        await writeRecord(record);

        console.info(`Gallery item published: ${record.id} by ${handle}`);
        return response.json(toViewModel(record, handle, request.user.profile.admin === true));
    } catch (error) {
        console.error('Gallery publish failed:', error);
        return response.status(500).json({ error: error.message || 'Publish failed' });
    }
});

router.post('/update', getFileNameValidationFunction('avatar_url'), async (request, response) => {
    try {
        const record = await readRecord(request.body?.id);

        if (!record || record.deleted) {
            return response.sendStatus(404);
        }

        if (!canModify(record, request)) {
            return response.sendStatus(403);
        }

        const avatarUrl = request.body?.avatar_url;

        if (typeof avatarUrl !== 'string' || !avatarUrl) {
            return response.status(400).json({ error: 'Missing character file' });
        }

        const { meta } = await readUserCard(avatarUrl, request.user.directories);

        const now = Date.now();
        record.version = (record.version ?? 1) + 1;
        record.updated = now;
        record.cardName = meta.name;
        record.sourceFile = avatarUrl;
        record.versions = [
            ...(record.versions ?? []),
            { version: record.version, date: now, note: String(request.body?.note ?? '').trim().slice(0, 500) },
        ].slice(-MAX_VERSION_HISTORY);

        if (typeof request.body?.title === 'string') {
            record.title = request.body.title.trim().slice(0, MAX_TITLE_LENGTH) || record.title;
        }

        if (typeof request.body?.description === 'string') {
            record.description = request.body.description.trim().slice(0, MAX_DESCRIPTION_LENGTH);
        }

        if (request.body?.tags !== undefined) {
            record.tags = sanitizeTags(request.body.tags);
        }

        await fsPromises.copyFile(path.join(request.user.directories.characters, avatarUrl), itemImagePath(record.id));
        await writeRecord(record);

        return response.json(toViewModel(record, request.user.profile.handle, request.user.profile.admin === true));
    } catch (error) {
        console.error('Gallery update failed:', error);
        return response.status(500).json({ error: error.message || 'Update failed' });
    }
});

router.post('/delete', async (request, response) => {
    try {
        const record = await readRecord(request.body?.id);

        if (!record) {
            return response.sendStatus(404);
        }

        if (!canModify(record, request)) {
            return response.sendStatus(403);
        }

        await removeItemFiles(record.id);
        console.info(`Gallery item deleted: ${record.id} by ${request.user.profile.handle}`);
        return response.sendStatus(204);
    } catch (error) {
        console.error('Gallery delete failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/like', async (request, response) => {
    try {
        const record = await readRecord(request.body?.id);

        if (!record || record.deleted || record.hidden) {
            return response.sendStatus(404);
        }

        const handle = request.user.profile.handle;
        record.likes = Array.isArray(record.likes) ? record.likes : [];

        if (record.likes.includes(handle)) {
            record.likes = record.likes.filter(h => h !== handle);
        } else {
            record.likes.push(handle);
        }

        await writeRecord(record);
        return response.json(toViewModel(record, handle, request.user.profile.admin === true));
    } catch (error) {
        console.error('Gallery like failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/claim', async (request, response) => {
    try {
        const record = await readRecord(request.body?.id);

        if (!record || record.deleted || record.hidden) {
            return response.sendStatus(404);
        }

        const handle = request.user.profile.handle;

        if (record.visibility !== 'public' && record.author !== handle && request.user.profile.admin !== true) {
            return response.sendStatus(403);
        }

        const sourcePath = itemImagePath(record.id);

        if (!fs.existsSync(sourcePath)) {
            return response.status(404).json({ error: 'Item files are missing' });
        }

        const fileName = getUniqueCharacterName(record.cardName ?? record.title, request.user.directories);
        await fsPromises.copyFile(sourcePath, path.join(request.user.directories.characters, `${fileName}.png`));

        record.claimedBy = Array.isArray(record.claimedBy) ? record.claimedBy : [];

        if (!record.claimedBy.includes(handle)) {
            record.claimedBy.push(handle);
        }

        record.downloads = (record.downloads ?? 0) + 1;
        await writeRecord(record);

        console.info(`Gallery item claimed: ${record.id} by ${handle}`);
        return response.json({ file_name: fileName, ...toViewModel(record, handle, request.user.profile.admin === true) });
    } catch (error) {
        console.error('Gallery claim failed:', error);
        return response.status(500).json({ error: error.message || 'Claim failed' });
    }
});

router.post('/report', async (request, response) => {
    try {
        const record = await readRecord(request.body?.id);

        if (!record || record.deleted) {
            return response.sendStatus(404);
        }

        const handle = request.user.profile.handle;
        record.reports = Array.isArray(record.reports) ? record.reports : [];

        if (record.reports.some(r => r.by === handle)) {
            return response.status(409).json({ error: 'You already reported this item' });
        }

        record.reports.push({
            by: handle,
            reason: String(request.body?.reason ?? '').trim().slice(0, MAX_REPORT_REASON_LENGTH),
            date: Date.now(),
        });

        await writeRecord(record);
        return response.sendStatus(204);
    } catch (error) {
        console.error('Gallery report failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/admin/list', requireAdminMiddleware, async (request, response) => {
    try {
        const handle = request.user.profile.handle;
        const items = await allRecords();
        items.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
        return response.json({ items: items.map(item => toViewModel(item, handle, true)) });
    } catch (error) {
        console.error('Gallery admin list failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/admin/hide', requireAdminMiddleware, async (request, response) => {
    try {
        const record = await readRecord(request.body?.id);

        if (!record) {
            return response.sendStatus(404);
        }

        record.hidden = request.body?.hidden !== false;
        await writeRecord(record);
        return response.json(toViewModel(record, request.user.profile.handle, true));
    } catch (error) {
        console.error('Gallery admin hide failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/admin/delete', requireAdminMiddleware, async (request, response) => {
    try {
        const record = await readRecord(request.body?.id);

        if (!record) {
            return response.sendStatus(404);
        }

        await removeItemFiles(record.id);
        console.info(`Gallery item deleted by admin: ${record.id}`);
        return response.sendStatus(204);
    } catch (error) {
        console.error('Gallery admin delete failed:', error);
        return response.sendStatus(500);
    }
});
