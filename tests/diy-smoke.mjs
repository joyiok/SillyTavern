#!/usr/bin/env node
/**
 * DIY fork 冒烟测试（多租户改造）。
 *
 * 覆盖：注册/邀请码/审批、站点公告、作品广场（发布/领取/点赞/收藏/评论/举报/审核）、
 *       托管模型渠道（强制接管/白名单/定价）、用量统计（token/成本/全站汇总）、权限边界。
 *
 * 用法：
 *   npm start                     # 先启动服务器（默认 http://127.0.0.1:8000）
 *   node tests/diy-smoke.mjs      # 再跑本脚本
 *
 * 环境变量：
 *   ST_BASE_URL       默认 http://127.0.0.1:8000
 *   ST_ADMIN_HANDLE   默认 default-user
 *   ST_ADMIN_PASSWORD 默认空（初装的 default-user 没有密码）
 *
 * 脚本自带一个 mock LLM（随机端口）并在结束时清理所有测试数据，
 * 因此可以在任意环境重复运行。注意：不要在生产站点上跑。
 */
import http from 'node:http';

const BASE = process.env.ST_BASE_URL ?? 'http://127.0.0.1:8000';
const ADMIN_HANDLE = process.env.ST_ADMIN_HANDLE ?? 'default-user';
const ADMIN_PASSWORD = process.env.ST_ADMIN_PASSWORD ?? '';

const MODEL = 'qa-gpt-test';
const PRICE_INPUT = 2;
const PRICE_OUTPUT = 6;
const FLUSH_WAIT_MS = 11_000;
const suffix = Date.now().toString().slice(-6);
const QA_A = `qaa${suffix}`;
const QA_B = `qab${suffix}`;
const QA_PASSWORD = `qa-pass-${suffix}`;

const results = [];

/**
 * Records an assertion.
 * @param {string} name Test name
 * @param {boolean} ok Whether it passed
 * @param {any} [detail] Extra detail printed on failure
 * @returns {void}
 */
function check(name, ok, detail) {
    results.push({ name, ok });
    console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` → ${JSON.stringify(detail)?.slice(0, 300)}`}`);
}

/**
 * Prints a section header.
 * @param {string} name Section name
 * @returns {void}
 */
function section(name) {
    console.log(`\n--- ${name}`);
}

/**
 * Starts a mock OpenAI-compatible endpoint that reports token usage.
 * @returns {Promise<{ url: string, requests: number, close: Function }>} Mock server handle
 */
function startMockLlm() {
    return new Promise((resolve) => {
        const state = { requests: 0 };

        const server = http.createServer((request, response) => {
            let body = '';
            request.on('data', chunk => body += chunk);
            request.on('end', () => {
                state.requests++;
                const payload = (() => {
                    try {
                        return JSON.parse(body);
                    } catch {
                        return {};
                    }
                })();

                if (payload.stream) {
                    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    response.write(`data: ${JSON.stringify({ id: 'qa', object: 'chat.completion.chunk', model: payload.model, choices: [{ index: 0, delta: { content: '你好' } }] })}\n\n`);
                    response.write(`data: ${JSON.stringify({ id: 'qa', object: 'chat.completion.chunk', model: payload.model, choices: [], usage: { prompt_tokens: 120, completion_tokens: 34, total_tokens: 154 } })}\n\n`);
                    response.write('data: [DONE]\n\n');
                    response.end();
                    return;
                }

                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({
                    id: 'qa',
                    object: 'chat.completion',
                    model: payload.model,
                    choices: [{ index: 0, message: { role: 'assistant', content: '你好，我是冒烟测试回复' }, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 210, completion_tokens: 58, total_tokens: 268 },
                }));
            });
        });

        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                url: `http://127.0.0.1:${port}/v1`,
                get requests() {
                    return state.requests;
                },
                close: () => server.close(),
            });
        });
    });
}

/**
 * Creates an authenticated API client (handles the CSRF handshake).
 * @param {string} handle User handle
 * @param {string} password Password
 * @returns {Promise<object>} Client with a `post` helper
 */
async function client(handle, password) {
    let cookie = '';

    /**
     * Fetches a CSRF token, keeping the session cookie.
     * @returns {Promise<string>} CSRF token
     */
    async function token() {
        const response = await fetch(`${BASE}/csrf-token`, { headers: cookie ? { cookie } : {} });
        const setCookie = response.headers.getSetCookie?.() ?? [];

        if (setCookie.length) {
            cookie = setCookie.map(c => c.split(';')[0]).join('; ');
        }

        return (await response.json()).token;
    }

    const loginResponse = await fetch(`${BASE}/api/users/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await token(), cookie },
        body: JSON.stringify({ handle, password }),
    });
    const setCookie = loginResponse.headers.getSetCookie?.() ?? [];

    if (setCookie.length) {
        cookie = setCookie.map(c => c.split(';')[0]).join('; ');
    }

    if (!loginResponse.ok) {
        throw new Error(`登录失败 ${handle}: ${loginResponse.status} ${await loginResponse.text()}`);
    }

    const csrf = await token();

    /**
     * Sends an authenticated JSON request.
     * @param {string} path API path
     * @param {object} [body] Request body
     * @returns {Promise<{status: number, data: any, text: string}>} Response
     */
    async function post(path, body = {}) {
        const response = await fetch(`${BASE}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, cookie },
            body: JSON.stringify(body),
        });
        const text = await response.text();

        let data;
        try {
            data = JSON.parse(text);
        } catch {
            data = text.trim();
        }

        return { status: response.status, data, text };
    }

    return { handle, post };
}

/**
 * Registers a new account and returns its client once approved.
 * @param {object} admin Admin client
 * @param {string} handle Desired handle
 * @param {string} name Display name
 * @param {boolean} approve Whether the admin should approve the account
 * @returns {Promise<object>} Registration result
 */
async function registerUser(admin, handle, name, approve) {
    const invite = await admin.post('/api/admin/invites/create', { note: 'QA smoke', singleUse: true });

    // The registration endpoint is public but still CSRF-protected
    const anon = await fetch(`${BASE}/csrf-token`);
    const anonCookie = (anon.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ');
    const anonCsrf = (await anon.json()).token;

    const response = await fetch(`${BASE}/api/users/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': anonCsrf, cookie: anonCookie },
        body: JSON.stringify({ handle, name, password: QA_PASSWORD, inviteCode: invite.data?.code }),
    });
    const body = await response.json().catch(() => null);

    if (!response.ok) {
        return { registered: false, status: response.status, body, anonCsrf, anonCookie, inviteCode: invite.data?.code };
    }

    if (!approve) {
        return { registered: true, pendingApproval: body.pendingApproval === true, anonCsrf, anonCookie, inviteCode: invite.data?.code };
    }

    await admin.post('/api/users/enable', { handle });
    return { registered: true, pendingApproval: body.pendingApproval === true, client: await client(handle, QA_PASSWORD), inviteCode: invite.data?.code };
}

const mock = await startMockLlm();
console.log(`目标服务器：${BASE}\nmock LLM：${mock.url}`);

/** Handles/IDs created by this run, cleaned up at the end. */
const cleanup = { users: [], announcements: [], galleryItems: [], invites: [], channel: null };

try {
    const admin = await client(ADMIN_HANDLE, ADMIN_PASSWORD);
    console.log(`管理员：${ADMIN_HANDLE}`);

    // ============ 站点公告 ============
    section('站点公告');
    const existingAnnouncements = await admin.post('/api/announcements/admin/list');

    for (const item of existingAnnouncements.data?.announcements ?? []) {
        await admin.post('/api/announcements/admin/delete', { id: item.id });
    }

    const announcement = await admin.post('/api/announcements/admin/save', {
        title: '欢迎来到本站', body: '这是一条冒烟测试公告。\n第二行内容。', level: 'important', pinned: true,
    });
    check('管理员发布公告', announcement.status === 200 && !!announcement.data?.id, announcement.data);
    cleanup.announcements.push(announcement.data?.id);

    const second = await admin.post('/api/announcements/admin/save', { title: '维护通知', body: '今晚停机', level: 'notice' });
    check('发布第二条公告', second.status === 200, second.data);
    cleanup.announcements.push(second.data?.id);

    const invalidAnnouncement = await admin.post('/api/announcements/admin/save', { title: '   ' });
    check('空标题被拒绝 (400)', invalidAnnouncement.status === 400, invalidAnnouncement.status);

    const updatedAnnouncement = await admin.post('/api/announcements/admin/save', {
        id: second.data.id, title: '维护通知（改期）', body: '改为明晚', level: 'notice', enabled: true,
    });
    check('公告可更新', updatedAnnouncement.data?.title === '维护通知（改期）', updatedAnnouncement.data?.title);

    // ============ 托管渠道（带定价） ============
    section('托管模型渠道');
    const channel = await admin.post('/api/admin/channels/save', {
        name: `QA 渠道 ${suffix}`, type: 'openai-compatible', url: mock.url, key: 'sk-qa-secret',
        models: [MODEL], priceInput: PRICE_INPUT, priceOutput: PRICE_OUTPUT, enabled: true,
    });
    check('创建带定价的渠道', channel.status === 200 && channel.data?.priceInput === PRICE_INPUT, channel.data);
    check('渠道 Key 不外泄', channel.data?.key === undefined && channel.data?.keyHint === 'sk-…ret', channel.data);
    cleanup.channel = channel.data?.id;

    // ============ 注册与审批 ============
    section('注册与审批');
    const pending = await registerUser(admin, QA_A, 'QA 甲', false);
    check('开放注册成功且需审批', pending.registered && pending.pendingApproval === true, pending.body);
    cleanup.users.push(QA_A);
    cleanup.invites.push(pending.inviteCode);

    const loginBeforeApproval = await fetch(`${BASE}/api/users/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': pending.anonCsrf, cookie: pending.anonCookie },
        body: JSON.stringify({ handle: QA_A, password: QA_PASSWORD }),
    });
    check('审批通过前无法登录 (403)', loginBeforeApproval.status === 403, loginBeforeApproval.status);

    await admin.post('/api/users/enable', { handle: QA_A });
    const userA = await client(QA_A, QA_PASSWORD);
    check('审批通过后可登录', !!userA);

    const registeredB = await registerUser(admin, QA_B, 'QA 乙', true);
    const userB = registeredB.client;
    cleanup.users.push(QA_B);
    cleanup.invites.push(registeredB.inviteCode);
    check('第二个用户注册并自动通过', !!userB);

    const duplicateInvite = await admin.post('/api/admin/invites/create', { note: 'QA smoke', singleUse: true });
    cleanup.invites.push(duplicateInvite.data?.code);
    const duplicate = await fetch(`${BASE}/api/users/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': pending.anonCsrf, cookie: pending.anonCookie },
        body: JSON.stringify({ handle: QA_A, name: 'dup', password: QA_PASSWORD, inviteCode: duplicateInvite.data?.code }),
    });
    check('重名注册被拒 (409)', duplicate.status === 409, duplicate.status);

    // ============ 公告（用户侧） ============
    section('公告（用户侧）');
    const userList = await userA.post('/api/announcements/list');
    check('用户看到 2 条公告且均未读', userList.data?.announcements?.length === 2 && userList.data?.unread === 2, userList.data);
    check('用户侧不含作者信息', userList.data?.announcements?.every(a => a.author === undefined));
    check('置顶公告排在前面', userList.data?.announcements?.[0]?.pinned === true);

    const readOne = await userA.post('/api/announcements/read', { id: announcement.data.id });
    check('标记单条已读 → 未读 1', readOne.data?.unread === 1, readOne.data);
    const readAll = await userA.post('/api/announcements/read', {});
    check('全部标记已读 → 未读 0', readAll.data?.unread === 0, readAll.data);
    const otherUserUnread = await userB.post('/api/announcements/list');
    check('已读状态按用户隔离', otherUserUnread.data?.unread === 2, otherUserUnread.data?.unread);
    check('普通用户访问公告管理 403', (await userA.post('/api/announcements/admin/list')).status === 403);

    // ============ 广场：发布 / 领取 / 互动 ============
    section('作品广场');
    const created = await userA.post('/api/characters/create', {
        ch_name: `QA 角色 ${suffix}`, description: '用于冒烟测试的角色卡', first_mes: '你好呀', creator: 'QA', tags: 'qa,测试',
    });
    check('创建角色卡', created.status === 200 && String(created.data).endsWith('.png'), created.data);
    const avatarUrl = String(created.data);

    const published = await userA.post('/api/gallery/publish', {
        avatar_url: avatarUrl, title: `QA 作品 ${suffix}`, description: '冒烟测试作品', tags: ['QA测试'], visibility: 'public', note: '初版',
    });
    check('发布到广场', published.status === 200 && !!published.data?.id, published.data);
    const itemId = published.data?.id;
    cleanup.galleryItems.push(itemId);

    const listed = await userB.post('/api/gallery/list', { q: `QA 作品 ${suffix}` });
    check('其他用户能搜索到作品', listed.data?.items?.some(i => i.id === itemId), listed.data?.total);

    const claimed = await userB.post('/api/gallery/claim', { id: itemId });
    check('一键领取（复制角色卡）', claimed.status === 200 && claimed.data?.file_name && claimed.data?.downloads === 1, claimed.data);

    const liked = await userB.post('/api/gallery/like', { id: itemId });
    check('点赞 / 取消点赞', liked.data?.likes === 1 && liked.data?.liked === true, liked.data);
    const unliked = await userB.post('/api/gallery/like', { id: itemId });
    check('再次点赞为取消', unliked.data?.likes === 0 && unliked.data?.liked === false, unliked.data);

    const favorited = await userB.post('/api/gallery/favorite', { id: itemId });
    check('收藏作品', favorited.data?.favorited === true, favorited.data);
    const favoriteList = await userB.post('/api/gallery/list', { favorites: true });
    check('我的收藏筛选命中', favoriteList.data?.items?.some(i => i.id === itemId && i.favorited), favoriteList.data?.total);
    const unfavorited = await userB.post('/api/gallery/favorite', { id: itemId });
    check('取消收藏', unfavorited.data?.favorited === false, unfavorited.data);

    const reported = await userB.post('/api/gallery/report', { id: itemId, reason: '冒烟测试举报' });
    check('举报作品', reported.status === 204, reported.status);
    check('重复举报被拒 (409)', (await userB.post('/api/gallery/report', { id: itemId, reason: 'again' })).status === 409);

    // ============ 评论 ============
    section('作品评论');
    const comment = await userB.post('/api/gallery/comment', { id: itemId, text: '这个角色写得真好，领取了！' });
    check('发表评论', comment.status === 200 && !!comment.data?.comment?.id, comment.data);
    const commentId = comment.data?.comment?.id;

    check('空评论被拒 (400)', (await userB.post('/api/gallery/comment', { id: itemId, text: '   ' })).status === 400);
    check('60 秒内重复内容被拒 (409)', (await userB.post('/api/gallery/comment', { id: itemId, text: '这个角色写得真好，领取了！' })).status === 409);
    const tooLong = await userB.post('/api/gallery/comment', { id: itemId, text: 'x'.repeat(1001) });
    check('超长评论被截断到 1000 字', tooLong.data?.comment?.text?.length === 1000, tooLong.data?.comment?.text?.length);
    const tooLongId = tooLong.data?.comment?.id;

    const commentList = await userA.post('/api/gallery/comments', { id: itemId });
    check('作者能看到他人评论', commentList.data?.comments?.length === 2 && commentList.data?.total === 2, commentList.data?.total);

    const likedComment = await userA.post('/api/gallery/comment/like', { id: itemId, commentId });
    check('评论点赞', likedComment.data?.likes === 1 && likedComment.data?.liked === true, likedComment.data);

    const hiddenComment = await admin.post('/api/gallery/comment/hide', { id: itemId, commentId: tooLongId, hidden: true });
    check('管理员隐藏评论', hiddenComment.data?.hidden === true, hiddenComment.data);
    const afterHide = await userA.post('/api/gallery/comments', { id: itemId });
    check('隐藏后其他人看不到（计数同步）', afterHide.data?.total === 1 && afterHide.data?.comments?.length === 1, afterHide.data);
    const ownerSeesHidden = await userB.post('/api/gallery/comments', { id: itemId });
    check('评论作者仍可见自己被隐藏的评论', ownerSeesHidden.data?.comments?.some(c => c.id === tooLongId && c.hidden), ownerSeesHidden.data?.comments?.length);

    const adminComments = await admin.post('/api/gallery/admin/comments');
    check('管理员全站评论列表', adminComments.status === 200 && adminComments.data?.comments?.some(c => c.itemId === itemId && c.hidden === true), adminComments.data?.total);
    check('普通用户不可访问全站评论 (403)', (await userA.post('/api/gallery/admin/comments')).status === 403);

    const deletedComment = await userB.post('/api/gallery/comment/delete', { id: itemId, commentId });
    check('评论作者删除自己的评论', deletedComment.status === 200 && deletedComment.data?.total === 0, deletedComment.data);
    const deletedByItemOwner = await userA.post('/api/gallery/comment/delete', { id: itemId, commentId: tooLongId });
    check('作品作者可管理自己作品下的评论', deletedByItemOwner.status === 200, deletedByItemOwner.status);

    const itemAfterComments = await userA.post('/api/gallery/item', { id: itemId });
    check('作品评论数已同步为 0', itemAfterComments.data?.comments === 0, itemAfterComments.data?.comments);
    check('删除后评论列表为空', (await userB.post('/api/gallery/comments', { id: itemId })).data?.comments?.length === 0);

    // ============ 渠道选择 + 用量统计 ============
    section('托管渠道接管与用量统计');
    const channelList = await userA.post('/api/channels/list');
    check('用户可见渠道列表（无 Key）', channelList.data?.channels?.some(c => c.id === cleanup.channel) && channelList.data?.channels?.every(c => c.key === undefined), channelList.data?.restricted);
    const selected = await userA.post('/api/channels/select', { channelId: cleanup.channel, model: MODEL });
    check('选择渠道与模型', selected.status === 200 && selected.data?.model === MODEL, selected.data);
    check('选择白名单外模型被拒 (400)', (await userA.post('/api/channels/select', { channelId: cleanup.channel, model: 'gpt-evil' })).status === 400);
    await userB.post('/api/channels/select', { channelId: cleanup.channel, model: MODEL });

    check('普通用户写 secrets 被拒 (403)', (await userA.post('/api/secrets/write', { key: 'api_key_custom', value: 'sk-user' })).status === 403);

    const hijacked = await userA.post('/api/backends/chat-completions/generate', {
        chat_completion_source: 'openai',
        reverse_proxy: 'https://evil.example.com',
        proxy_password: 'sk-user-key',
        model: MODEL,
        messages: [{ role: 'user', content: '你好' }],
    });
    check('用户自带接口被强制改写到托管渠道', hijacked.status === 200 && mock.requests === 1, `${hijacked.status} mockRequests=${mock.requests}`);

    const streamed = await userA.post('/api/backends/chat-completions/generate', {
        chat_completion_source: 'custom', model: MODEL, stream: true, messages: [{ role: 'user', content: '你好' }],
    });
    check('流式生成成功', streamed.status === 200, streamed.status);

    const blockedModel = await userA.post('/api/backends/chat-completions/generate', {
        chat_completion_source: 'custom', model: 'gpt-not-allowed', messages: [{ role: 'user', content: 'hi' }],
    });
    check('白名单外模型 403', blockedModel.status === 403, blockedModel.status);

    await userB.post('/api/backends/chat-completions/generate', {
        chat_completion_source: 'custom', model: MODEL, messages: [{ role: 'user', content: '你好' }],
    });

    // 非生成类接口不应计入用量
    await userA.post('/api/backends/chat-completions/status', {});

    console.log(`等待用量落盘（${FLUSH_WAIT_MS / 1000}s）…`);
    await new Promise(resolve => setTimeout(resolve, FLUSH_WAIT_MS));

    const usageA = await userA.post('/api/usage/me');
    const expectedCost = (330 / 1e6) * PRICE_INPUT + (92 / 1e6) * PRICE_OUTPUT;
    check('用量：记录 3 次请求（2 成功 + 1 白名单拦截）', usageA.data?.totals?.requests === 3 && usageA.data?.totals?.errors === 1, usageA.data?.totals);
    check('用量：解析非流式 + 流式 token (330/92)', usageA.data?.totals?.promptTokens === 330 && usageA.data?.totals?.completionTokens === 92, usageA.data?.totals);
    check('用量：按渠道定价估算成本', Math.abs((usageA.data?.totals?.cost ?? 0) - expectedCost) < 1e-9, usageA.data?.totals);
    check('用量：按模型分组并记录渠道名', usageA.data?.models?.some(m => m.model === MODEL && m.channel === `QA 渠道 ${suffix}` && m.requests === 2), usageA.data?.models);
    check('用量：14 天日序列', usageA.data?.series?.length === 14 && usageA.data?.series?.at(-1)?.totalTokens === 422, usageA.data?.series?.length);
    check('用量：辅助接口（status）不计入', usageA.data?.models?.every(m => m.model !== '未知模型'), usageA.data?.models);

    const usageB = await userB.post('/api/usage/me');
    check('用量：按用户隔离', usageB.data?.totals?.requests === 1 && usageB.data?.totals?.totalTokens === 268, usageB.data?.totals);

    check('用量：普通用户不可访问全站统计 (403)', (await userA.post('/api/admin/usage')).status === 403);

    const siteUsage = await admin.post('/api/admin/usage');
    check('用量：全站汇总（2 名活跃用户）', siteUsage.data?.activeUsers === 2 && siteUsage.data?.totals?.requests === 4, { activeUsers: siteUsage.data?.activeUsers, totals: siteUsage.data?.totals });
    check('用量：全站按模型汇总', siteUsage.data?.models?.some(m => m.model === MODEL && m.users === 2 && m.totalTokens === 690), siteUsage.data?.models);

    const adminUsers = await admin.post('/api/admin/users');
    const rowA = adminUsers.data?.users?.find(u => u.handle === QA_A);
    check('用量：管理页用户列表含 token/成本/活跃时间', rowA?.requests === 3 && rowA?.totalTokens === 422 && rowA?.cost > 0 && rowA?.lastActive > 0, rowA);
    check('用量：用户接口带全站汇总', adminUsers.data?.usage?.totals?.requests === 4, adminUsers.data?.usage);

    // ============ 审核 ============
    section('内容审核');
    const hidden = await admin.post('/api/gallery/admin/hide', { id: itemId, hidden: true });
    check('管理员隐藏作品', hidden.data?.hidden === true, hidden.data);
    const afterHidden = await userB.post('/api/gallery/list', {});
    check('隐藏后普通用户列表中不可见', !afterHidden.data?.items?.some(i => i.id === itemId));
    check('隐藏后作者仍可见', (await userA.post('/api/gallery/item', { id: itemId })).status === 200);
} catch (error) {
    check(`冒烟测试异常：${error.message}`, false, error.stack?.split('\n')[1]);
} finally {
    section('清理测试数据');
    const admin = await client(ADMIN_HANDLE, ADMIN_PASSWORD).catch(() => null);

    if (admin) {
        for (const id of cleanup.galleryItems.filter(Boolean)) {
            await admin.post('/api/gallery/admin/delete', { id });
        }

        for (const id of cleanup.announcements.filter(Boolean)) {
            await admin.post('/api/announcements/admin/delete', { id });
        }

        if (cleanup.channel) {
            await admin.post('/api/admin/channels/delete', { id: cleanup.channel });
        }

        for (const handle of cleanup.users) {
            await admin.post('/api/users/delete', { handle, purge: true });
        }

        for (const code of cleanup.invites.filter(Boolean)) {
            await admin.post('/api/admin/invites/delete', { code });
        }
    }

    mock.close();
}

const failed = results.filter(r => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} 通过${failed.length ? ` — 失败：${failed.map(f => f.name).join(' | ')}` : ''} ===`);
process.exit(failed.length ? 1 : 0);
