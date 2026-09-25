import path from 'node:path';
import fs from 'node:fs';

import { getConfigValue } from './util.js';

/**
 * @typedef {object} QuotaConfig
 * @property {boolean} enabled Whether quota enforcement is enabled
 * @property {number} maxStorageMB Maximum on-disk usage in MB (-1 = unlimited)
 * @property {number} maxCharacters Maximum number of character cards (-1 = unlimited)
 * @property {number} maxGalleryItems Maximum number of published gallery items (-1 = unlimited)
 */

/**
 * Reads the effective quota configuration.
 * @returns {QuotaConfig} Quota configuration
 */
export function getQuotaConfig() {
    return {
        enabled: getConfigValue('quotas.enabled', true),
        maxStorageMB: getConfigValue('quotas.maxStorageMB', 1024),
        maxCharacters: getConfigValue('quotas.maxCharacters', 200),
        maxGalleryItems: getConfigValue('quotas.maxGalleryItems', 50),
    };
}

/**
 * Recursively calculates the size of a directory.
 * @param {string} dir Directory path
 * @returns {number} Size in bytes
 */
export function getDirectorySize(dir) {
    let total = 0;

    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
            const entryPath = path.join(dir, entry.name);

            try {
                if (entry.isDirectory()) {
                    total += getDirectorySize(entryPath);
                } else if (entry.isFile()) {
                    total += fs.statSync(entryPath).size;
                }
            } catch {
                // File may have been removed while scanning
            }
        }
    } catch {
        // Directory does not exist or is not readable
    }

    return total;
}

/**
 * Counts the character cards of a user.
 * @param {import('./users.js').UserDirectoryList} directories User directories
 * @returns {number} Number of character cards
 */
export function countCharacters(directories) {
    try {
        return fs.readdirSync(directories.characters).filter(f => f.endsWith('.png')).length;
    } catch {
        return 0;
    }
}

/**
 * Checks the character count quota for a user.
 * @param {import('./users.js').UserDirectoryList} directories User directories
 * @returns {string|null} An error message, or null when the operation is allowed
 */
export function checkCharacterQuota(directories) {
    const config = getQuotaConfig();

    if (!config.enabled || config.maxCharacters < 0) {
        return null;
    }

    const count = countCharacters(directories);

    if (count >= config.maxCharacters) {
        return `角色数量已达上限（${config.maxCharacters}），请先删除不用的角色卡`;
    }

    return null;
}

/**
 * Checks the storage quota for a user.
 * @param {import('./users.js').UserDirectoryList} directories User directories
 * @param {number} [additionalBytes=0] Bytes about to be written
 * @returns {string|null} An error message, or null when the operation is allowed
 */
export function checkStorageQuota(directories, additionalBytes = 0) {
    const config = getQuotaConfig();

    if (!config.enabled || config.maxStorageMB < 0) {
        return null;
    }

    const limit = config.maxStorageMB * 1024 * 1024;
    const used = getDirectorySize(directories.root);

    if (used + additionalBytes > limit) {
        return `存储空间已达上限（${config.maxStorageMB} MB），请先清理聊天记录或备份数据`;
    }

    return null;
}

/**
 * Checks the gallery publication quota for a user.
 * @param {number} itemCount Current number of published items of the user
 * @returns {string|null} An error message, or null when the operation is allowed
 */
export function checkGalleryQuota(itemCount) {
    const config = getQuotaConfig();

    if (!config.enabled || config.maxGalleryItems < 0) {
        return null;
    }

    if (itemCount >= config.maxGalleryItems) {
        return `发布作品数已达上限（${config.maxGalleryItems}），请先下架部分作品`;
    }

    return null;
}

/**
 * Collects usage statistics and quota state for a user.
 * @param {import('./users.js').UserDirectoryList} directories User directories
 * @param {number} [galleryItems=0] Number of published gallery items
 * @returns {{ storageBytes: number, characters: number, galleryItems: number, quotas: QuotaConfig }} Usage info
 */
export function getUserUsage(directories, galleryItems = 0) {
    return {
        storageBytes: getDirectorySize(directories.root),
        characters: countCharacters(directories),
        galleryItems,
        quotas: getQuotaConfig(),
    };
}
