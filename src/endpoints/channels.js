import express from 'express';

import {
    listEnabledChannels,
    getUserSelection,
    setUserSelection,
    getManagedChannelConfig,
} from '../managed-channels.js';

export const router = express.Router();

/**
 * Lists the managed channels available to the current user (no API keys).
 */
router.post('/list', (request, response) => {
    try {
        const config = getManagedChannelConfig();
        const channels = config.enabled ? listEnabledChannels() : [];
        const selection = config.enabled ? getUserSelection(request.user.directories) : { channelId: null, model: null };

        return response.json({ channels, selection, restricted: config.enabled && config.restrictNonAdmins });
    } catch (error) {
        console.error('Channel list failed:', error);
        return response.sendStatus(500);
    }
});

/**
 * Sets the managed channel selection of the current user.
 */
router.post('/select', (request, response) => {
    try {
        const config = getManagedChannelConfig();

        if (!config.enabled) {
            return response.status(403).json({ error: 'Managed channels are disabled' });
        }

        const channelId = request.body?.channelId ?? null;
        const model = request.body?.model ? String(request.body.model).slice(0, 100) : null;

        if (channelId) {
            const channels = listEnabledChannels();

            if (!channels.some(c => c.id === channelId)) {
                return response.status(400).json({ error: '该模型渠道不存在或已停用' });
            }

            const channel = channels.find(c => c.id === channelId);

            if (channel.models.length > 0 && model && !channel.models.includes(model)) {
                return response.status(400).json({ error: `模型 ${model} 不在该渠道的可用列表中` });
            }
        }

        setUserSelection(request.user.directories, { channelId, model });
        return response.json({ channelId, model });
    } catch (error) {
        console.error('Channel select failed:', error);
        return response.sendStatus(500);
    }
});
