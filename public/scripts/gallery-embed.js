/**
 * Embeds the gallery / site admin page into the main SillyTavern UI as an
 * in-app overlay, so it shares the exact same theme, state and look & feel.
 * Clicking the "作品广场" menu item opens the overlay instead of navigating
 * to a separate page. The standalone /gallery.html still works on its own.
 */

const OVERLAY_ID = 'galOverlay';
const GALLERY_URL = '/gallery.html';

/**
 * Builds the overlay from the gallery page markup and mounts its logic.
 * @returns {Promise<void>}
 */
async function buildOverlay() {
    const response = await fetch(GALLERY_URL, { credentials: 'same-origin' });

    if (!response.ok) {
        window.location.href = GALLERY_URL;
        return;
    }

    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.className = 'gal-overlay';

    for (const child of [...doc.body.children]) {
        // Injected script tags don't execute; the module is imported below
        if (child.tagName === 'SCRIPT') {
            continue;
        }

        overlay.appendChild(child);
    }

    document.body.appendChild(overlay);

    // "返回聊天" closes the overlay instead of navigating away
    overlay.querySelector('#backToChat')?.addEventListener('click', (event) => {
        event.preventDefault();
        closeGallery();
    });

    // Mount and bind the gallery logic into the injected DOM
    await import('./gallery.js');
}

/**
 * Opens the gallery overlay, optionally on a specific view.
 * @param {string|null} [view] View to switch to ('gallery', 'channels', 'announcements', 'usage', 'admin')
 * @returns {Promise<void>}
 */
export async function openGallery(view = null) {
    let overlay = document.getElementById(OVERLAY_ID);

    if (!overlay) {
        await buildOverlay();
        overlay = document.getElementById(OVERLAY_ID);
    }

    overlay?.classList.add('open');

    // The gallery module is loaded at this point, so it can switch views
    if (view) {
        document.dispatchEvent(new CustomEvent('st-gallery-open', { detail: { view } }));
    }
}

/**
 * Closes the gallery overlay.
 * @returns {void}
 */
export function closeGallery() {
    document.getElementById(OVERLAY_ID)?.classList.remove('open');
}

// Bind the main UI menu entries
document.addEventListener('click', (event) => {
    const trigger = event.target instanceof Element
        ? event.target.closest('#option_gallery, [data-gallery-open], [data-gallery-view]')
        : null;

    if (trigger) {
        event.preventDefault();
        openGallery(trigger.dataset.galleryView ?? null);
    }
});

// Escape closes the overlay
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        closeGallery();
    }
});

// Allow opening via URL hash (e.g. /#gallery or /#announcements)
const hashView = window.location.hash.replace(/^#/, '');

if (['gallery', 'channels', 'announcements', 'usage', 'admin'].includes(hashView)) {
    openGallery(hashView === 'gallery' ? null : hashView);
}
