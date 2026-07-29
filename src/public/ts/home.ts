export {};

// ── Add-friend modal ─────────────────────────────────────────────────────────
{
const addFriendBtn = document.getElementById('add-friend-btn');
const modal = document.getElementById('add-friend-modal') as HTMLDialogElement | null;
const sendRequestBtn = document.getElementById('send-request-btn');
const addFriendKey = document.getElementById('add-friend-key') as HTMLTextAreaElement | null;

addFriendBtn?.addEventListener('click', () => modal?.showModal());

sendRequestBtn?.addEventListener('click', async () => {
    const publicKey = addFriendKey?.value.trim();
    if (!publicKey) return;
    sendRequestBtn.textContent = 'Sending…';
    (sendRequestBtn as HTMLButtonElement).disabled = true;
    try {
        const res = await fetch('/friends/request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ publicKey }),
        });
        const data = await res.json();
        if (data.success) {
            modal?.close();
            if (addFriendKey) addFriendKey.value = '';
            showToast('Friend request sent!', 'success');
        } else {
            showToast(data.message ?? 'Failed to send request.', 'error');
        }
    } catch {
        showToast('Network error.', 'error');
    } finally {
        sendRequestBtn.textContent = 'Send Request';
        (sendRequestBtn as HTMLButtonElement).disabled = false;
    }
});
} // end add-friend block

// ── Accept / Decline friend requests ─────────────────────────────────────────
document.getElementById('pending-list')?.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    const btn = target.closest<HTMLButtonElement>('.accept-btn, .decline-btn');
    if (!btn) return;
    const id = btn.dataset.id;
    if (!id) return;

    const isAccept = btn.classList.contains('accept-btn');
    const endpoint = isAccept ? `/friends/accept/${id}` : `/friends/decline/${id}`;
    btn.disabled = true;

    try {
        const res = await fetch(endpoint, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            const li = document.querySelector<HTMLLIElement>(`[data-request-id="${id}"]`);
            li?.remove();
            const remaining = document.querySelectorAll('#pending-list li').length;
            if (remaining === 0) {
                const list = document.getElementById('pending-list');
                list?.closest('.bg-base-200')?.querySelector('ul')?.replaceWith(emptyState('No pending requests'));
            }
            showToast(isAccept ? 'Friend request accepted!' : 'Request declined.', 'success');
        } else {
            showToast(data.message ?? 'Something went wrong.', 'error');
            btn.disabled = false;
        }
    } catch {
        showToast('Network error.', 'error');
        btn.disabled = false;
    }
});

type HomeNotification = {
    id: string;
    title: string;
    body: string;
    link: string;
    createdAt: string;
    read: boolean;
};

wireMarkAllReadButton();
wireDismissAllButton();
wireNotificationItemActions();

window.addEventListener('kq:notifications:update', (event: Event) => {
    const custom = event as CustomEvent;
    const notifications = (custom.detail?.notifications ?? []) as Array<any>;
    const recent = notifications.slice(0, 5).map((n: any) => ({
        id: n.id,
        title: n.title,
        body: n.body ?? '',
        link: n.link ?? '',
        createdAt: new Date(n.createdAt).toLocaleDateString(),
        read: n.read,
    }));

    renderRecentNotifications(recent);
});

void fetchRecentNotifications();
requestNotificationsRefresh();

// ── Helpers ───────────────────────────────────────────────────────────────────
function emptyState(msg: string): HTMLParagraphElement {
    const p = document.createElement('p');
    p.className = 'text-sm text-base-content/30 py-6 text-center';
    p.textContent = msg;
    return p;
}

function renderRecentNotifications(items: HomeNotification[]) {
    const body = document.getElementById('recent-notifications-body');
    if (!body) return;

    const oldList = document.getElementById('notif-list');
    if (oldList) oldList.remove();

    const oldState = body.querySelector('p');
    if (oldState) oldState.remove();

    const markBtn = document.getElementById('mark-all-read-btn');
    const dismissAllBtn = document.getElementById('dismiss-all-notifs-btn');

    if (items.length === 0) {
        body.appendChild(emptyState('All caught up'));
        markBtn?.remove();
        dismissAllBtn?.remove();
        return;
    }

    const header = document.getElementById('recent-notifications-header');
    if (header && (!markBtn || !dismissAllBtn)) {
        const actions = document.createElement('div');
        actions.className = 'flex items-center gap-1';

        const mark = document.createElement('button');
        mark.id = 'mark-all-read-btn';
        mark.className = 'btn btn-ghost btn-xs text-xs';
        mark.textContent = 'Mark all read';

        const dismissAll = document.createElement('button');
        dismissAll.id = 'dismiss-all-notifs-btn';
        dismissAll.className = 'btn btn-ghost btn-xs text-xs text-error';
        dismissAll.textContent = 'Dismiss all';

        actions.appendChild(mark);
        actions.appendChild(dismissAll);
        header.appendChild(actions);

        wireMarkAllReadButton();
        wireDismissAllButton();
    }

    const list = document.createElement('ul');
    list.id = 'notif-list';
    list.className = 'flex flex-col gap-1.5 max-h-56 overflow-y-auto';

    for (const n of items) {
        const li = document.createElement('li');
        li.className = `flex items-center gap-2.5 bg-base-100 rounded-lg px-2.5 py-2 ${n.read ? 'opacity-60' : 'border-l-2 border-primary'}`;
        li.dataset.notifId = n.id;
        li.innerHTML = `
            <div class="flex-1 min-w-0">
                <p class="text-sm font-medium text-base-content truncate leading-tight">${escHtml(n.title)}</p>
                ${n.body ? `<p class="text-xs text-base-content/50 truncate">${escHtml(n.body)}</p>` : ''}
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
                <span class="text-xs text-base-content/30 hidden sm:inline">${escHtml(n.createdAt)}</span>
                ${n.link ? `<a href="${escHtml(n.link)}" class="btn btn-xs btn-ghost text-xs" data-notif-action="view" data-notif-id="${escHtml(n.id)}">View</a>` : ''}
                <button class="btn btn-xs btn-ghost text-error" data-notif-action="dismiss" data-notif-id="${escHtml(n.id)}">Dismiss</button>
            </div>
        `;
        list.appendChild(li);
    }

    body.appendChild(list);
}

function wireDismissAllButton() {
    const btn = document.getElementById('dismiss-all-notifs-btn') as HTMLButtonElement | null;
    if (!btn || btn.dataset.bound === 'true') return;

    btn.dataset.bound = 'true';
    btn.addEventListener('click', async () => {
        try {
            const res = await fetch('/notifications', { method: 'DELETE' });
            if (!res.ok) throw new Error();
            requestNotificationsRefresh();
            showToast('All notifications dismissed.', 'success');
        } catch {
            showToast('Network error.', 'error');
        }
    });
}

function wireNotificationItemActions() {
    const body = document.getElementById('recent-notifications-body');
    if (!body || body.dataset.bound === 'true') return;

    body.dataset.bound = 'true';
    body.addEventListener('click', async (event) => {
        const target = event.target as HTMLElement;
        const actionEl = target.closest<HTMLElement>('[data-notif-action]');
        if (!actionEl) return;

        const action = actionEl.dataset.notifAction;
        const id = actionEl.dataset.notifId;
        if (!id) return;

        if (action === 'view') {
            // Match toolbar behavior: mark read when opening.
            fetch(`/notifications/${id}/read`, { method: 'POST' })
                .then(() => requestNotificationsRefresh())
                .catch(() => undefined);
            return;
        }

        if (action !== 'dismiss') return;

        try {
            const res = await fetch(`/notifications/${id}`, { method: 'DELETE' });
            if (!res.ok) throw new Error();
            requestNotificationsRefresh();
        } catch {
            showToast('Network error.', 'error');
        }
    });
}

async function fetchRecentNotifications() {
    try {
        const res = await fetch('/notifications');
        const data = await res.json();
        if (!data.success) return;

        const recent = (data.notifications ?? []).slice(0, 5).map((n: any) => ({
            id: n._id?.toString() ?? n.id,
            title: n.title,
            body: n.body ?? '',
            link: n.link ?? '',
            createdAt: new Date(n.createdAt).toLocaleDateString(),
            read: n.read,
        }));

        renderRecentNotifications(recent);
    } catch {
        // keep existing server-rendered state when fetch fails
    }
}

function requestNotificationsRefresh() {
    window.dispatchEvent(new CustomEvent('kq:notifications:refresh'));
}

function wireMarkAllReadButton() {
    const btn = document.getElementById('mark-all-read-btn') as HTMLButtonElement | null;
    if (!btn || btn.dataset.bound === 'true') return;

    btn.dataset.bound = 'true';
    btn.addEventListener('click', async () => {
        try {
            const res = await fetch('/notifications/read-all', { method: 'POST' });
            if (!res.ok) throw new Error();
            // Keep recent items visible and let their state turn read/gray.
            requestNotificationsRefresh();
            await fetchRecentNotifications();
            showToast('All notifications marked as read.', 'success');
        } catch {
            showToast('Network error.', 'error');
        }
    });
}

function escHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showToast(message: string, type: 'success' | 'error') {
    const toast = document.createElement('div');
    toast.className = `toast toast-end toast-bottom z-[999]`;
    toast.innerHTML = `<div class="alert alert-${type} text-sm py-2 px-4 shadow-lg">${message}</div>`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}
