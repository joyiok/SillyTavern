/**
 * 作品广场 (Gallery) frontend.
 * Browse, publish, claim and moderate shared character cards.
 */

let csrfToken = '';
let isAdmin = false;
let currentSort = 'new';
let currentQuery = '';
let currentPage = 1;
let currentItem = null;
let publishingItemId = null;
let selectedChar = null;

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
 * Sends a JSON request to the gallery API.
 * @param {string} endpoint API path (relative to /api/gallery)
 * @param {object} body Request body
 * @returns {Promise<any>} Parsed response
 */
async function api(endpoint, body = {}) {
    const response = await fetch(`/api/gallery/${endpoint}`, {
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
        throw new Error('Not logged in');
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
 * @param {boolean} isError Whether it is an error
 */
function toast(message, isError = false) {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.style.borderColor = isError ? 'var(--danger)' : 'var(--ok)';
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

/**
 * Loads the gallery list and renders it.
 * @returns {Promise<void>}
 */
async function loadList() {
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

        const data = await api('list', body);
        grid.innerHTML = '';
        empty.style.display = data.items.length ? 'none' : 'block';

        for (const item of data.items) {
            grid.appendChild(renderCard(item));
        }
    } catch (error) {
        toast(error.message, true);
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
                <span>❤ ${item.likes ?? 0}</span>
                <span>⬇ ${item.downloads ?? 0}</span>
                ${item.hidden ? '<span class="badge warn">已隐藏</span>' : ''}
                ${item.visibility === 'unlisted' ? '<span class="badge">不公开</span>' : ''}
            </div>
        </div>`;
    card.addEventListener('click', () => openDetail(item.id));
    return card;
}

/**
 * Opens the detail modal for an item.
 * @param {string} itemId Item ID
 * @returns {Promise<void>}
 */
async function openDetail(itemId) {
    try {
        const item = await api('item', { id: itemId });
        currentItem = item;

        document.getElementById('detailCover').src = `/api/gallery/image/${item.id}`;
        document.getElementById('detailTitle').textContent = item.title;
        document.getElementById('detailDesc').textContent = item.description || '（作者很懒，什么都没写）';
        document.getElementById('detailTags').innerHTML = (item.tags ?? []).map(t => `<span class="tag">${esc(t)}</span>`).join('');
        document.getElementById('detailMeta').innerHTML = `
            作者：${esc(item.authorName || item.author)} ·
            版本：v${esc(item.version)} ·
            ❤ <span id="likeCount">${item.likes}</span> ·
            ⬇ ${item.downloads} ·
            发布于 ${new Date(item.created).toLocaleDateString()}`;

        document.getElementById('detailVersions').innerHTML = (item.versions ?? []).slice().reverse()
            .map(v => `<div>v${esc(v.version)} · ${new Date(v.date).toLocaleString()} ${v.note ? '· ' + esc(v.note) : ''}</div>`)
            .join('');

        const likeBtn = document.getElementById('likeBtn');
        likeBtn.textContent = item.liked ? '❤ 已点赞' : '❤ 点赞';

        const claimBtn = document.getElementById('claimBtn');
        claimBtn.textContent = item.claimed ? '⬇ 再领一份' : '⬇ 领取到我的角色';

        const ownerOrAdmin = item.isOwner || isAdmin;
        document.getElementById('editBtn').style.display = item.isOwner ? '' : 'none';
        document.getElementById('deleteBtn').style.display = ownerOrAdmin ? '' : 'none';
        document.getElementById('hideBtn').style.display = isAdmin ? '' : 'none';
        document.getElementById('hideBtn').textContent = item.hidden ? '取消隐藏' : '隐藏';
        document.getElementById('reportBtn').style.display = item.isOwner ? 'none' : '';

        openModal('detailMask');
    } catch (error) {
        toast(error.message, true);
    }
}

/**
 * Loads the current user's characters for the publish dialog.
 * @returns {Promise<void>}
 */
async function loadCharacters() {
    const container = document.getElementById('charList');
    container.innerHTML = '<div class="empty" style="padding:20px">加载中…</div>';

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
        container.innerHTML = '';

        if (!Array.isArray(characters) || !characters.length) {
            container.innerHTML = '<div class="empty" style="padding:20px">你还没有角色卡，先去聊天页创建一个吧</div>';
            return;
        }

        for (const character of characters) {
            const item = document.createElement('div');
            item.className = 'char-item';
            item.innerHTML = `
                <img src="/thumbnail?type=avatar&file=${encodeURIComponent(character.avatar)}&t=${Date.now()}" alt="">
                <span>${esc(character.name)}</span>`;
            item.addEventListener('click', () => {
                container.querySelectorAll('.char-item').forEach(el => el.classList.remove('selected'));
                item.classList.add('selected');
                selectedChar = character.avatar;
                if (!document.getElementById('pubTitle').value) {
                    document.getElementById('pubTitle').value = character.name || '';
                }
            });
            container.appendChild(item);
        }
    } catch (error) {
        container.innerHTML = `<div class="empty" style="padding:20px">${esc(error.message)}</div>`;
    }
}

/**
 * Publishes or updates an item.
 * @returns {Promise<void>}
 */
async function submitPublish() {
    if (!selectedChar) {
        return toast('请先选择一个角色', true);
    }

    const payload = {
        avatar_url: selectedChar,
        title: document.getElementById('pubTitle').value.trim(),
        description: document.getElementById('pubDesc').value.trim(),
        tags: document.getElementById('pubTags').value.split(/[,，]/).map(t => t.trim()).filter(Boolean),
        visibility: document.getElementById('pubVisibility').value,
        note: document.getElementById('pubNote').value.trim(),
    };

    try {
        if (publishingItemId) {
            await api('update', { id: publishingItemId, ...payload });
            toast('已发布新版本 ✓');
        } else {
            await api('publish', payload);
            toast('发布成功 ✓');
        }

        closeModal('publishMask');
        await loadList();
    } catch (error) {
        toast(error.message, true);
    }
}

/**
 * Opens the publish dialog, optionally for updating an existing item.
 * @param {object|null} item Item to update, or null for a new publication
 * @returns {Promise<void>}
 */
async function openPublish(item = null) {
    publishingItemId = item?.id ?? null;
    selectedChar = item?.sourceFile ?? null;

    document.getElementById('publishTitle').textContent = item ? '更新版本' : '发布作品';
    document.getElementById('publishSubmit').textContent = item ? '发布新版本' : '发布';
    document.getElementById('pubTitle').value = item?.title ?? '';
    document.getElementById('pubDesc').value = item?.description ?? '';
    document.getElementById('pubTags').value = (item?.tags ?? []).join(', ');
    document.getElementById('pubVisibility').value = item?.visibility ?? 'public';
    document.getElementById('pubNote').value = '';

    openModal('publishMask');
    await loadCharacters();

    if (selectedChar) {
        const items = document.querySelectorAll('#charList .char-item');
        const characters = [...items];
        // Mark the previously published character as selected
        for (const el of characters) {
            if (el.querySelector('span')?.textContent === item?.cardName) {
                el.classList.add('selected');
            }
        }
    }
}

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

    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            currentSort = tab.dataset.sort;
            currentPage = 1;
            loadList();
        });
    });

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

    document.getElementById('publishBtn').addEventListener('click', () => openPublish(null));
    document.getElementById('publishSubmit').addEventListener('click', submitPublish);

    document.getElementById('claimBtn').addEventListener('click', async () => {
        try {
            const data = await api('claim', { id: currentItem.id });
            toast(`已领取：${data.file_name}.png ✓ 回聊天页刷新角色列表即可看到`);
            await openDetail(currentItem.id);
        } catch (error) {
            toast(error.message, true);
        }
    });

    document.getElementById('likeBtn').addEventListener('click', async () => {
        try {
            await api('like', { id: currentItem.id });
            await openDetail(currentItem.id);
        } catch (error) {
            toast(error.message, true);
        }
    });

    document.getElementById('reportBtn').addEventListener('click', async () => {
        const reason = window.prompt('请输入举报原因：');
        if (reason === null) {
            return;
        }

        try {
            await api('report', { id: currentItem.id, reason });
            toast('已提交举报，管理员会尽快处理 ✓');
        } catch (error) {
            toast(error.message, true);
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
            await api('delete', { id: currentItem.id });
            toast('已删除 ✓');
            closeModal('detailMask');
            await loadList();
        } catch (error) {
            toast(error.message, true);
        }
    });

    document.getElementById('hideBtn').addEventListener('click', async () => {
        try {
            await api('admin/hide', { id: currentItem.id, hidden: !currentItem.hidden });
            toast(currentItem.hidden ? '已取消隐藏 ✓' : '已隐藏 ✓');
            await openDetail(currentItem.id);
        } catch (error) {
            toast(error.message, true);
        }
    });

    document.getElementById('adminBtn').addEventListener('click', () => {
        currentSort = 'new';
        currentQuery = '';
        document.getElementById('searchInput').value = '';
        loadList();
        toast('管理视图：点击作品可进行隐藏 / 删除');
    });
}

/**
 * Initializes the page.
 * @returns {Promise<void>}
 */
async function init() {
    csrfToken = await getCsrfToken();
    bindEvents();

    // Show admin button if the current user is an admin
    try {
        const response = await fetch('/api/users/me', {
            method: 'GET',
            headers: { 'X-CSRF-Token': csrfToken },
            credentials: 'same-origin',
        });

        if (response.ok) {
            const me = await response.json();
            isAdmin = me.admin === true;
            document.getElementById('adminBtn').style.display = isAdmin ? '' : 'none';
        }
    } catch {
        // Ignore: the admin button is only a convenience
    }

    await loadList();
}

init();
