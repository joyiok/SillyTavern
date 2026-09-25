/**
 * 作品广场 (Gallery) + 站点管理 (Site admin) frontend.
 * A single unified surface: gallery browsing/publishing, content moderation
 * and site administration. Applies the user's active SillyTavern theme so it
 * looks native both as a standalone page and embedded into the main UI.
 */

let csrfToken = '';
let isAdmin = false;
let adminView = false;
let adminFilter = 'all';
let currentSort = 'new';
let currentQuery = '';
let currentPage = 1;
let currentItem = null;
let publishingItemId = null;
let selectedChar = null;
let myCharacters = [];
const publishTags = [];

// ============================================================
// Theme
// ============================================================

/**
 * Applies the user's active theme (colors, blur, shadows) from their settings.
 * Falls back to the default style.css theme if settings are unavailable.
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
        // Theme fields live in the saved settings object, under power_user
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

        const metaThemeColor = document.querySelector('meta[name=theme-color]');
        if (metaThemeColor && p.blur_tint_color) {
            metaThemeColor.setAttribute('content', p.blur_tint_color);
        }
    } catch {
        // Keep the default theme
    }
}

// ============================================================
// API helpers
// ============================================================

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
        throw new Error('未登录');
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
 * Sends a JSON request to the gallery API.
 * @param {string} endpoint API path (relative to /api/gallery)
 * @param {object} body Request body
 * @returns {Promise<any>} Parsed response
 */
function galleryApi(endpoint, body = {}) {
    return api(`/api/gallery/${endpoint}`, body);
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

/**
 * Opens a modal by id.
 * @param {string} id Modal element id
 */
function openModal(id) {
    document.getElementById(id).classList.add('open');
}

/**
 * Closes a modal by id.
 * @param {string} id Modal element id
 */
function closeModal(id) {
    document.getElementById(id).classList.remove('open');
}

// ============================================================
// View switching (gallery / site admin)
// ============================================================

/**
 * Switches between the gallery view and the site admin view.
 * @param {string} view 'gallery' or 'admin'
 * @returns {Promise<void>}
 */
async function switchView(view) {
    if (view === 'admin' && !isAdmin) {
        return;
    }

    document.querySelectorAll('#viewTabs .tab').forEach(t => {
        t.classList.toggle('active', t.dataset.view === view);
    });

    document.getElementById('viewGallery').style.display = view === 'gallery' ? '' : 'none';
    document.getElementById('viewAdmin').style.display = view === 'admin' ? '' : 'none';
    document.getElementById('searchBox').style.display = view === 'gallery' ? '' : 'none';
    document.getElementById('sortTabs').style.display = view === 'gallery' ? '' : 'none';
    document.getElementById('publishBtn').style.display = view === 'gallery' ? '' : 'none';

    if (view === 'admin') {
        await Promise.all([loadSiteUsers(), loadRegistrationView()]);
    } else {
        await loadList();
    }
}

// ============================================================
// Gallery list
// ============================================================

/**
 * Loads the gallery list and renders it.
 * @returns {Promise<void>}
 */
async function loadList() {
    if (adminView) {
        await loadAdminList();
        return;
    }

    const grid = document.getElementById('grid');
    const empty = document.getElementById('empty');

    try {
        const body = { page: currentPage, limit: 24, q: currentQuery };

        if (currentSort === 'mine') {
            body.mine = true;
            body.sort = 'new';
        } else {
            body.sort = currentSort;
        }

        const data = await galleryApi('list', body);
        grid.innerHTML = '';
        empty.style.display = data.items.length ? 'none' : 'block';

        for (const item of data.items) {
            grid.appendChild(renderCard(item));
        }
    } catch (error) {
        toast(error.message, 'error');
    }
}

/**
 * Loads and renders the content moderation view.
 * @returns {Promise<void>}
 */
async function loadAdminList() {
    const grid = document.getElementById('grid');
    const empty = document.getElementById('empty');

    try {
        const data = await galleryApi('admin/list');
        let items = data.items ?? [];

        // Stats
        const totalDownloads = items.reduce((sum, i) => sum + (i.downloads ?? 0), 0);
        const totalLikes = items.reduce((sum, i) => sum + (i.likes ?? 0), 0);
        const pendingReports = items.filter(i => Array.isArray(i.reports) && i.reports.length).length;
        document.getElementById('adminStats').innerHTML = `
            <span><b>${items.length}</b>作品</span>
            <span><b>${totalDownloads}</b>总领取</span>
            <span><b>${totalLikes}</b>总点赞</span>
            <span><b>${pendingReports}</b>待处理举报</span>`;

        // Filters
        if (adminFilter === 'reported') {
            items = items.filter(i => Array.isArray(i.reports) && i.reports.length);
        } else if (adminFilter === 'hidden') {
            items = items.filter(i => i.hidden);
        } else if (adminFilter === 'unlisted') {
            items = items.filter(i => i.visibility !== 'public');
        }

        if (currentQuery) {
            const q = currentQuery.toLowerCase();
            items = items.filter(i => [i.title, i.author, i.cardName, ...(i.tags ?? [])].join(' ').toLowerCase().includes(q));
        }

        grid.innerHTML = '';
        empty.style.display = items.length ? 'none' : 'block';

        for (const item of items) {
            grid.appendChild(renderCard(item));
        }
    } catch (error) {
        toast(error.message, 'error');
    }
}

/**
 * Renders a gallery card element.
 * @param {object} item Gallery item
 * @returns {HTMLElement} Card element
 */
function renderCard(item) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
        <img class="cover" src="/api/gallery/image/${esc(item.id)}" alt="${esc(item.title)}" loading="lazy">
        <div class="body">
            <div class="title">${esc(item.title)}</div>
            <div class="author">by ${esc(item.authorName || item.author)} · v${esc(item.version)}</div>
            <div class="tags">${(item.tags ?? []).slice(0, 3).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
            <div class="stats">
                <span><i class="fa-solid fa-heart"></i>${item.likes ?? 0}</span>
                <span><i class="fa-solid fa-download"></i>${item.downloads ?? 0}</span>
                ${Array.isArray(item.reports) && item.reports.length ? `<span class="badge warn"><i class="fa-solid fa-flag"></i> ${item.reports.length}</span>` : ''}
                ${item.hidden ? '<span class="badge warn">已隐藏</span>' : ''}
                ${item.visibility === 'unlisted' ? '<span class="badge">不公开</span>' : ''}
            </div>
        </div>`;
    card.addEventListener('click', () => openDetail(item.id));
    return card;
}

// ============================================================
// Detail modal
// ============================================================

/**
 * Opens the detail modal for an item.
 * @param {string} itemId Item ID
 * @returns {Promise<void>}
 */
async function openDetail(itemId) {
    try {
        const item = await galleryApi('item', { id: itemId });
        currentItem = item;

        document.getElementById('detailCover').src = `/api/gallery/image/${item.id}`;
        document.getElementById('detailTitle').textContent = item.title;
        document.getElementById('detailDesc').textContent = item.description || '（作者很懒，什么都没写）';
        document.getElementById('detailTags').innerHTML = (item.tags ?? []).map(t => `<span class="tag">${esc(t)}</span>`).join('');
        document.getElementById('detailMeta').innerHTML = `
            作者：${esc(item.authorName || item.author)} ·
            版本：v${esc(item.version)} ·
            <i class="fa-solid fa-heart"></i> ${item.likes} ·
            <i class="fa-solid fa-download"></i> ${item.downloads} ·
            发布于 ${new Date(item.created).toLocaleDateString()}`;

        document.getElementById('detailVersions').innerHTML = (item.versions ?? []).slice().reverse()
            .map(v => `<div>v${esc(v.version)} · ${new Date(v.date).toLocaleString()} ${v.note ? '· ' + esc(v.note) : ''}</div>`)
            .join('');

        // Admin-only: report details
        const reportsBlock = document.getElementById('detailReportsBlock');
        if (isAdmin && Array.isArray(item.reports) && item.reports.length) {
            reportsBlock.style.display = '';
            document.getElementById('detailReports').innerHTML = item.reports
                .map(r => `<div><i class="fa-solid fa-flag" style="color:var(--gal-danger)"></i> <b>${esc(r.by)}</b> · ${new Date(r.date).toLocaleString()}<div class="report-reason">${esc(r.reason || '（未填写原因）')}</div></div>`)
                .join('');
        } else {
            reportsBlock.style.display = 'none';
        }

        const likeBtn = document.getElementById('likeBtn');
        likeBtn.innerHTML = item.liked
            ? '<i class="fa-solid fa-heart" style="color:var(--gal-danger)"></i> 已点赞'
            : '<i class="fa-solid fa-heart"></i> 点赞';

        const claimBtn = document.getElementById('claimBtn');
        claimBtn.innerHTML = item.claimed
            ? '<i class="fa-solid fa-cloud-arrow-down"></i> 再领一份'
            : '<i class="fa-solid fa-cloud-arrow-down"></i> 领取到我的角色';

        const ownerOrAdmin = item.isOwner || isAdmin;
        document.getElementById('editBtn').style.display = item.isOwner ? '' : 'none';
        document.getElementById('deleteBtn').style.display = ownerOrAdmin ? '' : 'none';
        document.getElementById('hideBtn').style.display = isAdmin ? '' : 'none';
        document.getElementById('hideBtn').innerHTML = item.hidden
            ? '<i class="fa-solid fa-eye"></i> 取消隐藏'
            : '<i class="fa-solid fa-eye-slash"></i> 隐藏';
        document.getElementById('reportBtn').style.display = item.isOwner ? 'none' : '';

        openModal('detailMask');
    } catch (error) {
        toast(error.message, 'error');
    }
}

// ============================================================
// Publish wizard
// ============================================================

/**
 * Loads the current user's characters for the publish dialog.
 * @returns {Promise<void>}
 */
async function loadCharacters() {
    const container = document.getElementById('charList');
    container.innerHTML = '<div class="hint" style="padding:16px">加载中…</div>';

    try {
        const response = await fetch('/api/characters/all', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
            credentials: 'same-origin',
        });

        if (response.status === 403) {
            window.location.href = '/login';
            return;
        }

        const characters = await response.json();
        myCharacters = Array.isArray(characters) ? characters : [];
        renderCharacterPicker('');
    } catch (error) {
        container.innerHTML = `<div class="hint" style="padding:16px">${esc(error.message)}</div>`;
    }
}

/**
 * Renders the character picker, filtered by a search query.
 * @param {string} query Search query
 * @returns {void}
 */
function renderCharacterPicker(query) {
    const container = document.getElementById('charList');
    const q = query.trim().toLowerCase();
    const list = myCharacters.filter(c => !q || (c.name ?? '').toLowerCase().includes(q));

    document.getElementById('charCounter').textContent = `${myCharacters.length} 个角色`;

    if (!list.length) {
        container.innerHTML = `<div class="hint" style="padding:16px">${myCharacters.length ? '没有匹配的角色' : '你还没有角色卡，先去聊天页创建一个吧'}</div>`;
        return;
    }

    container.innerHTML = '';

    for (const character of list) {
        const item = document.createElement('div');
        item.className = `char-item${selectedChar === character.avatar ? ' selected' : ''}`;
        item.innerHTML = `
            <img src="/thumbnail?type=avatar&file=${encodeURIComponent(character.avatar)}&t=${Date.now()}" alt="">
            <span>${esc(character.name)}</span>`;
        item.addEventListener('click', () => {
            selectedChar = character.avatar;
            document.querySelectorAll('#charList .char-item').forEach(el => el.classList.remove('selected'));
            item.classList.add('selected');
            document.getElementById('charPickerRow').classList.remove('invalid');

            if (!document.getElementById('pubTitle').value) {
                document.getElementById('pubTitle').value = character.name || '';
            }

            updatePreview();
        });
        container.appendChild(item);
    }
}

/**
 * Renders the tag chips editor.
 * @returns {void}
 */
function renderTagChips() {
    const box = document.getElementById('chipsBox');
    const input = document.getElementById('galTagInput');
    box.querySelectorAll('.chip').forEach(el => el.remove());

    for (const tag of publishTags) {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.innerHTML = `${esc(tag)} <i class="fa-solid fa-times"></i>`;
        chip.querySelector('i').addEventListener('click', () => {
            publishTags.splice(publishTags.indexOf(tag), 1);
            renderTagChips();
            updatePreview();
        });
        box.insertBefore(chip, input);
    }

    document.getElementById('tagCounter').textContent = `${publishTags.length} / 10`;
}

/**
 * Adds a tag to the editor.
 * @param {string} tag Tag to add
 * @returns {void}
 */
function addTag(tag) {
    const clean = tag.trim().slice(0, 32);

    if (!clean || publishTags.includes(clean)) {
        return;
    }

    if (publishTags.length >= 10) {
        return toast('最多 10 个标签', 'error');
    }

    publishTags.push(clean);
    renderTagChips();
    updatePreview();
}

/**
 * Loads popular tag suggestions.
 * @returns {Promise<void>}
 */
async function loadTagSuggestions() {
    const box = document.getElementById('tagSuggestions');

    try {
        const data = await galleryApi('tags');
        box.innerHTML = (data.tags ?? [])
            .filter(t => !publishTags.includes(t.tag))
            .slice(0, 12)
            .map(t => `<span class="tag" title="${t.count} 个作品使用">+ ${esc(t.tag)}</span>`)
            .join('');

        box.querySelectorAll('.tag').forEach(el => {
            el.addEventListener('click', () => {
                addTag(el.textContent.replace(/^\+ /, ''));
                loadTagSuggestions();
            });
        });
    } catch {
        box.innerHTML = '';
    }
}

/**
 * Updates the live preview card.
 * @returns {void}
 */
function updatePreview() {
    const title = document.getElementById('pubTitle').value.trim();
    const desc = document.getElementById('pubDesc').value.trim();

    document.getElementById('previewTitle').textContent = title || '未命名作品';
    document.getElementById('previewTags').innerHTML = publishTags.map(t => `<span class="tag">${esc(t)}</span>`).join('');

    const cover = document.getElementById('previewCover');
    if (selectedChar) {
        cover.src = `/thumbnail?type=avatar&file=${encodeURIComponent(selectedChar)}&t=${Date.now()}`;
    } else {
        cover.removeAttribute('src');
    }

    const hint = document.getElementById('previewHint');
    hint.textContent = desc ? `简介 ${desc.length} 字` : '还没有写简介';

    document.getElementById('titleCounter').textContent = `${document.getElementById('pubTitle').value.length} / 80`;
    document.getElementById('descCounter').textContent = `${document.getElementById('pubDesc').value.length} / 2000`;
    document.getElementById('noteCounter').textContent = `${document.getElementById('pubNote').value.length} / 500`;
}

/**
 * Opens the publish dialog, optionally for updating an existing item.
 * @param {object|null} item Item to update, or null for a new publication
 * @returns {Promise<void>}
 */
async function openPublish(item = null) {
    publishingItemId = item?.id ?? null;
    selectedChar = item?.sourceFile ?? null;
    publishTags.length = 0;
    (item?.tags ?? []).forEach(t => publishTags.push(t));

    document.getElementById('publishHeading').innerHTML = item
        ? '<i class="fa-solid fa-pen" style="color:var(--gal-accent); margin-right:6px;"></i>更新版本'
        : '<i class="fa-solid fa-cloud-arrow-up" style="color:var(--gal-accent); margin-right:6px;"></i>发布作品';
    document.getElementById('publishSubmit').innerHTML = item
        ? '<i class="fa-solid fa-pen"></i> 发布新版本'
        : '<i class="fa-solid fa-cloud-arrow-up"></i> 发布';
    document.getElementById('pubTitle').value = item?.title ?? '';
    document.getElementById('pubDesc').value = item?.description ?? '';
    document.getElementById('pubNote').value = '';
    document.getElementById('charSearch').value = '';

    setVisibility(item?.visibility ?? 'public');
    document.getElementById('charPickerRow').classList.remove('invalid');
    document.getElementById('titleRow').classList.remove('invalid');

    renderTagChips();
    updatePreview();
    openModal('publishMask');

    await Promise.all([loadCharacters(), loadTagSuggestions()]);
    renderCharacterPicker('');
}

/**
 * Sets the visibility radio cards.
 * @param {string} visibility 'public' or 'unlisted'
 * @returns {void}
 */
function setVisibility(visibility) {
    document.querySelectorAll('#visCards .vis-card').forEach(card => {
        card.classList.toggle('selected', card.dataset.vis === visibility);
    });
}

/**
 * Returns the currently selected visibility.
 * @returns {string} 'public' or 'unlisted'
 */
function getVisibility() {
    return document.querySelector('#visCards .vis-card.selected')?.dataset.vis ?? 'public';
}

/**
 * Publishes or updates an item with validation.
 * @returns {Promise<void>}
 */
async function submitPublish() {
    const titleRow = document.getElementById('titleRow');
    const charPickerRow = document.getElementById('charPickerRow');
    let valid = true;

    if (!selectedChar) {
        charPickerRow.classList.add('invalid');
        valid = false;
    }

    if (!document.getElementById('pubTitle').value.trim()) {
        titleRow.classList.add('invalid');
        valid = false;
    } else {
        titleRow.classList.remove('invalid');
    }

    if (!valid) {
        return toast('请完善必填信息', 'error');
    }

    const payload = {
        avatar_url: selectedChar,
        title: document.getElementById('pubTitle').value.trim(),
        description: document.getElementById('pubDesc').value.trim(),
        tags: publishTags.slice(),
        visibility: getVisibility(),
        note: document.getElementById('pubNote').value.trim(),
    };

    const submitBtn = document.getElementById('publishSubmit');
    submitBtn.disabled = true;

    try {
        if (publishingItemId) {
            await galleryApi('update', { id: publishingItemId, ...payload });
            toast('已发布新版本 ✓', 'success');
        } else {
            await galleryApi('publish', payload);
            toast('发布成功，作品已上架广场 ✓', 'success');
        }

        closeModal('publishMask');
        await loadList();
    } catch (error) {
        toast(error.message, 'error');
    } finally {
        submitBtn.disabled = false;
    }
}

// ============================================================
// Site admin: users, quotas, invites
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
async function loadSiteUsers() {
    const container = document.getElementById('adminUserList');

    try {
        const data = await api('/api/admin/users');
        const q = data.quotas ?? {};

        document.getElementById('adminQuotaInfo').innerHTML = q.enabled
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

        await loadSiteUsers();
    } catch (error) {
        toast(error.message, 'error');
    }
}

/**
 * Loads registration settings and invite codes.
 * @returns {Promise<void>}
 */
async function loadRegistrationView() {
    try {
        const data = await api('/api/admin/registration');

        document.getElementById('adminRegistrationInfo').innerHTML = `
            <i class="fa-solid fa-circle-info" style="color:var(--gal-accent)"></i>
            注册功能：<b>${data.enabled ? '已开启' : '已关闭'}</b> ·
            邀请码：<b>${data.inviteRequired ? '必须' : '不需要'}</b> ·
            注册审批：<b>${data.requireApproval ? '需要' : '不需要'}</b> ·
            密码最少 <b>${data.minPasswordLength}</b> 位
            <small>（修改 config.yaml 中 registration 配置后重启生效）</small>`;

        const container = document.getElementById('adminInviteList');
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
                    await loadRegistrationView();
                } catch (error) {
                    toast(error.message, 'error');
                }
            });
        });
    } catch (error) {
        document.getElementById('adminRegistrationInfo').innerHTML = esc(error.message);
        document.getElementById('adminInviteList').innerHTML = '';
    }
}

/**
 * Creates a new invite code.
 * @returns {Promise<void>}
 */
async function createInvite() {
    try {
        const invite = await api('/api/admin/invites/create', {
            note: document.getElementById('adminInviteNote').value.trim(),
            singleUse: document.getElementById('adminInviteSingleUse').checked,
        });

        document.getElementById('adminInviteNote').value = '';
        toast(`邀请码已生成：${invite.code}`, 'success');
        await loadRegistrationView();
    } catch (error) {
        toast(error.message, 'error');
    }
}

// ============================================================
// Events
// ============================================================

/**
 * Binds all UI events.
 * @returns {void}
 */
function bindEvents() {
    document.querySelectorAll('.modal-close, [data-close]').forEach(el => {
        el.addEventListener('click', () => closeModal(el.dataset.close));
    });

    document.querySelectorAll('.modal-mask').forEach(mask => {
        mask.addEventListener('click', (event) => {
            if (event.target === mask) {
                closeModal(mask.id);
            }
        });
    });

    // View switching (gallery / site admin)
    document.querySelectorAll('#viewTabs .tab').forEach(tab => {
        tab.addEventListener('click', () => switchView(tab.dataset.view));
    });

    // Sort tabs
    document.querySelectorAll('#sortTabs .tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('#sortTabs .tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            currentSort = tab.dataset.sort;
            currentPage = 1;
            loadList();
        });
    });

    // Search
    const search = () => {
        currentQuery = document.getElementById('searchInput').value.trim();
        currentPage = 1;
        loadList();
    };

    document.getElementById('searchBtn').addEventListener('click', search);
    document.getElementById('searchInput').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            search();
        }
    });

    // Publish wizard
    document.getElementById('publishBtn').addEventListener('click', () => openPublish(null));
    document.getElementById('publishSubmit').addEventListener('click', submitPublish);

    document.getElementById('charSearch').addEventListener('input', (event) => {
        renderCharacterPicker(event.target.value);
    });

    for (const id of ['pubTitle', 'pubDesc', 'pubNote']) {
        document.getElementById(id).addEventListener('input', updatePreview);
    }

    document.getElementById('pubTitle').addEventListener('input', () => {
        document.getElementById('titleRow').classList.remove('invalid');
    });

    // Tag chips editor
    document.getElementById('galTagInput').addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
            event.preventDefault();
            addTag(event.target.value);
            event.target.value = '';
            loadTagSuggestions();
        } else if (event.key === 'Backspace' && !event.target.value && publishTags.length) {
            publishTags.pop();
            renderTagChips();
            updatePreview();
        }
    });

    // Visibility cards
    document.querySelectorAll('#visCards .vis-card').forEach(card => {
        card.addEventListener('click', () => setVisibility(card.dataset.vis));
    });

    // Detail actions
    document.getElementById('claimBtn').addEventListener('click', async () => {
        try {
            const data = await galleryApi('claim', { id: currentItem.id });
            toast(`已领取：${data.file_name}.png ✓ 回聊天页刷新角色列表即可看到`, 'success');
            await openDetail(currentItem.id);
        } catch (error) {
            toast(error.message, 'error');
        }
    });

    document.getElementById('likeBtn').addEventListener('click', async () => {
        try {
            await galleryApi('like', { id: currentItem.id });
            await openDetail(currentItem.id);
        } catch (error) {
            toast(error.message, 'error');
        }
    });

    document.getElementById('reportBtn').addEventListener('click', async () => {
        const reason = window.prompt('请输入举报原因：');
        if (reason === null) {
            return;
        }

        try {
            await galleryApi('report', { id: currentItem.id, reason });
            toast('已提交举报，管理员会尽快处理 ✓', 'success');
        } catch (error) {
            toast(error.message, 'error');
        }
    });

    document.getElementById('editBtn').addEventListener('click', () => {
        closeModal('detailMask');
        openPublish(currentItem);
    });

    document.getElementById('deleteBtn').addEventListener('click', async () => {
        if (!window.confirm('确定删除这个作品吗？此操作不可恢复。')) {
            return;
        }

        try {
            await galleryApi('delete', { id: currentItem.id });
            toast('已删除 ✓', 'success');
            closeModal('detailMask');
            await loadList();
        } catch (error) {
            toast(error.message, 'error');
        }
    });

    document.getElementById('hideBtn').addEventListener('click', async () => {
        try {
            await galleryApi('admin/hide', { id: currentItem.id, hidden: !currentItem.hidden });
            toast(currentItem.hidden ? '已取消隐藏 ✓' : '已隐藏 ✓', 'success');
            await openDetail(currentItem.id);
            await loadList();
        } catch (error) {
            toast(error.message, 'error');
        }
    });

    // Content moderation toggle
    document.getElementById('adminToggleBtn').addEventListener('click', () => {
        adminView = !adminView;
        adminFilter = 'all';
        const btn = document.getElementById('adminToggleBtn');
        btn.classList.toggle('primary', adminView);
        btn.innerHTML = adminView
            ? '<i class="fa-solid fa-times"></i> 退出管理视图'
            : '<i class="fa-solid fa-shield-halved"></i> 管理视图';
        document.getElementById('adminBar').style.display = adminView ? 'flex' : 'none';
        document.querySelectorAll('#adminFilterTabs .tab').forEach(t => t.classList.remove('active'));
        document.querySelector('#adminFilterTabs .tab[data-adminfilter="all"]').classList.add('active');
        loadList();
    });

    document.querySelectorAll('#adminFilterTabs .tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('#adminFilterTabs .tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            adminFilter = tab.dataset.adminfilter;
            loadList();
        });
    });

    // Site admin
    document.getElementById('adminCreateInviteBtn').addEventListener('click', createInvite);
}

// ============================================================
// Init
// ============================================================

/**
 * Initializes the page.
 * @returns {Promise<void>}
 */
async function init() {
    csrfToken = await getCsrfToken();
    await applyUserTheme();
    bindEvents();

    // Show site admin tab if the current user is an admin
    try {
        const response = await fetch('/api/users/me', {
            method: 'GET',
            headers: { 'X-CSRF-Token': csrfToken },
            credentials: 'same-origin',
        });

        if (response.ok) {
            const me = await response.json();
            isAdmin = me.admin === true;
            document.getElementById('adminViewTab').style.display = isAdmin ? '' : 'none';
            document.getElementById('adminToggleBtn').style.display = isAdmin ? '' : 'none';
        }
    } catch {
        // Ignore: admin UI is only a convenience
    }

    await loadList();
}

init();
