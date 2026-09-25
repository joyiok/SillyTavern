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
let commentMaxLength = 1000;
let unreadAnnouncements = 0;
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
 * Switches between the gallery, model, announcements, usage and admin views.
 * @param {string} view View name
 * @returns {Promise<void>}
 */
async function switchView(view) {
    if (view === 'admin' && !isAdmin) {
        return;
    }

    document.querySelectorAll('#viewTabs .tab').forEach(t => {
        t.classList.toggle('active', t.dataset.view === view);
    });

    for (const [name, id] of Object.entries({
        gallery: 'viewGallery',
        channels: 'viewChannels',
        announcements: 'viewAnnouncements',
        usage: 'viewUsage',
        admin: 'viewAdmin',
    })) {
        document.getElementById(id).style.display = view === name ? '' : 'none';
    }

    document.getElementById('searchBox').style.display = view === 'gallery' ? '' : 'none';
    document.getElementById('sortTabs').style.display = view === 'gallery' ? '' : 'none';
    document.getElementById('publishBtn').style.display = view === 'gallery' ? '' : 'none';
    document.getElementById('adminToggleBtn').style.display = isAdmin && view === 'gallery' ? '' : 'none';

    if (view === 'admin') {
        await Promise.all([loadSiteUsers(), loadRegistrationView(), loadAdminComments()]);
    } else if (view === 'channels') {
        await loadChannels();
    } else if (view === 'announcements') {
        await loadAnnouncements(true);
    } else if (view === 'usage') {
        await loadUsage();
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
        } else if (currentSort === 'favorites') {
            body.favorites = true;
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
                <span><i class="fa-solid fa-comments"></i>${item.comments ?? 0}</span>
                ${item.favorited ? '<span class="badge fav"><i class="fa-solid fa-star"></i></span>' : ''}
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
            <i class="fa-solid fa-comments"></i> ${item.comments ?? 0} ·
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

        const favoriteBtn = document.getElementById('favoriteBtn');
        favoriteBtn.innerHTML = item.favorited
            ? '<i class="fa-solid fa-star" style="color:var(--gal-accent)"></i> 已收藏'
            : '<i class="fa-solid fa-star" style="opacity:0.55"></i> 收藏';

        const ownerOrAdmin = item.isOwner || isAdmin;
        document.getElementById('editBtn').style.display = item.isOwner ? '' : 'none';
        document.getElementById('deleteBtn').style.display = ownerOrAdmin ? '' : 'none';
        document.getElementById('hideBtn').style.display = isAdmin ? '' : 'none';
        document.getElementById('hideBtn').innerHTML = item.hidden
            ? '<i class="fa-solid fa-eye"></i> 取消隐藏'
            : '<i class="fa-solid fa-eye-slash"></i> 隐藏';
        document.getElementById('reportBtn').style.display = item.isOwner ? 'none' : '';

        openModal('detailMask');
        await loadComments(item.id);
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
// Managed model channels
// ============================================================

/**
 * Loads and renders the model channel selection (and admin management).
 * @returns {Promise<void>}
 */
async function loadChannels() {
    const hint = document.getElementById('channelHint');
    const container = document.getElementById('channelList');

    try {
        const data = await api('/api/channels/list');
        const channels = data.channels ?? [];
        const selection = data.selection ?? {};

        hint.innerHTML = data.restricted
            ? '<i class="fa-solid fa-lock" style="color:var(--gal-accent)"></i> 模型 API 由管理员统一提供，选择一个即可使用；聊天页里的 API 设置不影响实际线路。'
            : '<i class="fa-solid fa-circle-info" style="color:var(--gal-accent)"></i> 可选的模型渠道。';

        if (!channels.length) {
            container.innerHTML = '<div class="info-card">还没有可用的模型渠道，请联系管理员配置</div>';
        } else {
            container.innerHTML = '';

            for (const channel of channels) {
                const card = document.createElement('div');
                card.className = `channel-card${selection.channelId === channel.id ? ' active' : ''}`;

                const active = selection.channelId === channel.id;
                card.innerHTML = `
                    <div class="channel-info">
                        <div class="cname">${esc(channel.name)} ${active ? '<span class="badge">使用中</span>' : ''}</div>
                        <div class="ctype"><i class="fa-solid fa-plug"></i> ${esc(channel.typeLabel)}</div>
                        <div class="channel-models">
                            ${channel.models.length
        ? channel.models.map(m => `<span class="model-chip${active && selection.model === m ? ' active' : ''}" data-model="${esc(m)}"><i class="fa-solid fa-brain"></i> ${esc(m)}</span>`).join('')
        : '<span class="model-chip" data-model=""><i class="fa-solid fa-brain"></i> 使用默认模型</span>'}
                        </div>
                    </div>
                    <div class="channel-actions">
                        <button class="menu_button${active ? '' : 'primary'}" data-select="${esc(channel.id)}"><i class="fa-solid fa-check"></i> ${active ? '已选用' : '使用此渠道'}</button>
                    </div>`;

                card.querySelectorAll('.model-chip').forEach(chip => {
                    chip.addEventListener('click', () => selectChannel(channel.id, chip.dataset.model || null));
                });

                card.querySelector('[data-select]')?.addEventListener('click', () => {
                    selectChannel(channel.id, channel.models[0] ?? null);
                });

                container.appendChild(card);
            }
        }

        // Admin: channel management form
        const adminBlock = document.getElementById('channelAdmin');
        adminBlock.style.display = isAdmin ? '' : 'none';

        if (isAdmin) {
            await loadChannelAdminList();
        }
    } catch (error) {
        hint.innerHTML = esc(error.message);
        container.innerHTML = '';
    }
}

/**
 * Sets the current user's channel selection.
 * @param {string} channelId Channel ID
 * @param {string|null} model Model name
 * @returns {Promise<void>}
 */
async function selectChannel(channelId, model) {
    try {
        await api('/api/channels/select', { channelId, model });
        toast('模型已切换 ✓', 'success');
        await loadChannels();
    } catch (error) {
        toast(error.message, 'error');
    }
}

/**
 * Loads the admin channel management list.
 * @returns {Promise<void>}
 */
async function loadChannelAdminList() {
    const container = document.getElementById('channelAdminList');

    try {
        const data = await api('/api/admin/channels/list');
        const channels = data.channels ?? [];

        if (!channels.length) {
            container.innerHTML = '<div class="info-card">还没有配置渠道</div>';
            return;
        }

        container.innerHTML = '';

        for (const channel of channels) {
            const row = document.createElement('div');
            row.className = 'invite-row';
            row.innerHTML = `
                <div class="invite-code" style="letter-spacing:0">${esc(channel.name)}</div>
                <div class="invite-note">
                    ${esc(channel.typeLabel)} · ${esc(channel.url)} ·
                    Key: ${esc(channel.keyHint || '未设置')} ·
                    ${channel.models.length ? `${channel.models.length} 个模型` : '不限模型'} ·
                    ${channel.priceInput || channel.priceOutput ? `定价 ${channel.priceInput}/${channel.priceOutput} 每 1M tokens · ` : ''}
                    ${channel.enabled ? '已启用' : '已停用'} ·
                    ${channel.selectedBy} 人使用中
                </div>
                <div class="channel-actions">
                    <button class="menu_button" data-edit="${esc(channel.id)}"><i class="fa-solid fa-pen"></i> 编辑</button>
                    <button class="menu_button btn-danger" data-del="${esc(channel.id)}"><i class="fa-solid fa-trash"></i> 删除</button>
                </div>`;
            container.appendChild(row);
        }

        container.querySelectorAll('[data-edit]').forEach(btn => {
            btn.addEventListener('click', () => {
                const channel = channels.find(c => c.id === btn.dataset.edit);
                if (!channel) return;
                document.getElementById('chName').value = channel.name;
                document.getElementById('chType').value = channel.type;
                document.getElementById('chUrl').value = channel.url;
                document.getElementById('chKey').value = '';
                document.getElementById('chKey').placeholder = `API Key（当前：${channel.keyHint || '未设置'}，留空不修改）`;
                document.getElementById('chModels').value = channel.models.join(', ');
                document.getElementById('chPriceInput').value = channel.priceInput || '';
                document.getElementById('chPriceOutput').value = channel.priceOutput || '';
                document.getElementById('chEnabled').checked = channel.enabled;
                document.getElementById('chSaveBtn').dataset.editId = channel.id;
                toast('已载入渠道信息，修改后点击保存', 'success');
            });
        });

        container.querySelectorAll('[data-del]').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!window.confirm('确定删除这个模型渠道吗？')) {
                    return;
                }

                try {
                    await api('/api/admin/channels/delete', { id: btn.dataset.del });
                    toast('已删除渠道 ✓', 'success');
                    await loadChannels();
                } catch (error) {
                    toast(error.message, 'error');
                }
            });
        });
    } catch (error) {
        container.innerHTML = `<div class="info-card">${esc(error.message)}</div>`;
    }
}

/**
 * Saves a managed channel (create or update).
 * @returns {Promise<void>}
 */
async function saveChannelFromForm() {
    const name = document.getElementById('chName').value.trim();
    const url = document.getElementById('chUrl').value.trim();

    if (!name || !url) {
        return toast('请填写渠道名称和接口地址', 'error');
    }

    const saveBtn = document.getElementById('chSaveBtn');

    try {
        await api('/api/admin/channels/save', {
            id: saveBtn.dataset.editId || undefined,
            name,
            type: document.getElementById('chType').value,
            url,
            key: document.getElementById('chKey').value.trim(),
            models: document.getElementById('chModels').value.split(/[,，]/).map(m => m.trim()).filter(Boolean),
            priceInput: parseFloat(document.getElementById('chPriceInput').value) || 0,
            priceOutput: parseFloat(document.getElementById('chPriceOutput').value) || 0,
            enabled: document.getElementById('chEnabled').checked,
        });

        // Reset form
        delete saveBtn.dataset.editId;
        for (const id of ['chName', 'chUrl', 'chKey', 'chModels', 'chPriceInput', 'chPriceOutput']) {
            document.getElementById(id).value = '';
        }
        document.getElementById('chKey').placeholder = 'API Key（留空则不修改）';
        document.getElementById('chEnabled').checked = true;

        toast('渠道已保存 ✓', 'success');
        await loadChannels();
    } catch (error) {
        toast(error.message, 'error');
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
        const currency = data.usage?.currency ?? '¥';

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
                    <div class="uhandle" title="LLM 用量统计">
                        <i class="fa-solid fa-chart-line"></i>
                        ${fmtNumber(user.requests)} 次请求 · ${fmtNumber(user.totalTokens)} tokens · ${fmtCost(user.cost, currency)} · 最近 ${timeAgo(user.lastActive)}
                    </div>
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
// Formatting helpers
// ============================================================

/**
 * Formats a number with a compact CJK suffix.
 * @param {number} value Raw number
 * @returns {string} Formatted number
 */
function fmtNumber(value) {
    const n = Number(value) || 0;

    if (n >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`;
    if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(Math.round(n * 100) / 100);
}

/**
 * Formats a cost value with its currency symbol.
 * @param {number} value Cost
 * @param {string} [currency] Currency symbol
 * @returns {string} Formatted cost
 */
function fmtCost(value, currency = '¥') {
    const n = Number(value) || 0;

    if (!n) return `${currency}0`;
    return `${currency}${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;
}

/**
 * Formats a timestamp as a short relative time.
 * @param {number} timestamp Timestamp in ms
 * @returns {string} Relative time, or an em dash when empty
 */
function timeAgo(timestamp) {
    if (!timestamp) return '—';

    const diff = Date.now() - timestamp;
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;

    if (diff < minute) return '刚刚';
    if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
    if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
    if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
    return new Date(timestamp).toLocaleDateString();
}

/**
 * Renders a single statistics card.
 * @param {string} label Card label
 * @param {string} value Main value
 * @param {string} [sub] Secondary line
 * @param {string} [icon] FontAwesome icon class
 * @returns {string} HTML string
 */
function statCard(label, value, sub = '', icon = '') {
    return `
        <div class="stat-card">
            <div class="stat-label">${icon ? `<i class="fa-solid ${icon}"></i> ` : ''}${esc(label)}</div>
            <div class="stat-value">${esc(value)}</div>
            <div class="stat-sub">${esc(sub)}</div>
        </div>`;
}

/**
 * Renders a simple bar chart out of a daily series.
 * @param {string} containerId Container element id
 * @param {object[]} series Daily data points
 * @param {string} [key] Value key to plot
 * @param {string} [label] Value label used in tooltips
 * @returns {void}
 */
function renderChart(containerId, series, key = 'totalTokens', label = 'tokens') {
    const container = document.getElementById(containerId);
    const points = Array.isArray(series) ? series : [];

    if (!points.length) {
        container.innerHTML = '';
        return;
    }

    const max = Math.max(...points.map(p => Number(p[key]) || 0), 1);

    container.innerHTML = points.map((point) => {
        const value = Number(point[key]) || 0;
        const height = Math.max(Math.round((value / max) * 100), value ? 3 : 0);
        return `
            <div class="chart-col" title="${esc(point.day)} · ${fmtNumber(value)} ${label}">
                <div class="chart-bar-wrap"><div class="chart-bar" style="height:${height}%"></div></div>
                <div class="chart-label">${esc(String(point.day).slice(5))}</div>
            </div>`;
    }).join('');
}

/**
 * Renders a per-model usage table.
 * @param {object[]} models Model rows
 * @param {string} currency Currency symbol
 * @returns {string} HTML string
 */
function renderModelTable(models, currency) {
    if (!models?.length) {
        return '';
    }

    return `
        <div class="chart-title">按模型统计</div>
        <table class="data-table">
            <thead><tr><th>模型</th><th>渠道</th><th>请求</th><th>输入</th><th>输出</th><th>合计</th><th>估算费用</th></tr></thead>
            <tbody>
                ${models.map(m => `
                    <tr>
                        <td class="mono">${esc(m.model)}</td>
                        <td>${esc(m.channel || '—')}</td>
                        <td>${fmtNumber(m.requests)}</td>
                        <td>${fmtNumber(m.promptTokens)}</td>
                        <td>${fmtNumber(m.completionTokens)}</td>
                        <td><b>${fmtNumber(m.totalTokens)}</b></td>
                        <td>${fmtCost(m.cost, currency)}</td>
                    </tr>`).join('')}
            </tbody>
        </table>`;
}

// ============================================================
// Site announcements (站点公告)
// ============================================================

/**
 * Updates the unread counter shown on the announcements tab.
 * @param {number} unread Number of unread announcements
 * @returns {void}
 */
function updateAnnouncementBadge(unread) {
    unreadAnnouncements = Math.max(Number(unread) || 0, 0);
    const badge = document.getElementById('announcementsBadge');

    if (!badge) {
        return;
    }

    badge.textContent = unreadAnnouncements > 99 ? '99+' : String(unreadAnnouncements);
    badge.style.display = unreadAnnouncements ? '' : 'none';
}

/**
 * Fetches the unread count without marking anything as read.
 * @returns {Promise<void>}
 */
async function refreshAnnouncementBadge() {
    try {
        const data = await api('/api/announcements/list');
        updateAnnouncementBadge(data.unread ?? 0);
    } catch {
        // Announcements are a convenience feature: ignore failures
    }
}

/**
 * Renders a single announcement card.
 * @param {object} announcement Announcement view model
 * @returns {HTMLElement} Card element
 */
function renderAnnouncement(announcement) {
    const card = document.createElement('div');
    card.className = `announcement level-${announcement.level}${announcement.read ? '' : ' unread'}`;

    const head = document.createElement('div');
    head.className = 'an-head';

    const title = document.createElement('span');
    title.className = 'an-title';
    title.textContent = announcement.title;

    const meta = document.createElement('span');
    meta.className = 'an-meta';
    meta.innerHTML = `
        ${announcement.pinned ? '<span class="badge"><i class="fa-solid fa-thumbtack"></i> 置顶</span>' : ''}
        ${announcement.read ? '' : '<span class="badge new">未读</span>'}
        <span class="an-date">${timeAgo(announcement.created)}</span>`;

    head.append(title, meta);

    const body = document.createElement('div');
    body.className = 'an-body';
    body.textContent = announcement.body || '';

    card.append(head, body);
    return card;
}

/**
 * Loads and renders the announcements view.
 * @param {boolean} [markRead=false] Whether to mark the announcements as read
 * @returns {Promise<void>}
 */
async function loadAnnouncements(markRead = false) {
    const list = document.getElementById('announcementList');
    document.getElementById('announcementAdmin').style.display = isAdmin ? '' : 'none';

    try {
        const data = await api('/api/announcements/list');
        const items = data.announcements ?? [];

        list.innerHTML = '';

        if (!items.length) {
            list.innerHTML = '<div class="info-card">还没有公告</div>';
        } else {
            for (const announcement of items) {
                list.appendChild(renderAnnouncement(announcement));
            }
        }

        updateAnnouncementBadge(data.unread ?? 0);

        // Opening the view counts as reading it
        if (markRead && unreadAnnouncements) {
            const result = await api('/api/announcements/read', {});
            updateAnnouncementBadge(result.unread ?? 0);
            list.querySelectorAll('.announcement.unread').forEach(el => el.classList.remove('unread'));
            list.querySelectorAll('.badge.new').forEach(el => el.remove());
        }

        if (isAdmin) {
            await loadAnnouncementAdminList();
        }
    } catch (error) {
        list.innerHTML = `<div class="info-card">${esc(error.message)}</div>`;
    }
}

/**
 * Loads the admin announcement management list.
 * @returns {Promise<void>}
 */
async function loadAnnouncementAdminList() {
    const container = document.getElementById('announcementAdminList');

    try {
        const data = await api('/api/announcements/admin/list');
        const items = data.announcements ?? [];

        if (!items.length) {
            container.innerHTML = '<div class="info-card">还没有发过公告</div>';
            return;
        }

        container.innerHTML = '';

        for (const announcement of items) {
            const row = document.createElement('div');
            row.className = 'invite-row';
            row.innerHTML = `
                <div class="invite-code" style="letter-spacing:0; min-width:auto">${esc(announcement.title)}</div>
                <div class="invite-note">
                    ${esc(announcement.levelLabel)} ·
                    ${announcement.pinned ? '置顶' : '普通'} ·
                    ${announcement.enabled ? '已发布' : '已下架'} ·
                    发布于 ${timeAgo(announcement.created)}
                    ${announcement.updated !== announcement.created ? ` · 编辑于 ${timeAgo(announcement.updated)}` : ''}
                </div>
                <div class="channel-actions">
                    <button class="menu_button" data-edit="${esc(announcement.id)}"><i class="fa-solid fa-pen"></i> 编辑</button>
                    <button class="menu_button btn-danger" data-del="${esc(announcement.id)}"><i class="fa-solid fa-trash"></i> 删除</button>
                </div>`;
            container.appendChild(row);
        }

        container.querySelectorAll('[data-edit]').forEach(btn => {
            btn.addEventListener('click', () => {
                const announcement = items.find(a => a.id === btn.dataset.edit);

                if (!announcement) {
                    return;
                }

                document.getElementById('anTitle').value = announcement.title;
                document.getElementById('anLevel').value = announcement.level;
                document.getElementById('anBody').value = announcement.body;
                document.getElementById('anPinned').checked = announcement.pinned;
                document.getElementById('anEnabled').checked = announcement.enabled;
                document.getElementById('anSaveBtn').dataset.editId = announcement.id;
                document.getElementById('anSaveBtn').innerHTML = '<i class="fa-solid fa-floppy-disk"></i> 保存修改';
                toast('已载入公告，修改后点击保存', 'success');
            });
        });

        container.querySelectorAll('[data-del]').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!window.confirm('确定删除这条公告吗？')) {
                    return;
                }

                try {
                    await api('/api/announcements/admin/delete', { id: btn.dataset.del });
                    toast('公告已删除 ✓', 'success');
                    await loadAnnouncements();
                } catch (error) {
                    toast(error.message, 'error');
                }
            });
        });
    } catch (error) {
        container.innerHTML = `<div class="info-card">${esc(error.message)}</div>`;
    }
}

/**
 * Publishes or updates an announcement from the admin form.
 * @returns {Promise<void>}
 */
async function saveAnnouncementFromForm() {
    const title = document.getElementById('anTitle').value.trim();

    if (!title) {
        return toast('请填写公告标题', 'error');
    }

    const saveBtn = document.getElementById('anSaveBtn');

    try {
        await api('/api/announcements/admin/save', {
            id: saveBtn.dataset.editId || undefined,
            title,
            level: document.getElementById('anLevel').value,
            body: document.getElementById('anBody').value.trim(),
            pinned: document.getElementById('anPinned').checked,
            enabled: document.getElementById('anEnabled').checked,
        });

        delete saveBtn.dataset.editId;
        saveBtn.innerHTML = '<i class="fa-solid fa-bullhorn"></i> 发布公告';
        document.getElementById('anTitle').value = '';
        document.getElementById('anBody').value = '';
        document.getElementById('anPinned').checked = false;
        document.getElementById('anEnabled').checked = true;

        toast('公告已发布 ✓', 'success');
        await loadAnnouncements();
    } catch (error) {
        toast(error.message, 'error');
    }
}

// ============================================================
// Usage statistics (用量统计)
// ============================================================

/**
 * Renders the usage cards of a counter set.
 * @param {object} counters Counters of a period
 * @param {string} periodLabel Label of the period
 * @param {string} currency Currency symbol
 * @returns {string} HTML string
 */
function usageCards(counters, periodLabel, currency) {
    return [
        statCard(`${periodLabel}请求`, fmtNumber(counters.requests), `${counters.errors} 次失败`, 'fa-paper-plane'),
        statCard(`${periodLabel}token`, fmtNumber(counters.totalTokens), `输入 ${fmtNumber(counters.promptTokens)} / 输出 ${fmtNumber(counters.completionTokens)}`, 'fa-coins'),
        statCard(`${periodLabel}估算费用`, fmtCost(counters.cost, currency), counters.cost ? '按渠道定价估算' : '渠道未配置定价', 'fa-scale-balanced'),
    ].join('');
}

/**
 * Loads the usage view: the current user's stats, plus site-wide stats for admins.
 * @returns {Promise<void>}
 */
async function loadUsage() {
    const hint = document.getElementById('myUsageHint');
    const cards = document.getElementById('myUsageCards');

    try {
        const data = await api('/api/usage/me');

        if (!data.enabled) {
            hint.innerHTML = '<i class="fa-solid fa-circle-xmark" style="color:var(--gal-danger)"></i> 用量统计未开启（config.yaml 中 usageStats.enabled）';
            cards.innerHTML = '';
            return;
        }

        const currency = data.currency ?? '¥';
        hint.innerHTML = `
            <i class="fa-solid fa-circle-info" style="color:var(--gal-accent)"></i>
            最近使用：<b>${timeAgo(data.lastActive)}</b> ·
            近 14 天活跃 <b>${data.activeDays}</b> 天 ·
            费用为根据渠道定价的估算值，仅供参考`;

        cards.innerHTML = [
            usageCards(data.today, '今日', currency),
            usageCards(data.month, '近 30 天', currency),
            usageCards(data.totals, '累计', currency),
        ].join('');

        renderChart('myUsageChart', data.series, 'totalTokens', 'tokens');
        document.getElementById('myUsageModels').innerHTML = renderModelTable(data.models, currency);

        const siteBlock = document.getElementById('siteUsageBlock');
        siteBlock.style.display = isAdmin ? '' : 'none';

        if (isAdmin) {
            await loadSiteUsage(currency);
        }
    } catch (error) {
        hint.innerHTML = esc(error.message);
        cards.innerHTML = '';
    }
}

/**
 * Loads the site-wide usage section (admins only).
 * @param {string} currency Currency symbol
 * @returns {Promise<void>}
 */
async function loadSiteUsage(currency) {
    try {
        const data = await api('/api/admin/usage');

        if (!data.enabled) {
            return;
        }

        document.getElementById('siteUsageCards').innerHTML = [
            statCard('活跃用户', fmtNumber(data.activeUsers), `保留 ${data.retentionDays} 天明细`, 'fa-users'),
            usageCards(data.totals, '全站', currency),
        ].join('');

        renderChart('siteUsageChart', data.series, 'totalTokens', 'tokens');
        document.getElementById('siteUsageModels').innerHTML = renderModelTable(data.models, currency);

        const users = data.users ?? [];
        document.getElementById('siteUsageUsers').innerHTML = users.length ? `
            <div class="chart-title">用户排行（累计）</div>
            <table class="data-table">
                <thead><tr><th>用户</th><th>最近使用</th><th>请求</th><th>token</th><th>估算费用</th></tr></thead>
                <tbody>
                    ${users.map(u => `
                        <tr>
                            <td>@${esc(u.handle)}</td>
                            <td>${timeAgo(u.lastActive)}</td>
                            <td>${fmtNumber(u.totals.requests)}</td>
                            <td><b>${fmtNumber(u.totals.totalTokens)}</b></td>
                            <td>${fmtCost(u.totals.cost, currency)}</td>
                        </tr>`).join('')}
                </tbody>
            </table>` : '';
    } catch (error) {
        document.getElementById('siteUsageCards').innerHTML = `<div class="info-card">${esc(error.message)}</div>`;
    }
}

// ============================================================
// Gallery comments (作品评论)
// ============================================================

/**
 * Loads and renders the comments of an item.
 * @param {string} itemId Item ID
 * @returns {Promise<void>}
 */
async function loadComments(itemId) {
    const list = document.getElementById('commentList');
    const form = document.getElementById('commentForm');
    list.innerHTML = '<div class="hint">评论加载中…</div>';

    try {
        const data = await galleryApi('comments', { id: itemId });
        const comments = data.comments ?? [];

        commentMaxLength = data.maxLength ?? 1000;
        document.getElementById('commentInput').maxLength = commentMaxLength;
        document.getElementById('commentCounter').textContent = `0 / ${commentMaxLength}`;
        document.getElementById('commentTotal').textContent = data.total ? `共 ${data.total} 条` : '';
        form.style.display = data.allowComments ? '' : 'none';

        if (!comments.length) {
            list.innerHTML = '<div class="hint">还没有评论，来说两句吧～</div>';
            return;
        }

        list.innerHTML = '';

        for (const comment of comments.slice().reverse()) {
            list.appendChild(renderComment(comment, itemId));
        }
    } catch (error) {
        list.innerHTML = `<div class="hint">${esc(error.message)}</div>`;
        form.style.display = 'none';
    }
}

/**
 * Renders a single comment.
 * @param {object} comment Comment view model
 * @param {string} itemId Item ID the comment belongs to
 * @returns {HTMLElement} Comment element
 */
function renderComment(comment, itemId) {
    const row = document.createElement('div');
    row.className = `comment${comment.hidden ? ' hidden-comment' : ''}`;

    const text = document.createElement('div');
    text.className = 'comment-text';
    text.textContent = comment.text;

    const meta = document.createElement('div');
    meta.className = 'comment-meta';
    meta.innerHTML = `
        <b>${esc(comment.authorName)}</b>
        ${comment.isOwner ? '<span class="badge">我</span>' : ''}
        ${comment.hidden ? '<span class="badge warn">已隐藏</span>' : ''}
        <span class="an-date">${timeAgo(comment.created)}</span>
        <span class="comment-actions">
            <button class="link-btn" data-like><i class="fa-solid fa-heart${comment.liked ? ' liked' : ''}"></i> ${comment.likes}</button>
            ${comment.isOwner || comment.canModerate ? '<button class="link-btn" data-del><i class="fa-solid fa-trash"></i> 删除</button>' : ''}
            ${comment.canModerate ? `<button class="link-btn" data-hide>${comment.hidden ? '取消隐藏' : '隐藏'}</button>` : ''}
        </span>`;

    row.append(meta, text);

    meta.querySelector('[data-like]')?.addEventListener('click', async () => {
        try {
            await galleryApi('comment/like', { id: itemId, commentId: comment.id });
            await loadComments(itemId);
        } catch (error) {
            toast(error.message, 'error');
        }
    });

    meta.querySelector('[data-del]')?.addEventListener('click', async () => {
        if (!window.confirm('确定删除这条评论吗？')) {
            return;
        }

        try {
            await galleryApi('comment/delete', { id: itemId, commentId: comment.id });
            toast('评论已删除 ✓', 'success');
            await loadComments(itemId);
        } catch (error) {
            toast(error.message, 'error');
        }
    });

    meta.querySelector('[data-hide]')?.addEventListener('click', async () => {
        try {
            await galleryApi('comment/hide', { id: itemId, commentId: comment.id, hidden: !comment.hidden });
            toast(comment.hidden ? '已取消隐藏 ✓' : '已隐藏 ✓', 'success');
            await loadComments(itemId);
        } catch (error) {
            toast(error.message, 'error');
        }
    });

    return row;
}

/**
 * Posts the comment currently typed in the detail modal.
 * @returns {Promise<void>}
 */
async function postComment() {
    const input = document.getElementById('commentInput');
    const text = input.value.trim();

    if (!text) {
        return toast('评论内容不能为空', 'error');
    }

    const submitBtn = document.getElementById('commentSubmit');
    submitBtn.disabled = true;

    try {
        const data = await galleryApi('comment', { id: currentItem.id, text });
        input.value = '';
        document.getElementById('commentCounter').textContent = `0 / ${commentMaxLength}`;
        document.getElementById('commentTotal').textContent = `共 ${data.total} 条`;
        toast('评论已发布 ✓', 'success');
        await loadComments(currentItem.id);
    } catch (error) {
        toast(error.message, 'error');
    } finally {
        submitBtn.disabled = false;
    }
}

/**
 * Loads the site-wide comment moderation list (admins only).
 * @returns {Promise<void>}
 */
async function loadAdminComments() {
    const container = document.getElementById('adminCommentList');
    const info = document.getElementById('adminCommentInfo');

    try {
        const data = await galleryApi('admin/comments');
        const comments = data.comments ?? [];

        info.innerHTML = `
            <i class="fa-solid fa-comments" style="color:var(--gal-accent)"></i>
            共 <b>${data.total}</b> 条评论 · 已隐藏 <b>${data.hidden}</b> 条
            <small>（只显示最新 ${comments.length} 条）</small>`;

        if (!comments.length) {
            container.innerHTML = '<div class="info-card">还没有评论</div>';
            return;
        }

        container.innerHTML = '';

        for (const comment of comments) {
            const row = document.createElement('div');
            row.className = 'invite-row';

            const body = document.createElement('div');
            body.className = 'comment-text';
            body.textContent = comment.text;

            row.innerHTML = `
                <div class="user-id">
                    <div class="uname">${esc(comment.authorName)} ${comment.hidden ? '<span class="badge warn">已隐藏</span>' : ''}</div>
                    <div class="uhandle">《${esc(comment.itemTitle)}》 · ${timeAgo(comment.created)}</div>
                </div>
                <div class="channel-actions">
                    <button class="menu_button" data-hide><i class="fa-solid fa-eye-slash"></i> ${comment.hidden ? '显示' : '隐藏'}</button>
                    <button class="menu_button btn-danger" data-del><i class="fa-solid fa-trash"></i> 删除</button>
                </div>`;

            const holder = document.createElement('div');
            holder.className = 'invite-note';
            holder.append(body);
            row.insertBefore(holder, row.querySelector('.channel-actions'));

            row.querySelector('[data-hide]')?.addEventListener('click', async () => {
                try {
                    await galleryApi('comment/hide', { id: comment.itemId, commentId: comment.id, hidden: !comment.hidden });
                    toast('已更新 ✓', 'success');
                    await loadAdminComments();
                } catch (error) {
                    toast(error.message, 'error');
                }
            });

            row.querySelector('[data-del]')?.addEventListener('click', async () => {
                if (!window.confirm('确定删除这条评论吗？')) {
                    return;
                }

                try {
                    await galleryApi('comment/delete', { id: comment.itemId, commentId: comment.id });
                    toast('评论已删除 ✓', 'success');
                    await loadAdminComments();
                } catch (error) {
                    toast(error.message, 'error');
                }
            });

            container.appendChild(row);
        }
    } catch (error) {
        info.innerHTML = esc(error.message);
        container.innerHTML = '';
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

    document.getElementById('favoriteBtn').addEventListener('click', async () => {
        try {
            const data = await galleryApi('favorite', { id: currentItem.id });
            currentItem.favorited = data.favorited;
            document.getElementById('favoriteBtn').innerHTML = data.favorited
                ? '<i class="fa-solid fa-star" style="color:var(--gal-accent)"></i> 已收藏'
                : '<i class="fa-solid fa-star" style="opacity:0.55"></i> 收藏';
            toast(data.favorited ? '已收藏 ✓ 在「我的收藏」里可以找到' : '已取消收藏', 'success');
        } catch (error) {
            toast(error.message, 'error');
        }
    });

    document.getElementById('commentSubmit').addEventListener('click', postComment);

    document.getElementById('commentInput').addEventListener('input', (event) => {
        document.getElementById('commentCounter').textContent = `${event.target.value.length} / ${commentMaxLength}`;
    });

    document.getElementById('commentInput').addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            postComment();
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

    // Announcements
    document.getElementById('anSaveBtn').addEventListener('click', saveAnnouncementFromForm);

    document.getElementById('announcementsReadBtn').addEventListener('click', async () => {
        try {
            const result = await api('/api/announcements/read', {});
            updateAnnouncementBadge(result.unread ?? 0);
            document.querySelectorAll('#announcementList .announcement.unread').forEach(el => el.classList.remove('unread'));
            document.querySelectorAll('#announcementList .badge.new').forEach(el => el.remove());
            toast('已全部标为已读 ✓', 'success');
        } catch (error) {
            toast(error.message, 'error');
        }
    });

    // Managed model channels
    document.getElementById('chSaveBtn').addEventListener('click', saveChannelFromForm);
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

    const hashView = window.location.hash.replace(/^#/, '');
    const initialView = ['channels', 'announcements', 'usage', 'admin'].includes(hashView) ? hashView : 'gallery';

    if (initialView === 'gallery') {
        await loadList();
    } else {
        await switchView(initialView);
    }

    await refreshAnnouncementBadge();
}

// Other scripts (e.g. the announcement banner of the main UI) can open a view.
// The switch is deferred until init() is done, so the CSRF token is available.
const ready = init().catch(error => console.error('Gallery init failed:', error));

document.addEventListener('st-gallery-open', (event) => {
    const view = event instanceof CustomEvent ? event.detail?.view : null;

    if (typeof view === 'string') {
        ready.then(() => switchView(view));
    }
});
