/**
 * Site announcements banner for the main SillyTavern UI.
 * Shows unread announcements published by the admins as a dismissible
 * floating banner, and links to the full list inside the gallery overlay.
 * Does nothing when the user is not logged in or the feature is disabled.
 */

const NOTICE_ID = 'siteNotice';
const POLL_INTERVAL = 5 * 60 * 1000;

/** Announcements that are still unread in this page session. */
let queue = [];

/**
 * Fetches the announcements of the current user.
 * @returns {Promise<object[]|null>} Announcements, or null when unavailable
 */
async function fetchAnnouncements() {
    try {
        const tokenResponse = await fetch('/csrf-token', { credentials: 'same-origin' });
        const { token } = await tokenResponse.json();

        const response = await fetch('/api/announcements/list', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
            credentials: 'same-origin',
            body: '{}',
        });

        if (!response.ok) {
            return null;
        }

        const data = await response.json();
        return (data.announcements ?? []).filter(a => !a.read);
    } catch {
        return null;
    }
}

/**
 * Marks an announcement (or all of them) as read.
 * @param {string|null} id Announcement ID, or null for all
 * @returns {Promise<void>}
 */
async function markRead(id = null) {
    try {
        const tokenResponse = await fetch('/csrf-token', { credentials: 'same-origin' });
        const { token } = await tokenResponse.json();

        await fetch('/api/announcements/read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
            credentials: 'same-origin',
            body: JSON.stringify(id ? { id } : {}),
        });
    } catch {
        // Non-critical: the banner simply shows up again later
    }
}

/**
 * Removes the banner from the page.
 * @returns {void}
 */
function hideNotice() {
    document.getElementById(NOTICE_ID)?.remove();
}

/**
 * Opens the announcements view of the gallery overlay.
 * @returns {Promise<void>}
 */
async function openAnnouncementsView() {
    hideNotice();
    const { openGallery } = await import('./gallery-embed.js');
    await openGallery('announcements');
}

/**
 * Renders the banner for the next unread announcement.
 * @returns {void}
 */
function showNext() {
    hideNotice();

    const announcement = queue.shift();

    if (!announcement) {
        return;
    }

    const notice = document.createElement('div');
    notice.id = NOTICE_ID;
    notice.className = `site-notice level-${announcement.level}`;

    const icon = document.createElement('i');
    icon.className = `fa-solid ${announcement.level === 'important' ? 'fa-triangle-exclamation' : 'fa-bullhorn'} fa-lg`;

    const body = document.createElement('div');
    body.className = 'site-notice-body';

    const title = document.createElement('div');
    title.className = 'site-notice-title';
    title.textContent = announcement.title;

    const text = document.createElement('div');
    text.className = 'site-notice-text';
    text.textContent = announcement.body || '';

    const actions = document.createElement('div');
    actions.className = 'site-notice-actions';

    const counter = document.createElement('span');
    counter.className = 'an-date';
    counter.textContent = queue.length ? `还有 ${queue.length} 条未读` : '';

    const allBtn = document.createElement('button');
    allBtn.className = 'link-btn';
    allBtn.textContent = '全部已读';
    allBtn.addEventListener('click', async () => {
        queue = [];
        hideNotice();
        await markRead(null);
    });

    const okBtn = document.createElement('button');
    okBtn.className = 'link-btn';
    okBtn.textContent = '知道了';
    okBtn.addEventListener('click', async () => {
        await markRead(announcement.id);
        showNext();
    });

    const viewBtn = document.createElement('button');
    viewBtn.className = 'link-btn';
    viewBtn.textContent = '查看全部公告';
    viewBtn.addEventListener('click', () => {
        openAnnouncementsView();
    });

    actions.append(counter, allBtn, okBtn, viewBtn);
    body.append(title, text, actions);
    notice.append(icon, body);
    document.body.append(notice);
}

/**
 * Refreshes the banner from the server.
 * @returns {Promise<void>}
 */
async function refresh() {
    const announcements = await fetchAnnouncements();

    if (!announcements) {
        return;
    }

    queue = announcements;
    showNext();
}

// Do not show the banner on top of the login form
if (!document.body.classList.contains('st-page')) {
    setTimeout(refresh, 3000);
    setInterval(refresh, POLL_INTERVAL);
}
