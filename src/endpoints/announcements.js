import express from 'express';
import { RateLimiterMemory } from 'rate-limiter-flexible';

import { requireAdminMiddleware } from '../users.js';
import {
    getAnnouncementsConfig,
    listAnnouncements,
    listActiveAnnouncements,
    saveAnnouncement,
    deleteAnnouncement,
    getReadState,
    markAnnouncementsRead,
    toViewModel,
} from '../announcements.js';

const saveLimiter = new RateLimiterMemory({
    points: 60,
    duration: 3600,
});

export const router = express.Router();

// The entire feature can be disabled via config
router.use((request, response, next) => {
    if (!getAnnouncementsConfig().enabled) {
        return response.sendStatus(404);
    }

    return next();
});

/**
 * Lists the announcements visible to the current user, with their read state.
 */
router.post('/list', (request, response) => {
    try {
        const readState = getReadState(request.user.directories);
        const announcements = listActiveAnnouncements().map(a => toViewModel(a, readState));

        return response.json({
            announcements,
            unread: announcements.filter(a => !a.read).length,
            latest: announcements[0]?.updated ?? 0,
        });
    } catch (error) {
        console.error('Announcement list failed:', error);
        return response.sendStatus(500);
    }
});

/**
 * Marks one announcement (or all of them) as read for the current user.
 */
router.post('/read', (request, response) => {
    try {
        const id = request.body?.id ? String(request.body.id) : null;
        const readState = markAnnouncementsRead(request.user.directories, id);

        return response.json({
            read: readState,
            unread: listActiveAnnouncements().filter(a => !readState[a.id]).length,
        });
    } catch (error) {
        console.error('Announcement read failed:', error);
        return response.sendStatus(500);
    }
});

/**
 * Lists every announcement, including disabled ones (admin only).
 */
router.post('/admin/list', requireAdminMiddleware, (_request, response) => {
    try {
        const announcements = listAnnouncements()
            .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
            .map(a => toViewModel(a, {}, true));

        return response.json({ announcements });
    } catch (error) {
        console.error('Announcement admin list failed:', error);
        return response.sendStatus(500);
    }
});

/**
 * Creates or updates an announcement (admin only).
 */
router.post('/admin/save', requireAdminMiddleware, async (request, response) => {
    try {
        try {
            await saveLimiter.consume(request.user.profile.handle);
        } catch {
            return response.status(429).json({ error: '操作过于频繁，请稍后再试' });
        }

        const announcement = saveAnnouncement(request.body ?? {}, request.user.profile);
        console.info(`Announcement saved by ${request.user.profile.handle}: ${announcement.title} (${announcement.id})`);
        return response.json(toViewModel(announcement, {}, true));
    } catch (error) {
        console.error('Announcement save failed:', error);
        return response.status(400).json({ error: error.message || 'Save failed' });
    }
});

/**
 * Deletes an announcement (admin only).
 */
router.post('/admin/delete', requireAdminMiddleware, (request, response) => {
    try {
        if (!deleteAnnouncement(String(request.body?.id ?? ''))) {
            return response.sendStatus(404);
        }

        console.info(`Announcement deleted by ${request.user.profile.handle}`);
        return response.sendStatus(204);
    } catch (error) {
        console.error('Announcement delete failed:', error);
        return response.sendStatus(500);
    }
});
