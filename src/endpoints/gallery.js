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
import { checkGalleryQuota, checkStorageQuota } from '../quotas.js';

const GALLERY_DIR_NAME = '_gallery';
const ITEMS_DIR_NAME = 'items';
const COMMENTS_DIR_NAME = 'comments';
const FAVORITES_FILE_NAME = 'gallery-favorites.json';
const ID_REGEXP = /^[a-f0-9]{12}$/;
const COMMENT_ID_REGEXP = /^[a-f0-9]{10}$/;
const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 32;
const MAX_TITLE_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_REPORT_REASON_LENGTH = 500;
const MAX_VERSION_HISTORY = 20;
const MAX_COMMENTS_PER_ITEM = 1000;
const MAX_RECENT_COMMENTS = 100;

const GALLERY_ENABLED = getConfigValue('gallery.enabled', true);
const ALLOW_PUBLISH = getConfigValue('gallery.allowPublish', true);
const ALLOW_COMMENTS = getConfigValue('gallery.allowComments', true);
const COMMENT_MAX_LENGTH = getConfigValue('gallery.commentMaxLength', 1000);
const REQUIRE_APPROVAL = getConfigValue('gallery.requireApproval', false);
const DEFAULT_PAGE_SIZE = getConfigValue('gallery.pageSize', 24);

const publishLimiter = new RateLimiterMemory({
    points: 30,
    duration: 3600,
});

const commentLimiter = new RateLimiterMemory({
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
 * Returns the directory that stores item comments.
 * @returns {string} Path to the comments directory
 */
function getCommentsDir() {
    return path.join(getGalleryRoot(), COMMENTS_DIR_NAME);
}

/**
 * Creates gallery directories if they do not exist.
 * @returns {void}
 */
function ensureGalleryDirs() {
    fs.mkdirSync(getItemsDir(), { recursive: true });
    fs.mkdirSync(getCommentsDir(), { recursive: true });
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
 * Returns the path to the comments file of an item.
 * @param {string} id Item ID
 * @returns {string} Path to the JSON file
 */
function itemCommentsPath(id) {
    return path.join(getCommentsDir(), `${id}.json`);
}

/**
 * Reads the comments of an item.
 * @param {string} id Item ID
 * @returns {Promise<object[]>} Comments, oldest first
 */
async function readComments(id) {
    if (!isValidId(id)) {
        return [];
    }

    try {
        const raw = await fsPromises.readFile(itemCommentsPath(id), 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed?.comments) ? parsed.comments.filter(c => c && !c.deleted) : [];
    } catch {
        return [];
    }
}

/**
 * Writes the comments of an item and keeps the stored count in sync.
 * The counter only includes comments that are visible to everyone.
 * @param {string} id Item ID
 * @param {object[]} comments Comments, oldest first
 * @returns {Promise<void>}
 */
async function persistComments(id, comments) {
    ensureGalleryDirs();
    const kept = comments.slice(-MAX_COMMENTS_PER_ITEM);
    writeFileAtomicSync(itemCommentsPath(id), JSON.stringify({ itemId: id, comments: kept }, null, 2));

    const record = await readRecord(id);

    if (record) {
        record.commentCount = kept.filter(c => !c.hidden && !c.deleted).length;
        await writeRecord(record);
    }
}

/**
 * Converts a comment record into a view model.
 * @param {object} comment Comment record
 * @param {string} handle Handle of the requesting user
 * @param {boolean} isAdmin Whether the requesting user is an admin
 * @returns {object} View model
 */
function commentToViewModel(comment, handle, isAdmin) {
    return {
        id: comment.id,
        author: comment.author,
        authorName: comment.authorName || comment.author,
        text: comment.text,
        created: comment.created ?? 0,
        likes: Array.isArray(comment.likes) ? comment.likes.length : 0,
        liked: Array.isArray(comment.likes) && comment.likes.includes(handle),
        hidden: comment.hidden === true,
        isOwner: comment.author === handle,
        canModerate: isAdmin,
    };
}

/**
 * Reads the favorite item IDs of a user.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {string[]} Favorite item IDs
 */
function readFavorites(directories) {
    try {
        const raw = fs.readFileSync(path.join(directories.root, FAVORITES_FILE_NAME), 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed?.ids) ? parsed.ids.filter(id => typeof id === 'string') : [];
    } catch {
        return [];
    }
}

/**
 * Persists the favorite item IDs of a user.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string[]} ids Favorite item IDs
 * @returns {void}
 */
function writeFavorites(directories, ids) {
    fs.mkdirSync(directories.root, { recursive: true });
    writeFileAtomicSync(path.join(directories.root, FAVORITES_FILE_NAME), JSON.stringify({ ids: ids.slice(0, 2000) }, null, 2));
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
export async function allRecords() {
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
    for (const p of [itemJsonPath(id), itemImagePath(id), itemCommentsPath(id)]) {
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
 * @param {string[]} [favorites] Item IDs favorited by the requesting user
 * @returns {object} View model
 */
function toViewModel(record, handle, isAdmin, favorites = []) {
    const { reports, likes, claimedBy, ...rest } = record;
    return {
        ...rest,
        likes: Array.isArray(likes) ? likes.length : 0,
        liked: Array.isArray(likes) && likes.includes(handle),
        claimed: Array.isArray(claimedBy) && claimedBy.includes(handle),
        favorited: favorites.includes(record.id),
        comments: Number(record.commentCount) || 0,
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
        const { q, sort, tag, mine, favorites: favoritesOnly, page, limit } = request.body ?? {};
        const favorites = readFavorites(request.user.directories);
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

        if (favoritesOnly === true) {
            items = items.filter(item => favorites.includes(item.id));
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
            comments: (a, b) => (b.commentCount ?? 0) - (a.commentCount ?? 0),
        };

        items.sort(sorters[sort] ?? sorters.new);

        const total = items.length;
        const start = (currentPage - 1) * pageSize;
        const paged = items.slice(start, start + pageSize);

        return response.json({
            items: paged.map(item => toViewModel(item, handle, isAdmin, favorites)),
            total,
            page: currentPage,
            pages: Math.max(Math.ceil(total / pageSize), 1),
            favorites: favorites.length,
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

        return response.json(toViewModel(record, handle, isAdmin, readFavorites(request.user.directories)));
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

        // Enforce per-user quotas
        const publishedCount = (await allRecords()).filter(item => item.author === handle && !item.deleted).length;
        const galleryQuotaError = checkGalleryQuota(publishedCount);

        if (galleryQuotaError) {
            return response.status(413).json({ error: galleryQuotaError });
        }

        const storageQuotaError = checkStorageQuota(request.user.directories);

        if (storageQuotaError) {
            return response.status(413).json({ error: storageQuotaError });
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
            commentCount: 0,
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

/**
 * Verifies that a user may see an item (and therefore its comments).
 * @param {object} record Item record
 * @param {string} handle Handle of the requesting user
 * @param {boolean} isAdmin Whether the requesting user is an admin
 * @returns {boolean} True if the item is visible
 */
function canView(record, handle, isAdmin) {
    if (!record || record.deleted) {
        return false;
    }

    if (record.author === handle || isAdmin) {
        return true;
    }

    return !record.hidden && record.visibility === 'public';
}

router.post('/comments', async (request, response) => {
    try {
        const record = await readRecord(request.body?.id);
        const handle = request.user.profile.handle;
        const isAdmin = request.user.profile.admin === true;

        if (!canView(record, handle, isAdmin)) {
            return response.sendStatus(404);
        }

        const comments = await readComments(record.id);
        const visible = comments.filter(c => !c.hidden || c.author === handle || isAdmin);

        return response.json({
            comments: visible.map(c => commentToViewModel(c, handle, isAdmin)),
            total: comments.filter(c => !c.hidden).length,
            allowComments: ALLOW_COMMENTS,
            maxLength: COMMENT_MAX_LENGTH,
        });
    } catch (error) {
        console.error('Gallery comments failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/comment', async (request, response) => {
    try {
        const record = await readRecord(request.body?.id);
        const handle = request.user.profile.handle;
        const isAdmin = request.user.profile.admin === true;

        if (!canView(record, handle, isAdmin)) {
            return response.sendStatus(404);
        }

        if (!ALLOW_COMMENTS) {
            return response.status(403).json({ error: '评论功能已被管理员关闭' });
        }

        try {
            await commentLimiter.consume(handle);
        } catch {
            return response.status(429).json({ error: '评论太频繁了，请稍后再试' });
        }

        const text = String(request.body?.text ?? '').trim().slice(0, COMMENT_MAX_LENGTH);

        if (!text) {
            return response.status(400).json({ error: '评论内容不能为空' });
        }

        const comments = await readComments(record.id);

        // Basic spam guard: no identical consecutive comment from the same user
        const last = comments.filter(c => c.author === handle).at(-1);

        if (last && last.text === text && Date.now() - (last.created ?? 0) < 60 * 1000) {
            return response.status(409).json({ error: '刚刚已经发过一样的评论了' });
        }

        const comment = {
            id: crypto.randomBytes(5).toString('hex'),
            author: handle,
            authorName: request.user.profile.name || handle,
            text,
            created: Date.now(),
            likes: [],
            hidden: false,
            deleted: false,
        };

        await persistComments(record.id, [...comments, comment]);
        return response.json({
            comment: commentToViewModel(comment, handle, isAdmin),
            total: comments.filter(c => !c.hidden).length + 1,
        });
    } catch (error) {
        console.error('Gallery comment failed:', error);
        return response.status(500).json({ error: error.message || 'Comment failed' });
    }
});

router.post('/comment/delete', async (request, response) => {
    try {
        const itemId = String(request.body?.id ?? '');
        const commentId = String(request.body?.commentId ?? '');
        const record = await readRecord(itemId);

        if (!record) {
            return response.sendStatus(404);
        }

        const handle = request.user.profile.handle;
        const isAdmin = request.user.profile.admin === true;
        const comments = await readComments(itemId);
        const comment = comments.find(c => c.id === commentId && COMMENT_ID_REGEXP.test(commentId));

        if (!comment) {
            return response.sendStatus(404);
        }

        if (comment.author !== handle && !isAdmin && record.author !== handle) {
            return response.sendStatus(403);
        }

        await persistComments(itemId, comments.filter(c => c.id !== commentId));
        console.info(`Gallery comment deleted: ${commentId} on ${itemId} by ${handle}`);
        return response.json({ total: comments.filter(c => c.id !== commentId && !c.hidden).length });
    } catch (error) {
        console.error('Gallery comment delete failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/comment/like', async (request, response) => {
    try {
        const itemId = String(request.body?.id ?? '');
        const commentId = String(request.body?.commentId ?? '');
        const record = await readRecord(itemId);
        const handle = request.user.profile.handle;
        const isAdmin = request.user.profile.admin === true;

        if (!canView(record, handle, isAdmin)) {
            return response.sendStatus(404);
        }

        const comments = await readComments(itemId);
        const comment = comments.find(c => c.id === commentId);

        if (!comment) {
            return response.sendStatus(404);
        }

        comment.likes = Array.isArray(comment.likes) ? comment.likes : [];

        if (comment.likes.includes(handle)) {
            comment.likes = comment.likes.filter(h => h !== handle);
        } else {
            comment.likes.push(handle);
        }

        await persistComments(itemId, comments);
        return response.json(commentToViewModel(comment, handle, isAdmin));
    } catch (error) {
        console.error('Gallery comment like failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/comment/hide', requireAdminMiddleware, async (request, response) => {
    try {
        const itemId = String(request.body?.id ?? '');
        const commentId = String(request.body?.commentId ?? '');
        const comments = await readComments(itemId);
        const comment = comments.find(c => c.id === commentId);

        if (!comment) {
            return response.sendStatus(404);
        }

        comment.hidden = request.body?.hidden !== false;
        await persistComments(itemId, comments);
        console.info(`Gallery comment ${comment.hidden ? 'hidden' : 'shown'}: ${commentId} on ${itemId}`);
        return response.json(commentToViewModel(comment, request.user.profile.handle, true));
    } catch (error) {
        console.error('Gallery comment hide failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/favorite', async (request, response) => {
    try {
        const record = await readRecord(request.body?.id);

        if (!record || record.deleted) {
            return response.sendStatus(404);
        }

        const handle = request.user.profile.handle;
        const favorites = readFavorites(request.user.directories);
        const favorited = !favorites.includes(record.id);
        const next = favorited ? [...favorites, record.id] : favorites.filter(id => id !== record.id);

        writeFavorites(request.user.directories, next);
        console.debug(`Gallery item ${favorited ? 'favorited' : 'unfavorited'}: ${record.id} by ${handle}`);
        return response.json({ favorited, favorites: next.length });
    } catch (error) {
        console.error('Gallery favorite failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/admin/comments', requireAdminMiddleware, async (request, response) => {
    try {
        const handle = request.user.profile.handle;
        const items = await allRecords();
        const titles = new Map(items.map(item => [item.id, item.title]));
        ensureGalleryDirs();

        const files = await fsPromises.readdir(getCommentsDir()).catch(() => []);
        const comments = [];

        for (const file of files.filter(f => f.endsWith('.json'))) {
            const itemId = file.replace('.json', '');

            for (const comment of await readComments(itemId)) {
                comments.push({
                    ...commentToViewModel(comment, handle, true),
                    itemId,
                    itemTitle: titles.get(itemId) ?? '（已删除的作品）',
                });
            }
        }

        comments.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));

        const hiddenOnly = request.body?.hidden === true;
        return response.json({
            comments: (hiddenOnly ? comments.filter(c => c.hidden) : comments).slice(0, MAX_RECENT_COMMENTS),
            total: comments.length,
            hidden: comments.filter(c => c.hidden).length,
        });
    } catch (error) {
        console.error('Gallery admin comments failed:', error);
        return response.sendStatus(500);
    }
});
