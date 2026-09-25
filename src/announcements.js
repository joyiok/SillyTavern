import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { getConfigValue } from './util.js';

const ANNOUNCEMENTS_DIR_NAME = '_announcements';
const SITE_FILE_NAME = 'announcements.json';
const USER_READ_FILE_NAME = 'announcements-read.json';
const MAX_TITLE_LENGTH = 120;
const MAX_BODY_LENGTH = 5000;
const MAX_ANNOUNCEMENTS = 200;

/**
 * Announcement severity levels, used for both styling and filtering.
 */
export const ANNOUNCEMENT_LEVELS = {
    INFO: 'info',
    NOTICE: 'notice',
    IMPORTANT: 'important',
};

const LEVEL_LABELS = {
    [ANNOUNCEMENT_LEVELS.INFO]: '普通',
    [ANNOUNCEMENT_LEVELS.NOTICE]: '通知',
    [ANNOUNCEMENT_LEVELS.IMPORTANT]: '重要',
};

/**
 * Returns the effective announcements configuration.
 * @returns {{ enabled: boolean }} Config
 */
export function getAnnouncementsConfig() {
    return {
        enabled: getConfigValue('announcements.enabled', true),
    };
}

/**
 * Returns the human-readable label of a level.
 * @param {string} level Announcement level
 * @returns {string} Label
 */
export function getLevelLabel(level) {
    return LEVEL_LABELS[level] ?? level;
}

/**
 * Returns the directory that stores site announcements.
 * @returns {string} Path
 */
function getAnnouncementsDir() {
    return path.join(globalThis.DATA_ROOT, ANNOUNCEMENTS_DIR_NAME);
}

/**
 * Returns the path to the site announcements file.
 * @returns {string} Path
 */
function getAnnouncementsPath() {
    return path.join(getAnnouncementsDir(), SITE_FILE_NAME);
}

/**
 * Reads all announcements from disk.
 * @returns {object[]} Announcement records
 */
export function listAnnouncements() {
    try {
        const raw = fs.readFileSync(getAnnouncementsPath(), 'utf8');
        const announcements = JSON.parse(raw);
        return Array.isArray(announcements) ? announcements : [];
    } catch {
        return [];
    }
}

/**
 * Persists the announcements list.
 * @param {object[]} announcements Announcement records
 * @returns {void}
 */
function saveAnnouncements(announcements) {
    fs.mkdirSync(getAnnouncementsDir(), { recursive: true });
    writeFileAtomicSync(getAnnouncementsPath(), JSON.stringify(announcements, null, 2));
}

/**
 * Returns the enabled announcements, pinned ones first, newest first.
 * @returns {object[]} Announcement records
 */
export function listActiveAnnouncements() {
    return listAnnouncements()
        .filter(a => a.enabled !== false)
        .sort((a, b) => (Number(b.pinned === true) - Number(a.pinned === true)) || ((b.created ?? 0) - (a.created ?? 0)));
}

/**
 * Creates or updates an announcement.
 * @param {object} input Announcement input
 * @param {{ handle?: string, name?: string }} [author] Author profile
 * @returns {object} The saved announcement record
 */
export function saveAnnouncement(input, author = {}) {
    const announcements = listAnnouncements();
    const existing = input.id ? announcements.find(a => a.id === input.id) : null;
    const level = Object.values(ANNOUNCEMENT_LEVELS).includes(input.level) ? input.level : ANNOUNCEMENT_LEVELS.INFO;

    const announcement = {
        id: existing?.id ?? crypto.randomBytes(5).toString('hex'),
        title: String(input.title ?? '').trim().slice(0, MAX_TITLE_LENGTH),
        body: String(input.body ?? '').trim().slice(0, MAX_BODY_LENGTH),
        level,
        levelLabel: getLevelLabel(level),
        pinned: input.pinned === true,
        enabled: input.enabled !== false,
        created: existing?.created ?? Date.now(),
        updated: Date.now(),
        author: existing?.author ?? (author.handle ?? ''),
        authorName: existing?.authorName ?? (author.name ?? author.handle ?? ''),
    };

    if (!announcement.title) {
        throw new Error('公告标题不能为空');
    }

    if (existing) {
        announcements[announcements.indexOf(existing)] = announcement;
    } else {
        announcements.unshift(announcement);
    }

    saveAnnouncements(announcements.slice(0, MAX_ANNOUNCEMENTS));
    return announcement;
}

/**
 * Deletes an announcement and drops it from every user's read state.
 * @param {string} id Announcement ID
 * @returns {boolean} True if the announcement existed and was removed
 */
export function deleteAnnouncement(id) {
    const announcements = listAnnouncements();
    const filtered = announcements.filter(a => a.id !== id);

    if (filtered.length === announcements.length) {
        return false;
    }

    saveAnnouncements(filtered);
    return true;
}

/**
 * Returns the path to the read state file of a user.
 * @param {import('./users.js').UserDirectoryList} directories User directories
 * @returns {string} Path
 */
function getReadStatePath(directories) {
    return path.join(directories.root, USER_READ_FILE_NAME);
}

/**
 * Reads the announcement read state of a user.
 * @param {import('./users.js').UserDirectoryList} directories User directories
 * @returns {Record<string, number>} Map of announcement ID to the read timestamp
 */
export function getReadState(directories) {
    try {
        const raw = fs.readFileSync(getReadStatePath(directories), 'utf8');
        const state = JSON.parse(raw);
        return state?.read && typeof state.read === 'object' ? state.read : {};
    } catch {
        return {};
    }
}

/**
 * Marks one or all announcements as read for a user.
 * @param {import('./users.js').UserDirectoryList} directories User directories
 * @param {string|null} id Announcement ID, or null to mark everything as read
 * @returns {Record<string, number>} The updated read state
 */
export function markAnnouncementsRead(directories, id = null) {
    const read = getReadState(directories);
    const now = Date.now();

    if (id) {
        read[String(id).slice(0, 32)] = now;
    } else {
        for (const announcement of listActiveAnnouncements()) {
            read[announcement.id] = now;
        }
    }

    // Drop state of deleted announcements so the file does not grow forever
    const known = new Set(listAnnouncements().map(a => a.id));
    const pruned = Object.fromEntries(Object.entries(read).filter(([key]) => known.has(key)));

    fs.mkdirSync(directories.root, { recursive: true });
    writeFileAtomicSync(getReadStatePath(directories), JSON.stringify({ read: pruned }, null, 2));
    return pruned;
}

/**
 * Converts an announcement record into a view model.
 * @param {object} announcement Announcement record
 * @param {Record<string, number>} [readState] Read state of the requesting user
 * @param {boolean} [isAdmin] Whether the requester is an admin (includes disabled items)
 * @returns {object} View model
 */
export function toViewModel(announcement, readState = {}, isAdmin = false) {
    return {
        id: announcement.id,
        title: announcement.title,
        body: announcement.body,
        level: announcement.level,
        levelLabel: getLevelLabel(announcement.level),
        pinned: announcement.pinned === true,
        enabled: announcement.enabled !== false,
        created: announcement.created ?? 0,
        updated: announcement.updated ?? announcement.created ?? 0,
        author: isAdmin ? (announcement.author ?? '') : undefined,
        authorName: isAdmin ? (announcement.authorName ?? '') : undefined,
        read: !!readState[announcement.id],
        readAt: readState[announcement.id] ?? 0,
    };
}
