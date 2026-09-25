import express from 'express';
import storage from 'node-persist';

import { requireAdminMiddleware, getAllUserHandles, toKey, getUserDirectories } from '../users.js';
import { getUserUsage, getQuotaConfig } from '../quotas.js';
import { getRegistrationConfig, isInviteRequired, listInvites, createInvite, deleteInvite } from '../registration.js';
import { listChannels, saveChannel, deleteChannel, toViewModel, getUserSelection } from '../managed-channels.js';
import { allRecords as allGalleryRecords } from './gallery.js';

export const router = express.Router();

router.use(requireAdminMiddleware);

/**
 * Lists all users with their status and resource usage.
 */
router.post('/users', async (_request, response) => {
    try {
        const handles = await getAllUserHandles();
        const galleryItems = await allGalleryRecords();
        const quotas = getQuotaConfig();

        const users = await Promise.all(handles.map(async (handle) => {
            const user = await storage.getItem(toKey(handle));

            if (!user) {
                return null;
            }

            const publishedItems = galleryItems.filter(item => item.author === handle && !item.deleted).length;
            const usage = getUserUsage(getUserDirectories(handle), publishedItems);

            return {
                handle: user.handle,
                name: user.name,
                admin: user.admin === true,
                enabled: user.enabled !== false,
                hasPassword: !!user.password,
                created: user.created ?? 0,
                storageBytes: usage.storageBytes,
                characters: usage.characters,
                galleryItems: usage.galleryItems,
            };
        }));

        return response.json({ users: users.filter(Boolean), quotas });
    } catch (error) {
        console.error('Admin user list failed:', error);
        return response.sendStatus(500);
    }
});

/**
 * Returns the effective registration configuration.
 */
router.post('/registration', (_request, response) => {
    try {
        return response.json({
            ...getRegistrationConfig(),
            inviteRequired: isInviteRequired(),
            invites: listInvites(),
        });
    } catch (error) {
        console.error('Admin registration info failed:', error);
        return response.sendStatus(500);
    }
});

/**
 * Creates a new invite code.
 */
router.post('/invites/create', (request, response) => {
    try {
        const invite = createInvite({
            note: request.body?.note,
            singleUse: request.body?.singleUse !== false,
        });

        console.info(`Invite code created by ${request.user.profile.handle}: ${invite.code}`);
        return response.json(invite);
    } catch (error) {
        console.error('Admin invite create failed:', error);
        return response.sendStatus(500);
    }
});

/**
 * Deletes an invite code.
 */
router.post('/invites/delete', (request, response) => {
    try {
        const code = String(request.body?.code ?? '');

        if (!deleteInvite(code)) {
            return response.sendStatus(404);
        }

        return response.sendStatus(204);
    } catch (error) {
        console.error('Admin invite delete failed:', error);
        return response.sendStatus(500);
    }
});

/**
 * Lists managed model channels (API keys masked).
 */
router.post('/channels/list', async (_request, response) => {
    try {
        const channels = listChannels().map(c => toViewModel(c, false));

        // Include per-user selection counts for visibility
        const handles = await getAllUserHandles();
        const usage = new Map();

        for (const handle of handles) {
            const selection = getUserSelection(getUserDirectories(handle));

            if (selection.channelId) {
                usage.set(selection.channelId, (usage.get(selection.channelId) ?? 0) + 1);
            }
        }

        return response.json({ channels: channels.map(c => ({ ...c, selectedBy: usage.get(c.id) ?? 0 })) });
    } catch (error) {
        console.error('Admin channel list failed:', error);
        return response.sendStatus(500);
    }
});

/**
 * Creates or updates a managed model channel.
 */
router.post('/channels/save', (request, response) => {
    try {
        const channel = saveChannel(request.body ?? {});
        console.info(`Managed channel saved by ${request.user.profile.handle}: ${channel.name} (${channel.id})`);
        return response.json(toViewModel(channel, false));
    } catch (error) {
        console.error('Admin channel save failed:', error);
        return response.sendStatus(500);
    }
});

/**
 * Deletes a managed model channel.
 */
router.post('/channels/delete', (request, response) => {
    try {
        if (!deleteChannel(String(request.body?.id ?? ''))) {
            return response.sendStatus(404);
        }

        return response.sendStatus(204);
    } catch (error) {
        console.error('Admin channel delete failed:', error);
        return response.sendStatus(500);
    }
});
