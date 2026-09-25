/**
 * 站点管理 (Site admin) frontend.
 * User management with usage quotas, invite codes and registration settings.
 */

let csrfToken = '';

// ============================================================
// Helpers (same look & feel as the gallery page)
// ============================================================

/**
 * Applies the user's active theme from their settings.
 * @returns {Promise<void>}
 */
async function applyUserTheme() {
    try {
        const response = await fetch('/api/settings/get', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
            credentials: 'same-origin',
        });

        if (!response.ok) {
            return;
        }

        const settings = await response.json();
        let saved = settings.settings ?? settings;

        if (typeof saved === 'string') {
            try {
                saved = JSON.parse(saved);
            } catch {
                saved = {};
            }
        }

        const p = saved.power_user ?? {};
        const root = document.documentElement;

        const colorVars = {
            '--SmartThemeBodyColor': p.main_text_color,
            '--SmartThemeEmColor': p.italics_text_color,
            '--SmartThemeUnderlineColor': p.underline_text_color,
            '--SmartThemeQuoteColor': p.quote_text_color,
            '--SmartThemeBlurTintColor': p.blur_tint_color,
            '--SmartThemeChatTintColor': p.chat_tint_color,
            '--SmartThemeUserMesBlurTintColor': p.user_mes_blur_tint_color,
            '--SmartThemeBotMesBlurTintColor': p.bot_mes_blur_tint_color,
            '--SmartThemeShadowColor': p.shadow_color,
            '--SmartThemeBorderColor': p.border_color,
        };

        for (const [name, value] of Object.entries(colorVars)) {
            if (value) {
                root.style.setProperty(name, value);
            }
        }

        if (p.blur_strength !== undefined) {
            root.style.setProperty('--blurStrength', String(p.blur_strength));
        }

        if (p.shadow_width !== undefined) {
            root.style.setProperty('--shadowWidth', String(p.shadow_width));
        }

        if (p.font_scale !== undefined) {
            root.style.setProperty('--fontScale', String(p.font_scale));
        }
    } catch {
        // Keep the default theme
    }
}

/**
 * Fetches a CSRF token from the server.
 * @returns {Promise<string>} CSRF token
 */
async function getCsrfToken() {
    const response = await fetch('/csrf-token');
    const data = await response.json();
    return data.token;
}

/**
 * Sends a JSON request.
 * @param {string} url API URL
 * @param {object} body Request body
 * @returns {Promise<any>} Parsed response
 */
async function api(url, body = {}) {
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify(body),
        credentials: 'same-origin',
    });

    if (response.status === 403) {
        window.location.href = '/login';
        throw new Error('无权限或未登录');
    }

    if (response.status === 204) {
        return null;
    }

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(data.error || `请求失败 (${response.status})`);
    }

    return data;
}

/**
 * Escapes HTML special characters.
 * @param {string} text Raw text
 * @returns {string} Escaped text
 */
function esc(text) {
    const div = document.createElement('div');
    div.textContent = text ?? '';
    return div.innerHTML;
}

/**
 * Shows a toast message.
 * @param {string} message Message to show
 * @param {'error'|'success'|''} type Toast type
 */
function toast(message, type = '') {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.className = type;
    el.style.display = 'block';
    clearTimeout(el._timer);
    el._timer = setTimeout(() => { el.style.display = 'none'; }, 2600);
}

// ============================================================
// Users
// ============================================================

/**
 * Renders a usage bar.
 * @param {string} label Label
 * @param {number} used Used amount
 * @param {number} max Maximum amount (-1 = unlimited)
 * @param {string} unit Unit suffix
 * @returns {string} HTML string
 */
function usageBar(label, used, max, unit) {
    const unlimited = max < 0;
    const percent = unlimited ? 0 : Math.min((used / Math.max(max, 1)) * 100, 100);
    const over = !unlimited && used >= max;

    return `
        <div class="usage-item">
            <div class="label">${esc(label)}</div>
            <div class="usage-bar"><div class="${over ? 'over' : ''}" style="width:${unlimited ? 4 : percent}%"></div></div>
            <div class="usage-text">${esc(used)}${unit} / ${unlimited ? '不限' : esc(max) + unit}</div>
        </div>`;
}

/**
 * Loads and renders the user list with usage.
 * @returns {Promise<void>}
 */
async function loadUsers() {
    const container = document.getElementById('userList');

    try {
        const data = await api('/api/admin/users');
        const q = data.quotas ?? {};

        document.getElementById('quotaInfo').innerHTML = q.enabled
            ? `<i class="fa-solid fa-circle-check" style="color:var(--gal-ok)"></i> 配额已启用：
               存储 ${q.maxStorageMB < 0 ? '不限' : q.maxStorageMB + ' MB'} ·
               角色卡 ${q.maxCharacters < 0 ? '不限' : q.maxCharacters + ' 个'} ·
               广场作品 ${q.maxGalleryItems < 0 ? '不限' : q.maxGalleryItems + ' 个'}
               <small>（修改 config.yaml 中 quotas 配置后重启生效）</small>`
            : '<i class="fa-solid fa-circle-xmark" style="color:var(--gal-danger)"></i> 配额未启用';

        if (!data.users.length) {
            container.innerHTML = '<div class="info-card">还没有用户</div>';
            return;
        }

        container.innerHTML = '';

        for (const user of data.users) {
            const row = document.createElement('div');
            row.className = 'user-row';

            const badges = [
                user.admin ? '<span class="badge">管理员</span>' : '',
                user.enabled ? '' : '<span class="badge warn">待审批 / 已停用</span>',
                user.hasPassword ? '' : '<span class="badge warn">无密码</span>',
            ].join(' ');

            row.innerHTML = `
                <div class="user-id">
                    <div class="uname">${esc(user.name)} ${badges}</div>
                    <div class="uhandle">@${esc(user.handle)} · 注册于 ${new Date(user.created).toLocaleDateString()}</div>
                </div>
                <div class="usage-block">
                    ${usageBar('存储', Math.round(user.storageBytes / 1024 / 1024 * 10) / 10, q.maxStorageMB, ' MB')}
                    ${usageBar('角色卡', user.characters, q.maxCharacters, '')}
                    ${usageBar('广场作品', user.galleryItems, q.maxGalleryItems, '')}
                </div>
                <div class="user-actions">
                    ${user.enabled
        ? `<button class="menu_button" data-act="disable" data-handle="${esc(user.handle)}"><i class="fa-solid fa-ban"></i> 停用</button>`
        : `<button class="menu_button btn-ok" data-act="enable" data-handle="${esc(user.handle)}"><i class="fa-solid fa-check"></i> 通过/启用</button>`}
                    <button class="menu_button" data-act="${user.admin ? 'demote' : 'promote'}" data-handle="${esc(user.handle)}">
                        <i class="fa-solid fa-user-tie"></i> ${user.admin ? '取消管理员' : '设为管理员'}
                    </button>
                    <button class="menu_button btn-danger" data-act="delete" data-handle="${esc(user.handle)}"><i class="fa-solid fa-trash"></i> 删除</button>
                </div>`;

            container.appendChild(row);
        }

        container.querySelectorAll('[data-act]').forEach(btn => {
            btn.addEventListener('click', () => handleUserAction(btn.dataset.act, btn.dataset.handle));
        });
    } catch (error) {
        container.innerHTML = `<div class="info-card">${esc(error.message)}</div>`;
    }
}

/**
 * Handles a user management action.
 * @param {string} action Action name
 * @param {string} handle User handle
 * @returns {Promise<void>}
 */
async function handleUserAction(action, handle) {
    try {
        if (action === 'delete') {
            if (!window.confirm(`确定删除用户 ${handle} 吗？其所有数据将被删除，此操作不可恢复。`)) {
                return;
            }

            await api('/api/users/delete', { handle });
            toast(`已删除用户 ${handle} ✓`, 'success');
        } else if (action === 'enable') {
            await api('/api/users/enable', { handle });
            toast(`已启用用户 ${handle} ✓`, 'success');
        } else if (action === 'disable') {
            await api('/api/users/disable', { handle });
            toast(`已停用用户 ${handle} ✓`, 'success');
        } else if (action === 'promote') {
            await api('/api/users/promote', { handle });
            toast(`已将 ${handle} 设为管理员 ✓`, 'success');
        } else if (action === 'demote') {
            await api('/api/users/demote', { handle });
            toast(`已取消 ${handle} 的管理员权限 ✓`, 'success');
        }

        await loadUsers();
    } catch (error) {
        toast(error.message, 'error');
    }
}

// ============================================================
// Invites & registration
// ============================================================

/**
 * Loads registration settings and invite codes.
 * @returns {Promise<void>}
 */
async function loadRegistration() {
    try {
        const data = await api('/api/admin/registration');

        document.getElementById('registrationInfo').innerHTML = `
            <i class="fa-solid fa-circle-info" style="color:var(--gal-accent)"></i>
            注册功能：<b>${data.enabled ? '已开启' : '已关闭'}</b> ·
            邀请码：<b>${data.inviteRequired ? '必须' : '不需要'}</b> ·
            注册审批：<b>${data.requireApproval ? '需要' : '不需要'}</b> ·
            密码最少 <b>${data.minPasswordLength}</b> 位
            <small>（修改 config.yaml 中 registration 配置后重启生效）</small>`;

        const container = document.getElementById('inviteList');
        const invites = data.invites ?? [];

        if (!invites.length) {
            container.innerHTML = '<div class="info-card">还没有生成过邀请码</div>';
            return;
        }

        container.innerHTML = '';

        for (const invite of invites) {
            const row = document.createElement('div');
            row.className = 'invite-row';
            row.innerHTML = `
                <div class="invite-code">${esc(invite.code)}</div>
                <div class="invite-note">
                    ${esc(invite.note || '（无备注）')} ·
                    ${invite.singleUse ? '单次使用' : '可重复使用'} ·
                    ${invite.usedBy ? `已被 <b>${esc(invite.usedBy)}</b> 使用` : '未使用'} ·
                    创建于 ${new Date(invite.created).toLocaleDateString()}
                </div>
                <div class="user-actions">
                    <button class="menu_button" data-copy="${esc(invite.code)}"><i class="fa-solid fa-copy"></i> 复制</button>
                    <button class="menu_button btn-danger" data-del="${esc(invite.code)}"><i class="fa-solid fa-trash"></i> 删除</button>
                </div>`;
            container.appendChild(row);
        }

        container.querySelectorAll('[data-copy]').forEach(btn => {
            btn.addEventListener('click', async () => {
                await navigator.clipboard.writeText(btn.dataset.copy);
                toast('已复制到剪贴板 ✓', 'success');
            });
        });

        container.querySelectorAll('[data-del]').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!window.confirm(`确定删除邀请码 ${btn.dataset.del} 吗？`)) {
                    return;
                }

                try {
                    await api('/api/admin/invites/delete', { code: btn.dataset.del });
                    toast('已删除邀请码 ✓', 'success');
                    await loadRegistration();
                } catch (error) {
                    toast(error.message, 'error');
                }
            });
        });
    } catch (error) {
        document.getElementById('registrationInfo').innerHTML = esc(error.message);
        document.getElementById('inviteList').innerHTML = '';
    }
}

/**
 * Creates a new invite code.
 * @returns {Promise<void>}
 */
async function createInvite() {
    try {
        const invite = await api('/api/admin/invites/create', {
            note: document.getElementById('inviteNote').value.trim(),
            singleUse: document.getElementById('inviteSingleUse').checked,
        });

        document.getElementById('inviteNote').value = '';
        toast(`邀请码已生成：${invite.code}`, 'success');
        await loadRegistration();
    } catch (error) {
        toast(error.message, 'error');
    }
}

// ============================================================
// Init
// ============================================================

/**
 * Binds UI events.
 * @returns {void}
 */
function bindEvents() {
    document.querySelectorAll('#sectionTabs .tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('#sectionTabs .tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            const section = tab.dataset.section;
            document.getElementById('sectionUsers').style.display = section === 'users' ? '' : 'none';
            document.getElementById('sectionInvites').style.display = section === 'invites' ? '' : 'none';
        });
    });

    document.getElementById('createInviteBtn').addEventListener('click', createInvite);
}

/**
 * Initializes the page.
 * @returns {Promise<void>}
 */
async function init() {
    csrfToken = await getCsrfToken();
    await applyUserTheme();
    bindEvents();
    await Promise.all([loadUsers(), loadRegistration()]);
}

init();
