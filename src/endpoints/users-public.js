import crypto from 'node:crypto';

import storage from 'node-persist';
import express from 'express';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { getIpAddress, retryAfter } from '../express-common.js';
import { color, Cache, getConfigValue } from '../util.js';
import { KEY_PREFIX, getUserAvatar, toKey, getPasswordHash, getPasswordSalt, getAccountVersion, getAllUserHandles, getUserDirectories, ensurePublicDirectoriesExist } from '../users.js';
import { checkForNewContent, CONTENT_TYPES } from './content-manager.js';
import { getPublicRegistrationConfig, isInviteRequired, validateInvite, consumeInvite } from '../registration.js';

const DISCREET_LOGIN = getConfigValue('enableDiscreetLogin', false, 'boolean');
const PREFER_REAL_IP_HEADER = getConfigValue('rateLimiting.preferRealIpHeader', false, 'boolean');
const LOGIN_POINTS = getConfigValue('rateLimiting.accountsLoginMaxAttempts', 5, 'number');
const RECOVER_POINTS = getConfigValue('rateLimiting.accountsRecoverMaxAttempts', 5, 'number');
const REGISTER_POINTS = getConfigValue('rateLimiting.accountsRegisterMaxAttempts', 5, 'number');
const MFA_CACHE = new Cache(5 * 60 * 1000);

const generateRecoveryCode = () => Array.from({ length: 6 }, () => crypto.randomInt(0, 10)).join('');

export const router = express.Router();
const loginLimiter = new RateLimiterMemory({
    points: LOGIN_POINTS > 0 ? LOGIN_POINTS : Number.MAX_SAFE_INTEGER,
    duration: 60,
});
const recoverLimiter = new RateLimiterMemory({
    points: RECOVER_POINTS > 0 ? RECOVER_POINTS : Number.MAX_SAFE_INTEGER,
    duration: 300,
});
const registerLimiter = new RateLimiterMemory({
    points: REGISTER_POINTS > 0 ? REGISTER_POINTS : Number.MAX_SAFE_INTEGER,
    duration: 3600,
});

const HANDLE_REGEXP = /^[a-z0-9][a-z0-9_-]{2,23}$/;

router.get('/registration-config', (_request, response) => {
    try {
        return response.json(getPublicRegistrationConfig());
    } catch (error) {
        console.error('Registration config failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/register', async (request, response) => {
    try {
        const config = getPublicRegistrationConfig();

        if (!config.enabled) {
            return response.status(403).json({ error: 'Registration is disabled' });
        }

        const ip = getIpAddress(request, PREFER_REAL_IP_HEADER);

        try {
            await registerLimiter.consume(ip);
        } catch {
            return response.status(429).json({ error: 'Too many registration attempts. Please try again later.' });
        }

        const handle = String(request.body?.handle ?? '').trim().toLowerCase();
        const name = String(request.body?.name ?? '').trim();
        const password = String(request.body?.password ?? '');
        const inviteCode = String(request.body?.inviteCode ?? '').trim();

        if (!HANDLE_REGEXP.test(handle)) {
            return response.status(400).json({ error: '用户名需为 3-24 位小写字母、数字、下划线或短横线' });
        }

        if (!name || name.length > 40) {
            return response.status(400).json({ error: '昵称不能为空且不超过 40 字' });
        }

        if (password.length < config.minPasswordLength) {
            return response.status(400).json({ error: `密码至少需要 ${config.minPasswordLength} 位` });
        }

        if (isInviteRequired()) {
            if (!inviteCode) {
                return response.status(403).json({ error: '此站点需要邀请码才能注册' });
            }

            if (!validateInvite(inviteCode)) {
                return response.status(403).json({ error: '邀请码无效或已被使用' });
            }
        }

        const handles = await getAllUserHandles();

        if (handles.includes(handle)) {
            return response.status(409).json({ error: '该用户名已被注册' });
        }

        const salt = getPasswordSalt();
        const enabled = !config.requireApproval;
        const newUser = {
            handle,
            name,
            created: Date.now(),
            password: getPasswordHash(password, salt),
            salt,
            admin: false,
            enabled,
        };

        await storage.setItem(toKey(handle), newUser);
        console.info(`New account registered: ${handle} (approval ${config.requireApproval ? 'required' : 'not required'}) from ${ip}`);

        if (inviteCode) {
            consumeInvite(inviteCode, handle);
        }

        // Create user directories with default content
        await ensurePublicDirectoriesExist();
        const directories = getUserDirectories(handle);
        await checkForNewContent([directories], [CONTENT_TYPES.SETTINGS]);

        return response.json({ handle, pendingApproval: config.requireApproval });
    } catch (error) {
        console.error('Registration failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/list', async (_request, response) => {
    try {
        if (DISCREET_LOGIN) {
            return response.sendStatus(204);
        }

        /** @type {import('../users.js').User[]} */
        const users = await storage.values(x => x.key.startsWith(KEY_PREFIX));

        /** @type {Promise<import('../users.js').UserViewModel>[]} */
        const viewModelPromises = users
            .filter(x => x.enabled)
            .map(user => new Promise(async (resolve) => {
                getUserAvatar(user.handle).then(avatar =>
                    resolve({
                        handle: user.handle,
                        name: user.name,
                        created: user.created,
                        avatar: avatar,
                        password: !!user.password,
                    }),
                );
            }));

        const viewModels = await Promise.all(viewModelPromises);
        viewModels.sort((x, y) => (x.created ?? 0) - (y.created ?? 0));
        return response.json(viewModels);
    } catch (error) {
        console.error('User list failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/login', async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Login failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        const ip = getIpAddress(request, PREFER_REAL_IP_HEADER);
        await loginLimiter.consume(ip);

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(request.body.handle));

        if (!user) {
            console.error('Login failed: User', request.body.handle, 'not found');
            return response.status(403).json({ error: 'Incorrect credentials' });
        }

        if (!user.enabled) {
            console.warn('Login failed: User', user.handle, 'is disabled');
            return response.status(403).json({ error: 'User is disabled' });
        }

        if (user.password && user.password !== getPasswordHash(request.body.password, user.salt)) {
            console.warn('Login failed: Incorrect password for', user.handle);
            return response.status(403).json({ error: 'Incorrect credentials' });
        }

        if (!request.session) {
            console.error('Session not available');
            return response.sendStatus(500);
        }

        await loginLimiter.delete(ip);
        request.session.handle = user.handle;
        request.session.version = getAccountVersion(user);
        console.info('Login successful:', user.handle, 'from', ip, 'at', new Date().toLocaleString());
        return response.json({ handle: user.handle });
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            console.error('Login failed: Rate limited from', getIpAddress(request, PREFER_REAL_IP_HEADER));
            return retryAfter(response, error).status(429).send({ error: 'Too many attempts. Try again later or recover your password.' });
        }

        console.error('Login failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/recover-step1', async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Recover step 1 failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        const ip = getIpAddress(request, PREFER_REAL_IP_HEADER);
        await recoverLimiter.consume(ip);

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(request.body.handle));

        if (!user) {
            console.error('Recover step 1 failed: User', request.body.handle, 'not found');
            return response.status(404).json({ error: 'User not found' });
        }

        if (!user.enabled) {
            console.error('Recover step 1 failed: User', user.handle, 'is disabled');
            return response.status(403).json({ error: 'User is disabled' });
        }

        const mfaCode = generateRecoveryCode();
        console.log();
        console.log(color.blue(`${user.name}, your password recovery code is: `) + color.magenta(mfaCode));
        console.log();
        MFA_CACHE.set(user.handle, mfaCode);
        return response.sendStatus(204);
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            console.error('Recover step 1 failed: Rate limited from', getIpAddress(request, PREFER_REAL_IP_HEADER));
            return retryAfter(response, error).status(429).send({ error: 'Too many attempts. Try again later or contact your admin.' });
        }

        console.error('Recover step 1 failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/recover-step2', async (request, response) => {
    try {
        if (!request.body.handle || !request.body.code) {
            console.warn('Recover step 2 failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(request.body.handle));
        const ip = getIpAddress(request, PREFER_REAL_IP_HEADER);
        const rateLimit = await recoverLimiter.get(ip);

        if (rateLimit !== null && rateLimit.consumedPoints > recoverLimiter.points) {
            throw rateLimit;
        }

        if (!user) {
            console.error('Recover step 2 failed: User', request.body.handle, 'not found');
            return response.status(404).json({ error: 'User not found' });
        }

        if (!user.enabled) {
            console.warn('Recover step 2 failed: User', user.handle, 'is disabled');
            return response.status(403).json({ error: 'User is disabled' });
        }

        const mfaCode = MFA_CACHE.get(user.handle);

        if (request.body.code !== mfaCode) {
            await recoverLimiter.consume(ip);
            console.warn('Recover step 2 failed: Incorrect code');
            return response.status(403).json({ error: 'Incorrect code' });
        }

        if (request.body.newPassword) {
            const salt = getPasswordSalt();
            user.password = getPasswordHash(request.body.newPassword, salt);
            user.salt = salt;
            await storage.setItem(toKey(user.handle), user);
        } else {
            user.password = '';
            user.salt = '';
            await storage.setItem(toKey(user.handle), user);
        }

        if (request.session && request.session.handle === user.handle) {
            request.session.version = getAccountVersion(user);
        }

        await recoverLimiter.delete(ip);
        MFA_CACHE.remove(user.handle);
        return response.sendStatus(204);
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            console.error('Recover step 2 failed: Rate limited from', getIpAddress(request, PREFER_REAL_IP_HEADER));
            return retryAfter(response, error).status(429).send({ error: 'Too many attempts. Try again later or contact your admin.' });
        }

        console.error('Recover step 2 failed:', error);
        return response.sendStatus(500);
    }
});
