import express from 'express';

import { getUsageConfig, summarizeUserUsage } from '../usage.js';

export const router = express.Router();

/**
 * Returns the usage statistics of the current user.
 */
router.post('/me', (request, response) => {
    try {
        const config = getUsageConfig();

        if (!config.enabled) {
            return response.json({ enabled: false });
        }

        const days = Math.min(Math.max(parseInt(request.body?.days) || 14, 1), 90);

        return response.json({
            enabled: true,
            ...summarizeUserUsage(request.user.directories, days),
        });
    } catch (error) {
        console.error('Usage summary failed:', error);
        return response.sendStatus(500);
    }
});
