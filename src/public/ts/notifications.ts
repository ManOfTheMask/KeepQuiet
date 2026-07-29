export {};

// notifications.ts — global notification bell logic, loaded on every page for logged-in users

interface AppNotification {
    id: string;
    type: 'friend_request' | 'message' | 'group_invite';
    title: string;
    body: string;
    link: string;
    read: boolean;
    createdAt: string;
}

// ── Element refs ──────────────────────────────────────────────────────────────
const notifBell       = document.getElementById('notifBell')       as HTMLButtonElement | null;
const notifBadge      = document.getElementById('notifBadge')      as HTMLSpanElement   | null;
const notifList       = document.getElementById('notifList')       as HTMLUListElement  | null;
const notifMarkAllRead = document.getElementById('notifMarkAllRead') as HTMLButtonElement | null;
const notifDismissAll = document.getElementById('notifDismissAll') as HTMLButtonElement | null;
const browserNotifToggle = document.getElementById('browserNotifToggle') as HTMLInputElement | null;

const BROWSER_NOTIF_SETTING_KEY = 'kq-browser-notifications-enabled';

if (!notifBell || !notifBadge || !notifList) {
    // Not logged in — nothing to do
    throw new Error('Notification bell elements not found.');
}

// ── In-memory store ───────────────────────────────────────────────────────────
let notifications: AppNotification[] = [];

function browserNotificationsEnabled(): boolean {
    return localStorage.getItem(BROWSER_NOTIF_SETTING_KEY) === 'true';
}

function setBrowserNotificationsEnabled(enabled: boolean) {
    localStorage.setItem(BROWSER_NOTIF_SETTING_KEY, enabled ? 'true' : 'false');
}

function emitNotificationsUpdate() {
    window.dispatchEvent(new CustomEvent('kq:notifications:update', {
        detail: { notifications: [...notifications] },
    }));
}

function unreadCount(): number {
    return notifications.filter(n => !n.read).length;
}

function updateBadge() {
    const count = unreadCount();
    if (count > 0) {
        notifBadge!.textContent = count > 99 ? '99+' : String(count);
        notifBadge!.classList.remove('hidden');
    } else {
        notifBadge!.classList.add('hidden');
    }
}

function parseNotificationLink(link: string): { openId: string | null; type: 'dm' | 'group' | null } {
    try {
        const url = new URL(link, window.location.origin);
        return {
            openId: url.searchParams.get('open'),
            type: (url.searchParams.get('type') as 'dm' | 'group' | null) ?? null,
        };
    } catch {
        return { openId: null, type: null };
    }
}

function shouldSuppressInAppNotification(notif: AppNotification): boolean {
    if (!window.location.pathname.startsWith('/chat')) return false;
    const { openId, type } = parseNotificationLink(notif.link);
    if (!openId || (type !== 'dm' && type !== 'group')) return false;

    const current = new URLSearchParams(window.location.search);
    return current.get('open') === openId && current.get('type') === type;
}

function maybeShowBrowserNotification(notif: AppNotification) {
    if (!browserNotificationsEnabled()) return;
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    if (shouldSuppressInAppNotification(notif)) return;

    const n = new Notification(notif.title, {
        body: notif.body || 'Open to view details.',
        tag: `kq-${notif.id}`,
    });

    n.onclick = () => {
        if (notif.link) window.location.href = notif.link;
        window.focus();
        n.close();
    };
}

// ── Render list ───────────────────────────────────────────────────────────────
function renderList() {
    if (notifications.length === 0) {
        notifList!.innerHTML = '<li class="text-center text-sm text-base-content/40 py-6">No notifications</li>';
        return;
    }
    notifList!.innerHTML = '';
    for (const n of notifications) {
        const li = document.createElement('li');
        li.className = `flex flex-col gap-1 px-4 py-3 border-b border-base-300/50 ${n.read ? 'opacity-60' : 'bg-base-200/50'}`;
        li.dataset.id = n.id;

        const icon = n.type === 'friend_request' ? '👤' : n.type === 'group_invite' ? '👥' : '💬';
        const date = new Date(n.createdAt).toLocaleString(undefined, {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        });

        li.innerHTML = `
            <div class="flex items-start gap-2">
                <span class="text-base mt-0.5">${icon}</span>
                <div class="flex-1 min-w-0">
                    <p class="text-sm font-medium leading-snug">${escHtml(n.title)}</p>
                    ${n.body ? `<p class="text-xs text-base-content/60 mt-0.5">${escHtml(n.body)}</p>` : ''}
                    <p class="text-xs text-base-content/40 mt-1">${date}</p>
                </div>
            </div>
            <div class="flex gap-2 mt-1 self-end">
                ${n.link ? `<a href="${escHtml(n.link)}" class="btn btn-xs btn-primary" data-action="go" data-id="${n.id}">Open</a>` : ''}
                ${!n.read ? `<button class="btn btn-xs btn-outline" data-action="read" data-id="${n.id}">Mark read</button>` : ''}
                <button class="btn btn-xs btn-ghost text-error" data-action="dismiss" data-id="${n.id}">Dismiss</button>
            </div>
        `;
        notifList!.appendChild(li);
    }
}

// ── Event delegation on list ──────────────────────────────────────────────────
notifList!.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    const btn = target.closest<HTMLElement>('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action!;
    const id = btn.dataset.id!;

    if (action === 'read') {
        await markRead(id);
    } else if (action === 'dismiss') {
        await dismiss(id);
    } else if (action === 'go') {
        // Mark read silently when navigating, don't block navigation
        markRead(id).catch(() => {});
    }
});

notifMarkAllRead?.addEventListener('click', async () => {
    try {
        await fetch('/notifications/read-all', { method: 'POST' });
        notifications.forEach(n => { n.read = true; });
        updateBadge();
        renderList();
        emitNotificationsUpdate();
    } catch { /* silent */ }
});

notifDismissAll?.addEventListener('click', async () => {
    try {
        await fetch('/notifications', { method: 'DELETE' });
        notifications = [];
        updateBadge();
        renderList();
        emitNotificationsUpdate();
    } catch { /* silent */ }
});

browserNotifToggle?.addEventListener('change', async () => {
    const enabled = browserNotifToggle.checked;
    if (!enabled) {
        setBrowserNotificationsEnabled(false);
        return;
    }

    if (!('Notification' in window)) {
        browserNotifToggle.checked = false;
        setBrowserNotificationsEnabled(false);
        return;
    }

    if (Notification.permission === 'granted') {
        setBrowserNotificationsEnabled(true);
        return;
    }

    const permission = await Notification.requestPermission();
    const allowed = permission === 'granted';
    browserNotifToggle.checked = allowed;
    setBrowserNotificationsEnabled(allowed);
});

async function markRead(id: string) {
    try {
        await fetch(`/notifications/${id}/read`, { method: 'POST' });
        const n = notifications.find(n => n.id === id);
        if (n) n.read = true;
        updateBadge();
        renderList();
        emitNotificationsUpdate();
    } catch { /* silent */ }
}

async function dismiss(id: string) {
    try {
        await fetch(`/notifications/${id}`, { method: 'DELETE' });
        notifications = notifications.filter(n => n.id !== id);
        updateBadge();
        renderList();
        emitNotificationsUpdate();
    } catch { /* silent */ }
}

// ── Initial fetch ─────────────────────────────────────────────────────────────
async function fetchNotifications() {
    try {
        const res = await fetch('/notifications');
        const data = await res.json();
        if (data.success) {
            notifications = data.notifications.map((n: any) => ({
                id: n._id?.toString() ?? n.id,
                type: n.type,
                title: n.title,
                body: n.body ?? '',
                link: n.link ?? '',
                read: n.read,
                createdAt: n.createdAt,
            }));
            updateBadge();
            renderList();
            emitNotificationsUpdate();
        }
    } catch { /* silent */ }
}

fetchNotifications();

window.addEventListener('kq:notifications:refresh', () => {
    void fetchNotifications();
});

if (browserNotifToggle) {
    browserNotifToggle.checked = browserNotificationsEnabled();
}

// Load list when bell dropdown opens
notifBell.addEventListener('click', () => {
    // DaisyUI dropdown opens on focus/click; refresh list on open
    fetchNotifications();
});

// ── WebSocket for real-time pushes ────────────────────────────────────────────
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
let notifWs: WebSocket;
let notifReconnectDelay = 1000;

function connectNotifWs() {
    notifWs = new WebSocket(`${wsProtocol}//${window.location.host}/ws`);

    notifWs.onopen = () => { notifReconnectDelay = 1000; };

    notifWs.onmessage = (event: MessageEvent) => {
        if (event.data === '__ping__') { notifWs.send('__pong__'); return; }
        let data: any;
        try { data = JSON.parse(event.data); } catch { return; }

        if (data.type === 'new_notification') {
            const n = data.notification;
            const notif: AppNotification = {
                id: n.id,
                type: n.type,
                title: n.title,
                body: n.body ?? '',
                link: n.link ?? '',
                read: n.read,
                createdAt: n.createdAt,
            };

            if (shouldSuppressInAppNotification(notif)) {
                return;
            }

            // Prepend so newest is at top
            notifications.unshift(notif);
            updateBadge();
            renderList();
            emitNotificationsUpdate();
            maybeShowBrowserNotification(notif);
        }
    };

    notifWs.onerror = () => {};
    notifWs.onclose = () => {
        setTimeout(() => {
            connectNotifWs();
            notifReconnectDelay = Math.min(notifReconnectDelay * 2, 30_000);
        }, notifReconnectDelay);
    };
}

connectNotifWs();

// ── Helper ────────────────────────────────────────────────────────────────────
function escHtml(str: string) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
