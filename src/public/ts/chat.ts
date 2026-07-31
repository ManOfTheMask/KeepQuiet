// @ts-ignore
import { encryptChatMessage, encryptGroupMessage, decryptMessageWithKey, encryptBinaryForKeys, encryptBinaryStreamForKeys, decryptBinaryMessageWithKey } from '../jslibs/PGPUtils.js';
import { CallManager } from './callManager';

type ConversationType = 'dm' | 'group';

interface CallParticipant {
    userId: string;
    username: string;
    publicKey?: string | null;
}

declare global {
    interface Window {
        __CHAT_CALL_CONFIG__?: {
            iceServers?: RTCIceServer[];
        };
    }
}

// ── Avatar cache ──────────────────────────────────────────────────────────────
const avatarCache = new Map<string, string | null>();

async function fetchAvatar(userId: string): Promise<string | null> {
    if (avatarCache.has(userId)) return avatarCache.get(userId)!;
    try {
        const res = await fetch(`/user/${userId}/avatar`);
        const data = await res.json();
        const url: string | null = data.success && data.profilePicture ? data.profilePicture : null;
        avatarCache.set(userId, url);
        return url;
    } catch {
        avatarCache.set(userId, null);
        return null;
    }
}

// ── State ─────────────────────────────────────────────────────────────────────
let activeConversationId: string | null = null;
let activeConversationType: ConversationType = 'dm';
let activeReceiverPublicKey: string | null = null;
let activeGroupKeyring: string[] = [];   // all members' armored public keys
let activeGroupAdminId: string | null = null;
const currentUserId: string | null =
    document.querySelector<HTMLMetaElement>('meta[name="current-user-id"]')?.content ?? null;

// Track rendered message IDs to deduplicate WebSocket pushes
const renderedMessageIds = new Set<string>();

type MessageReaction = { emoji: string; users: string[] };

type MessageAttachment = {
    attachmentId: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    encryptedSizeBytes: number;
};

type DecryptedAttachmentCacheEntry = {
    blob: Blob;
    objectUrl: string;
};

const ATTACHMENT_PLACEHOLDER_CONTENT = '[Attachment]';
const MAX_CHAT_ATTACHMENT_SIZE_BYTES = 5 * 1024 * 1024 * 1024;
const PREVIEWABLE_MIME_PREFIXES = ['image/', 'video/', 'audio/', 'text/'];
const PREVIEWABLE_MIME_TYPES = new Set(['application/pdf']);

const REACTION_EMOJIS = [
    '😀', '😂', '😍', '🥳', '😎', '🤯', '😭', '😡',
    '👍', '👎', '👏', '🙏', '💯', '🔥', '❤️', '💔',
    '🎉', '✨', '👀', '🤝', '🤔', '🙌', '🥶', '😴',
    '😅', '😬', '🤖', '🍕', '☕', '🐱', '🌈', '🚀',
];

let activeReactionPicker: HTMLDivElement | null = null;
let activeReactionAnchor: HTMLElement | null = null;
let activeReactionMessageId: string | null = null;
const decryptedAttachmentCache = new Map<string, DecryptedAttachmentCacheEntry>();

// PGP credentials — loaded from sessionStorage (populated on login or via unlock overlay)
// Read as functions so they always reflect the latest value after an in-page unlock
function pgpPrivateKey(): string | null { return sessionStorage.getItem('pgpPrivateKey'); }
function pgpPassphrase(): string | null { return sessionStorage.getItem('pgpPassphrase'); }
function pgpPublicKey(): string | null  { return sessionStorage.getItem('pgpPublicKey'); }
function hasCredentials(): boolean { return !!pgpPrivateKey() && !!pgpPassphrase(); }

const callIceServers: RTCIceServer[] = window.__CHAT_CALL_CONFIG__?.iceServers?.length
    ? window.__CHAT_CALL_CONFIG__.iceServers
    : [{ urls: 'stun:stun.l.google.com:19302' }];

let callManager: CallManager | null = null;
let callActive = false;
let callConversationId: string | null = null;
let callConversationType: ConversationType | null = null;
let callMuted = false;
let callCamOff = false;
let callScreenSharing = false;
const callParticipants = new Map<string, CallParticipant>();
let pendingIncomingCall: {
    inviteId: string;
    fromUserId: string;
    fromUsername: string;
    conversationId: string;
    conversationType: ConversationType;
    timeoutMs: number;
} | null = null;

// ── WebSocket ─────────────────────────────────────────────────────────────────
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

let chatWs: WebSocket;
let wsReconnectDelay = 1000; // ms, doubles on each failed attempt up to 30 s

function connectChatWs() {
    chatWs = new WebSocket(`${wsProtocol}//${window.location.host}/ws`);

    chatWs.onopen = () => {
        wsReconnectDelay = 1000; // reset backoff on successful connection
        if (activeConversationId) {
            sendChatPresence('open', activeConversationType, activeConversationId);
        }
        if (callActive && callConversationId && callConversationType) {
            sendCallSignal({
                type: 'call_join',
                conversationType: callConversationType,
                conversationId: callConversationId,
                publicKey: pgpPublicKey(),
            });
            setCallStatus('Reconnected', 'badge-success');
        }
    };

    chatWs.onmessage = async (event: MessageEvent) => {
        // Respond to server keep-alive pings
        if (event.data === '__ping__') {
            chatWs.send('__pong__');
            return;
        }

        let data: any;
        try { data = JSON.parse(event.data); } catch { return; }

        if (data.type === 'call_room_state') {
            await onCallRoomState(data);
            return;
        }

        if (data.type === 'call_user_joined') {
            await onCallUserJoined(data);
            return;
        }

        if (data.type === 'call_user_left') {
            onCallUserLeft(data);
            return;
        }

        if (data.type === 'call_offer') {
            await onCallOffer(data);
            return;
        }

        if (data.type === 'call_answer') {
            await onCallAnswer(data);
            return;
        }

        if (data.type === 'call_ice_candidate') {
            await onCallIceCandidate(data);
            return;
        }

        if (data.type === 'call_error') {
            alert(data.message ?? 'Call signaling error.');
            if (callActive) leaveCall(false);
            return;
        }

        if (data.type === 'call_replaced') {
            leaveCall(false);
            alert('This call was opened in another tab.');
            return;
        }

        if (data.type === 'call_incoming') {
            if (callActive) return;
            pendingIncomingCall = {
                inviteId: data.inviteId,
                fromUserId: data.fromUserId,
                fromUsername: data.fromUsername ?? 'Someone',
                conversationId: data.conversationId,
                conversationType: data.conversationType,
                timeoutMs: typeof data.timeoutMs === 'number' ? data.timeoutMs : 30_000,
            };
            const seconds = Math.max(1, Math.round(pendingIncomingCall.timeoutMs / 1000));
            incomingCallText.textContent = `${pendingIncomingCall.fromUsername} is calling you. This invite expires in ${seconds}s.`;
            incomingCallModal.showModal();
            return;
        }

        if (data.type === 'call_invite_expired') {
            if (pendingIncomingCall?.inviteId === data.inviteId) {
                pendingIncomingCall = null;
                incomingCallModal.close();
            }
            return;
        }

        if (data.type === 'call_declined') {
            if (!callActive) return;
            if (data.conversationId !== callConversationId || data.conversationType !== callConversationType) return;
            const declinedBy = data.byUsername ?? 'A participant';
            setCallStatus(`${declinedBy} declined`, 'badge-warning');
            return;
        }

        if (data.type === 'call_accepted') {
            if (!callActive) return;
            if (data.conversationId !== callConversationId || data.conversationType !== callConversationType) return;
            const acceptedBy = data.byUsername ?? 'A participant';
            setCallStatus(`${acceptedBy} joined`, 'badge-success');
            return;
        }

        if (data.type === 'call_missed') {
            if (!callActive) return;
            if (data.conversationId !== callConversationId || data.conversationType !== callConversationType) return;
            const missedName = data.toUsername ?? 'participant';
            setCallStatus(`No answer from ${missedName}`, 'badge-warning');
            return;
        }

        if (data.type === 'new_message') {
            if (renderedMessageIds.has(data.message.id)) return; // deduplicate
            renderedMessageIds.add(data.message.id);
            if (data.conversationId === activeConversationId) {
                const el = await buildMessageEl(data.message);
                messagesContainer.appendChild(el);
                scrollMessagesToBottom();
                // Mark incoming messages as read immediately since the conversation is open
                void markConversationRead();
            }
        }

        if (data.type === 'message_deleted') {
            if (data.conversationId === activeConversationId) {
                const el = messagesContainer.querySelector<HTMLElement>(`[data-message-id="${data.messageId}"]`);
                if (el) {
                    const bubble = el.querySelector<HTMLElement>('[data-role="message-bubble"]');
                    if (!bubble) return;
                    bubble.className = 'relative max-w-sm px-4 py-2 rounded-2xl text-sm shadow bg-base-200 text-base-content/40 italic';
                    bubble.dataset.messageDeleted = 'true';
                    bubble.innerHTML = '<span class="block text-xs font-semibold mb-1 opacity-70">Deleted</span><span>This message was deleted.</span>';
                    el.querySelector('[data-role="reaction-row"]')?.remove();
                    if (activeReactionMessageId === data.messageId) closeReactionPicker();
                }
            }
        }

        if (data.type === 'new_group_message') {
            if (renderedMessageIds.has(data.message.id)) return;
            renderedMessageIds.add(data.message.id);
            if (data.groupId === activeConversationId) {
                const el = await buildMessageEl(data.message);
                messagesContainer.appendChild(el);
                scrollMessagesToBottom();
                // Mark incoming messages as read immediately since the conversation is open
                void markConversationRead();
            }
        }

        if (data.type === 'group_message_deleted') {
            if (data.groupId === activeConversationId) {
                const el = messagesContainer.querySelector<HTMLElement>(`[data-message-id="${data.messageId}"]`);
                if (el) {
                    const bubble = el.querySelector<HTMLElement>('[data-role="message-bubble"]');
                    if (!bubble) return;
                    bubble.className = 'relative max-w-sm px-4 py-2 rounded-2xl text-sm shadow bg-base-200 text-base-content/40 italic';
                    bubble.dataset.messageDeleted = 'true';
                    bubble.innerHTML = '<span class="block text-xs font-semibold mb-1 opacity-70">Deleted</span><span>This message was deleted.</span>';
                    el.querySelector('[data-role="reaction-row"]')?.remove();
                    if (activeReactionMessageId === data.messageId) closeReactionPicker();
                }
            }
        }

        if (data.type === 'message_reaction_updated') {
            if (data.conversationId === activeConversationId && activeConversationType === 'dm') {
                setMessageReactions(data.messageId, data.reactions ?? []);
            }
        }

        if (data.type === 'group_message_reaction_updated') {
            if (data.groupId === activeConversationId && activeConversationType === 'group') {
                setMessageReactions(data.messageId, data.reactions ?? []);
            }
        }

        // A new member was added to the current group — refresh keyring and member panel
        if (data.type === 'group_member_added' && data.groupId === activeConversationId && activeConversationId) {
            await refreshGroupKeyring(activeConversationId);
            renderMembersPanel(activeConversationId);
        }

        // A member was removed from the current group
        if (data.type === 'group_member_removed' && data.groupId === activeConversationId && activeConversationId) {
            if (data.memberId === currentUserId) {
                // Current user was kicked — close the group view
                closeActiveConversation();
                const item = conversationList.querySelector<HTMLElement>(`.conversation-item[data-id="${data.groupId}"]`);
                item?.remove();
            } else {
                await refreshGroupKeyring(activeConversationId);
                renderMembersPanel(activeConversationId);
            }
        }

        // Group was deleted by admin
        if (data.type === 'group_deleted') {
            const item = conversationList.querySelector<HTMLElement>(`.conversation-item[data-id="${data.groupId}"]`);
            item?.remove();
            if (data.groupId === activeConversationId) closeActiveConversation();
        }

        // Group was renamed
        if (data.type === 'group_renamed') {
            const item = conversationList.querySelector<HTMLElement>(`.conversation-item[data-id="${data.groupId}"]`);
            const fallback = item?.querySelector<HTMLElement>('.font-medium')?.dataset.memberList ?? 'Group Chat';
            const displayName = data.name ?? fallback;
            if (item) {
                const nameSpan = item.querySelector<HTMLElement>('.font-medium');
                if (nameSpan) nameSpan.textContent = displayName;
            }
            if (data.groupId === activeConversationId) {
                chatHeaderName.textContent = displayName;
                membersPanelTitle.textContent = displayName;
            }
        }

        // DM read receipt — another participant read the messages
        if (data.type === 'read_receipt') {
            if (data.conversationId === activeConversationId && activeConversationType === 'dm'
                && data.userId !== currentUserId) {
                updateDmReadIndicators(data.userId, data.username, data.readAt);
            }
        }

        // Group read receipt — a group member read the messages
        if (data.type === 'group_read_receipt') {
            if (data.groupId === activeConversationId && activeConversationType === 'group'
                && data.userId !== currentUserId) {
                updateGroupReadIndicators(data.userId, data.username, data.readAt);
            }
        }
    };

    chatWs.onerror = () => console.warn('[WS] Connection error');
    chatWs.onclose = () => {
        if (callActive) setCallStatus('Reconnecting...', 'badge-warning');
        console.warn(`[WS] Connection closed — reconnecting in ${wsReconnectDelay / 1000}s`);
        setTimeout(() => {
            connectChatWs();
            wsReconnectDelay = Math.min(wsReconnectDelay * 2, 30_000);
        }, wsReconnectDelay);
    };
}

connectChatWs();

// ── Element refs ──────────────────────────────────────────────────────────────
const conversationList   = document.getElementById('conversationList')    as HTMLUListElement;
const newChatBtn         = document.getElementById('newChatBtn')           as HTMLButtonElement;
const newGroupBtn        = document.getElementById('newGroupBtn')          as HTMLButtonElement;
const friendPicker       = document.getElementById('friendPicker')         as HTMLDivElement;
const friendPickerList   = document.getElementById('friendPickerList')     as HTMLUListElement;
const chatHeaderName     = document.getElementById('chatHeaderName')       as HTMLSpanElement;
const messagesContainer  = document.getElementById('messagesContainer')    as HTMLDivElement;
const messagesPlaceholder = document.getElementById('messagesPlaceholder') as HTMLDivElement | null;
const attachmentInput    = document.getElementById('attachmentInput')      as HTMLInputElement;
const attachBtn          = document.getElementById('attachBtn')            as HTMLButtonElement;
const messageInput       = document.getElementById('messageInput')         as HTMLTextAreaElement;
const sendBtn            = document.getElementById('sendBtn')              as HTMLButtonElement;
const closeChatBtn       = document.getElementById('closeChatBtn')         as HTMLButtonElement;
const closeChatModal     = document.getElementById('closeChatModal')       as HTMLDialogElement;
const closeChatDeleteBtn = document.getElementById('closeChatDeleteBtn')   as HTMLButtonElement;
const closeChatOnlyBtn   = document.getElementById('closeChatOnlyBtn')     as HTMLButtonElement;
const closeChatCancelBtn = document.getElementById('closeChatCancelBtn')   as HTMLButtonElement;
const groupMembersBtn    = document.getElementById('groupMembersBtn')      as HTMLButtonElement;
const renameGroupHeaderBtn = document.getElementById('renameGroupHeaderBtn') as HTMLButtonElement;
const groupMembersPanel  = document.getElementById('groupMembersPanel')    as HTMLElement;
const closeMembersPanel  = document.getElementById('closeMembersPanel')    as HTMLButtonElement;
const membersList        = document.getElementById('membersList')          as HTMLUListElement;
const addMemberBtn       = document.getElementById('addMemberBtn')         as HTMLButtonElement;
const leaveGroupBtn      = document.getElementById('leaveGroupBtn')        as HTMLButtonElement;
const newGroupModal      = document.getElementById('newGroupModal')        as HTMLDialogElement;
const groupNameInput     = document.getElementById('groupNameInput')       as HTMLInputElement;
const groupFriendPickerList = document.getElementById('groupFriendPickerList') as HTMLUListElement;
const groupCreateBtn     = document.getElementById('groupCreateBtn')       as HTMLButtonElement;
const groupCreateCancelBtn = document.getElementById('groupCreateCancelBtn') as HTMLButtonElement;
const groupCreateError   = document.getElementById('groupCreateError')     as HTMLParagraphElement;
const addMemberModal     = document.getElementById('addMemberModal')       as HTMLDialogElement;
const addMemberUsernameInput = document.getElementById('addMemberUsernameInput') as HTMLInputElement;
const addMemberFriendList = document.getElementById('addMemberFriendList') as HTMLUListElement;
const addMemberConfirmBtn = document.getElementById('addMemberConfirmBtn') as HTMLButtonElement;
const addMemberCancelBtn  = document.getElementById('addMemberCancelBtn')  as HTMLButtonElement;
const addMemberError      = document.getElementById('addMemberError')      as HTMLParagraphElement;
const renameGroupModal    = document.getElementById('renameGroupModal')    as HTMLDialogElement;
const renameGroupInput    = document.getElementById('renameGroupInput')    as HTMLInputElement;
const renameGroupError    = document.getElementById('renameGroupError')    as HTMLParagraphElement;
const renameGroupConfirmBtn = document.getElementById('renameGroupConfirmBtn') as HTMLButtonElement;
const renameGroupCancelBtn  = document.getElementById('renameGroupCancelBtn')  as HTMLButtonElement;
const renameGroupBtn      = document.getElementById('renameGroupBtn')      as HTMLButtonElement;
const deleteGroupBtn      = document.getElementById('deleteGroupBtn')      as HTMLButtonElement;
const membersPanelTitle   = document.getElementById('membersPanelTitle')   as HTMLElement;
const startCallBtn        = document.getElementById('startCallBtn')         as HTMLButtonElement;
const callPanel           = document.getElementById('callPanel')            as HTMLElement;
const callResizeHandle    = document.getElementById('callResizeHandle')     as HTMLElement;
const chatSplitContainer  = document.getElementById('chatSplitContainer')   as HTMLElement;
const callTitle           = document.getElementById('callTitle')            as HTMLElement;
const callStatusBadge     = document.getElementById('callStatusBadge')      as HTMLElement;
const callVideoGrid       = document.getElementById('callVideoGrid')        as HTMLElement;
const callLocalVideo      = document.getElementById('callLocalVideo')       as HTMLVideoElement;
const callParticipantList = document.getElementById('callParticipantList')  as HTMLUListElement;
const callParticipantCount = document.getElementById('callParticipantCount') as HTMLElement;
const callMuteBtn         = document.getElementById('callMuteBtn')          as HTMLButtonElement;
const callCamBtn          = document.getElementById('callCamBtn')           as HTMLButtonElement;
const callShareBtn        = document.getElementById('callShareBtn')         as HTMLButtonElement;
const callHangupBtn       = document.getElementById('callHangupBtn')        as HTMLButtonElement;
const callCloseBtn        = document.getElementById('callCloseBtn')         as HTMLButtonElement;
const incomingCallModal   = document.getElementById('incomingCallModal')    as HTMLDialogElement;
const incomingCallText    = document.getElementById('incomingCallText')     as HTMLElement;
const incomingCallAcceptBtn = document.getElementById('incomingCallAcceptBtn') as HTMLButtonElement;
const incomingCallDeclineBtn = document.getElementById('incomingCallDeclineBtn') as HTMLButtonElement;

function scrollMessagesToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function normalizeReactions(input: any): MessageReaction[] {
    if (!Array.isArray(input)) return [];
    const normalized: MessageReaction[] = [];

    for (const reaction of input) {
        const emoji = typeof reaction?.emoji === 'string' ? reaction.emoji.trim() : '';
        if (!emoji) continue;

        const users: string[] = [];
        if (Array.isArray(reaction?.users)) {
            const seen = new Set<string>();
            for (const rawUser of reaction.users) {
                const normalizedUser = String(rawUser).trim();
                if (!normalizedUser || seen.has(normalizedUser)) continue;
                seen.add(normalizedUser);
                users.push(normalizedUser);
            }
        }

        if (users.length === 0) continue;
        normalized.push({ emoji, users });
    }

    return normalized.sort((a, b) => b.users.length - a.users.length);
}

function closeReactionPicker() {
    activeReactionPicker?.remove();
    activeReactionPicker = null;
    activeReactionAnchor = null;
    activeReactionMessageId = null;
}

function positionReactionPicker() {
    if (!activeReactionPicker || !activeReactionAnchor) return;

    const anchorRect = activeReactionAnchor.getBoundingClientRect();
    const picker = activeReactionPicker;
    const margin = 8;

    const width = picker.offsetWidth || 224;
    const height = picker.offsetHeight || 180;

    let left = anchorRect.left;
    let top = anchorRect.bottom + margin;

    if (left + width > window.innerWidth - margin) {
        left = window.innerWidth - width - margin;
    }
    if (left < margin) left = margin;

    if (top + height > window.innerHeight - margin) {
        top = anchorRect.top - height - margin;
    }
    if (top < margin) top = margin;

    picker.style.left = `${left}px`;
    picker.style.top = `${top}px`;
}

function openReactionPicker(anchor: HTMLElement, messageId: string) {
    if (activeReactionPicker && activeReactionMessageId === messageId) {
        closeReactionPicker();
        return;
    }
    closeReactionPicker();

    const picker = document.createElement('div');
    picker.className = 'fixed z-50 w-56 max-h-44 overflow-y-auto rounded-xl border border-base-300 bg-base-100 p-2 shadow-2xl';
    picker.setAttribute('role', 'dialog');
    picker.setAttribute('aria-label', 'Emoji reactions');

    const grid = document.createElement('div');
    grid.className = 'grid grid-cols-4 gap-1';

    for (const emoji of REACTION_EMOJIS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-sm h-9 min-h-0 rounded-lg px-0';
        btn.textContent = emoji;
        btn.title = `React with ${emoji}`;
        btn.onclick = (event) => {
            event.preventDefault();
            event.stopPropagation();
            closeReactionPicker();
            void toggleMessageReaction(messageId, emoji);
        };
        grid.appendChild(btn);
    }

    picker.appendChild(grid);
    document.body.appendChild(picker);

    activeReactionPicker = picker;
    activeReactionAnchor = anchor;
    activeReactionMessageId = messageId;
    positionReactionPicker();
}

function renderReactionRow(messageEl: HTMLElement, reactions: MessageReaction[]) {
    const bubble = messageEl.querySelector<HTMLElement>('[data-role="message-bubble"]');
    if (!bubble || bubble.dataset.messageDeleted === 'true') {
        messageEl.querySelector('[data-role="reaction-row"]')?.remove();
        return;
    }

    const messageId = messageEl.dataset.messageId;
    if (!messageId) return;

    const isMine = currentUserId && messageEl.dataset.senderId === currentUserId;

    let row = messageEl.querySelector<HTMLElement>('[data-role="reaction-row"]');
    if (!row) {
        row = document.createElement('div');
        row.dataset.role = 'reaction-row';
        row.className = `mt-1 flex flex-wrap items-center gap-1 px-1 ${isMine ? 'justify-end' : 'justify-start'}`;
        const timeEl = messageEl.querySelector<HTMLElement>('[data-role="message-time"]');
        if (timeEl) {
            messageEl.insertBefore(row, timeEl);
        } else {
            messageEl.appendChild(row);
        }
    }

    row.innerHTML = '';

    for (const reaction of reactions) {
        const reactedByMe = !!currentUserId && reaction.users.includes(currentUserId);
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = reactedByMe
            ? 'btn btn-xs h-7 min-h-0 rounded-full border-primary bg-primary/15 px-2 text-primary'
            : 'btn btn-xs h-7 min-h-0 rounded-full border-base-300 bg-base-100 px-2';
        chip.textContent = `${reaction.emoji} ${reaction.users.length}`;
        chip.title = `Toggle ${reaction.emoji}`;
        chip.onclick = () => void toggleMessageReaction(messageId, reaction.emoji);
        row.appendChild(chip);
    }

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.dataset.role = 'reaction-add-btn';
    addBtn.className = 'btn btn-xs h-7 min-h-0 rounded-full border-base-300 bg-base-100 px-2';
    addBtn.textContent = '🙂+';
    addBtn.title = 'Add reaction';
    addBtn.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        openReactionPicker(addBtn, messageId);
    };
    row.appendChild(addBtn);
}

function setMessageReactions(messageId: string, reactionsInput: any) {
    const messageEl = messagesContainer.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
    if (!messageEl) return;
    renderReactionRow(messageEl, normalizeReactions(reactionsInput));
}

async function toggleMessageReaction(messageId: string, emoji: string) {
    if (!activeConversationId) return;

    const url = activeConversationType === 'group'
        ? `/group/${activeConversationId}/messages/${messageId}/reactions`
        : `/chat/${activeConversationId}/messages/${messageId}/reactions`;

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ emoji }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.message);
        setMessageReactions(messageId, data.reactions ?? []);
    } catch (err: any) {
        alert(err.message);
    }
}

document.addEventListener('click', (event) => {
    if (!activeReactionPicker) return;
    const target = event.target as Node | null;
    if (!target) return;
    if (activeReactionPicker.contains(target)) return;
    if (activeReactionAnchor?.contains(target)) return;
    closeReactionPicker();
}, true);

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeReactionPicker();
});

let isResizingCallPanel = false;

function showCallPanel() {
    callPanel.classList.remove('hidden');
    callResizeHandle.classList.remove('hidden');
    if (!callPanel.style.height) callPanel.style.height = '340px';
}

function hideCallPanel() {
    callPanel.classList.add('hidden');
    callResizeHandle.classList.add('hidden');
    callPanel.style.removeProperty('height');
}

function clampCallPanelHeight(height: number): number {
    const total = chatSplitContainer.clientHeight;
    const minCall = 220;
    const minMessages = 220;
    const maxCall = Math.max(minCall, total - minMessages);
    return Math.max(minCall, Math.min(height, maxCall));
}

function setCallPanelHeight(height: number) {
    callPanel.style.height = `${clampCallPanelHeight(height)}px`;
}

callResizeHandle.addEventListener('mousedown', (event) => {
    if (callPanel.classList.contains('hidden')) return;
    isResizingCallPanel = true;
    event.preventDefault();
});

window.addEventListener('mousemove', (event) => {
    if (!isResizingCallPanel || callPanel.classList.contains('hidden')) return;
    const containerRect = chatSplitContainer.getBoundingClientRect();
    const proposed = event.clientY - containerRect.top;
    setCallPanelHeight(proposed);
});

window.addEventListener('mouseup', () => {
    isResizingCallPanel = false;
});

window.addEventListener('resize', () => {
    if (activeReactionPicker) positionReactionPicker();
    if (callPanel.classList.contains('hidden')) return;
    if (!callPanel.style.height) return;
    setCallPanelHeight(parseFloat(callPanel.style.height));
});

function sendCallSignal(payload: any) {
    if (chatWs.readyState !== WebSocket.OPEN) return;
    chatWs.send(JSON.stringify(payload));
}

function sendChatPresence(action: 'open' | 'close', conversationType?: ConversationType, conversationId?: string) {
    if (chatWs.readyState !== WebSocket.OPEN) return;

    const payload: any = { type: 'chat_presence', action };
    if (action === 'open') {
        payload.conversationType = conversationType;
        payload.conversationId = conversationId;
    }
    chatWs.send(JSON.stringify(payload));
}

function setCallStatus(text: string, badgeClass: string) {
    callStatusBadge.textContent = text;
    callStatusBadge.className = `badge ${badgeClass} badge-sm`;
}

function updateCallParticipantCount() {
    callParticipantCount.textContent = `${callParticipants.size + 1} in call`;
}

function renderCallParticipantList() {
    callParticipantList.innerHTML = '';
    for (const participant of callParticipants.values()) {
        const li = document.createElement('li');
        li.className = 'px-2 py-1 rounded bg-base-200/60 truncate';
        li.dataset.userId = participant.userId;
        li.textContent = participant.username;
        callParticipantList.appendChild(li);
    }
    updateCallParticipantCount();
}

function getRemoteTile(peerId: string): HTMLElement | null {
    return document.getElementById(`call-tile-${peerId}`);
}

function removeRemoteTile(peerId: string) {
    getRemoteTile(peerId)?.remove();
}

function ensureRemoteTile(peerId: string, username: string): HTMLVideoElement {
    const existing = getRemoteTile(peerId);
    if (existing) return existing.querySelector('video') as HTMLVideoElement;

    const tile = document.createElement('div');
    tile.id = `call-tile-${peerId}`;
    tile.className = 'relative bg-base-200 rounded-lg overflow-hidden aspect-video border border-base-300';

    const video = document.createElement('video');
    video.id = `call-video-${peerId}`;
    video.autoplay = true;
    video.playsInline = true;
    video.className = 'w-full h-full object-cover';

    const label = document.createElement('div');
    label.className = 'absolute bottom-2 left-2 bg-black/60 text-white text-xs px-2 py-1 rounded';
    label.textContent = username;

    const overlay = document.createElement('div');
    overlay.id = `call-overlay-${peerId}`;
    overlay.className = 'absolute inset-0 flex items-center justify-center bg-base-300/80 text-xs';
    overlay.textContent = 'Connecting...';

    tile.appendChild(video);
    tile.appendChild(label);
    tile.appendChild(overlay);
    callVideoGrid.appendChild(tile);

    return video;
}

function hideRemoteOverlay(peerId: string) {
    document.getElementById(`call-overlay-${peerId}`)?.remove();
}

function buildCallManager(): CallManager {
    return new CallManager({
        iceServers: callIceServers,
        onTrack: (peerId, stream) => {
            const participant = callParticipants.get(peerId);
            const video = ensureRemoteTile(peerId, participant?.username ?? 'Participant');
            video.srcObject = stream;
            void video.play().catch(() => undefined);
            hideRemoteOverlay(peerId);
        },
        onIceCandidate: (peerId, candidate) => {
            if (!callActive || !callConversationId || !callConversationType) return;
            sendCallSignal({
                type: 'call_ice_candidate',
                conversationType: callConversationType,
                conversationId: callConversationId,
                to: peerId,
                candidate,
            });
        },
        onConnectionState: (peerId, state) => {
            if (state === 'connected') hideRemoteOverlay(peerId);
            if (state === 'disconnected' || state === 'failed' || state === 'closed') {
                removeRemoteTile(peerId);
            }
        },
    });
}

async function startCall(params?: {
    conversationId?: string;
    conversationType?: ConversationType;
    title?: string;
    sendInvite?: boolean;
}) {
    const targetConversationId = params?.conversationId ?? activeConversationId;
    const targetConversationType = params?.conversationType ?? activeConversationType;
    const sendInvite = params?.sendInvite ?? false;

    if (!targetConversationId) {
        alert('Open a conversation first.');
        return;
    }
    if (callActive) {
        showCallPanel();
        return;
    }

    callConversationId = targetConversationId;
    callConversationType = targetConversationType;
    callParticipants.clear();
    renderCallParticipantList();

    callManager = buildCallManager();
    setCallStatus('Connecting...', 'badge-warning');
    callTitle.textContent = params?.title ?? `Encrypted Call: ${chatHeaderName.textContent ?? 'Chat'}`;
    showCallPanel();
    setCallPanelHeight(340);

    try {
        const localStream = await callManager.ensureLocalMedia(true, true);
        localStream.getVideoTracks().forEach((track) => { track.enabled = false; });
        callLocalVideo.srcObject = localStream;
        void callLocalVideo.play().catch(() => undefined);
        callMuted = false;
        callCamOff = true;
        callScreenSharing = false;
        callMuteBtn.textContent = '🎙️ Mute';
        callCamBtn.textContent = '📹 Enable Cam';
        callShareBtn.textContent = '🖥️ Share Screen';
    } catch (err: any) {
        callManager.closeAll();
        callManager = null;
        callConversationId = null;
        callConversationType = null;
        hideCallPanel();
        alert(`Unable to start media devices: ${err?.message ?? 'Unknown error'}`);
        return;
    }

    callActive = true;
    if (sendInvite) {
        sendCallSignal({
            type: 'call_invite',
            conversationType: callConversationType,
            conversationId: callConversationId,
        });
    }

    sendCallSignal({
        type: 'call_join',
        conversationType: callConversationType,
        conversationId: callConversationId,
        publicKey: pgpPublicKey(),
    });
}

function leaveCall(notifyServer = true) {
    if (!callActive) return;

    if (notifyServer && callConversationId && callConversationType) {
        sendCallSignal({
            type: 'call_leave',
            conversationType: callConversationType,
            conversationId: callConversationId,
        });
    }

    callManager?.closeAll();
    callManager = null;
    callParticipants.clear();
    renderCallParticipantList();

    for (const tile of Array.from(callVideoGrid.querySelectorAll('[id^="call-tile-"]'))) {
        tile.remove();
    }

    callActive = false;
    callConversationId = null;
    callConversationType = null;
    callMuted = false;
    callCamOff = false;
    callScreenSharing = false;
    callShareBtn.textContent = '🖥️ Share Screen';
    callCamBtn.textContent = '📹 Enable Cam';
    hideCallPanel();
    setCallStatus('Disconnected', 'badge-error');
}

async function onCallRoomState(data: any) {
    if (!callActive || !callConversationId || !callConversationType || !callManager) return;
    if (data.conversationId !== callConversationId || data.conversationType !== callConversationType) return;

    setCallStatus('Connected', 'badge-success');
    const participants: CallParticipant[] = Array.isArray(data.participants) ? data.participants : [];

    callParticipants.clear();
    for (const participant of participants) {
        if (!participant?.userId) continue;
        callParticipants.set(participant.userId, {
            userId: participant.userId,
            username: participant.username ?? 'Participant',
            publicKey: participant.publicKey ?? null,
        });
        ensureRemoteTile(participant.userId, participant.username ?? 'Participant');
        const pendingStream = callManager.getRemoteStream(participant.userId);
        if (pendingStream) {
            const el = document.getElementById(`call-video-${participant.userId}`) as HTMLVideoElement | null;
            if (el) {
                el.srcObject = pendingStream;
                void el.play().catch(() => undefined);
                hideRemoteOverlay(participant.userId);
            }
        }
    }
    renderCallParticipantList();
}

async function onCallUserJoined(data: any) {
    if (!callActive || !callConversationId || !callConversationType || !callManager) return;
    if (data.conversationId !== callConversationId || data.conversationType !== callConversationType) return;
    if (!data.userId || data.userId === currentUserId) return;

    callParticipants.set(data.userId, {
        userId: data.userId,
        username: data.username ?? 'Participant',
        publicKey: data.publicKey ?? null,
    });
    renderCallParticipantList();
    ensureRemoteTile(data.userId, data.username ?? 'Participant');

    const offer = await callManager.createOffer(data.userId);
    sendCallSignal({
        type: 'call_offer',
        conversationType: callConversationType,
        conversationId: callConversationId,
        to: data.userId,
        offer,
    });
}

function onCallUserLeft(data: any) {
    if (!callActive || !callConversationId || !callConversationType || !callManager) return;
    if (data.conversationId !== callConversationId || data.conversationType !== callConversationType) return;
    if (!data.userId) return;

    callParticipants.delete(data.userId);
    renderCallParticipantList();
    removeRemoteTile(data.userId);
    callManager.closePeer(data.userId);
}

async function onCallOffer(data: any) {
    if (!callActive || !callConversationId || !callConversationType || !callManager) return;
    if (data.conversationId !== callConversationId || data.conversationType !== callConversationType) return;
    if (!data.from || !data.offer) return;

    if (!callParticipants.has(data.from)) {
        callParticipants.set(data.from, {
            userId: data.from,
            username: 'Participant',
            publicKey: null,
        });
        renderCallParticipantList();
    }

    ensureRemoteTile(data.from, callParticipants.get(data.from)?.username ?? 'Participant');
    const answer = await callManager.receiveOffer(data.from, data.offer);
    sendCallSignal({
        type: 'call_answer',
        conversationType: callConversationType,
        conversationId: callConversationId,
        to: data.from,
        answer,
    });
}

async function onCallAnswer(data: any) {
    if (!callActive || !callConversationId || !callConversationType || !callManager) return;
    if (data.conversationId !== callConversationId || data.conversationType !== callConversationType) return;
    if (!data.from || !data.answer) return;
    await callManager.receiveAnswer(data.from, data.answer);
}

async function onCallIceCandidate(data: any) {
    if (!callActive || !callConversationId || !callConversationType || !callManager) return;
    if (data.conversationId !== callConversationId || data.conversationType !== callConversationType) return;
    if (!data.from || !data.candidate) return;
    await callManager.receiveIceCandidate(data.from, data.candidate);
}

startCallBtn.onclick = () => {
    void startCall({ sendInvite: true });
};
callHangupBtn.onclick = () => {
    leaveCall(true);
};
callCloseBtn.onclick = () => {
    leaveCall(true);
};
callMuteBtn.onclick = () => {
    if (!callManager) return;
    callMuted = callManager.toggleMute();
    callMuteBtn.textContent = callMuted ? '🔇 Unmute' : '🎙️ Mute';
};
callCamBtn.onclick = () => {
    if (!callManager) return;
    callCamOff = callManager.toggleCam();
    callCamBtn.textContent = callCamOff ? '📹 Enable Cam' : '📹 Camera On';
};

callShareBtn.onclick = async () => {
    if (!callManager) return;
    try {
        const activelySharing = callManager.isScreenSharing();
        if (!activelySharing) {
            const screenTrack = await callManager.startScreenShare(() => {
                callScreenSharing = false;
                callShareBtn.textContent = '🖥️ Share Screen';
                const stream = callManager?.getLocalStream();
                if (stream) {
                    callLocalVideo.srcObject = stream;
                    void callLocalVideo.play().catch(() => undefined);
                }
            });

            const localStream = callManager.getLocalStream();
            if (localStream) {
                callLocalVideo.srcObject = localStream;
                void callLocalVideo.play().catch(() => undefined);
            } else {
                const preview = new MediaStream([screenTrack]);
                callLocalVideo.srcObject = preview;
                void callLocalVideo.play().catch(() => undefined);
            }

            callScreenSharing = true;
            callShareBtn.textContent = '🛑 Stop Share';
            return;
        }

        await callManager.stopScreenShare();
        if (callCamOff) {
            callManager.getLocalStream()?.getVideoTracks().forEach((t) => { t.enabled = false; });
        }
        const stream = callManager.getLocalStream();
        if (stream) {
            callLocalVideo.srcObject = stream;
            void callLocalVideo.play().catch(() => undefined);
        }
        callScreenSharing = false;
        callShareBtn.textContent = '🖥️ Share Screen';
    } catch (err: any) {
        const msg = (err?.message ?? '').toLowerCase();
        if (msg.includes('no display track') || msg.includes('no screen') || msg.includes('cancel')) {
            callScreenSharing = false;
            callShareBtn.textContent = '🖥️ Share Screen';
            return;
        }
        alert(err?.message ?? 'Unable to share screen.');
    }
};

incomingCallAcceptBtn.onclick = async () => {
    if (!pendingIncomingCall) return;
    const invite = pendingIncomingCall;
    pendingIncomingCall = null;
    incomingCallModal.close();

    const selector = `.conversation-item[data-id="${invite.conversationId}"][data-type="${invite.conversationType}"]`;
    const item = conversationList.querySelector<HTMLElement>(selector);
    if (!item) {
        alert('The conversation for this call is unavailable.');
        return;
    }

    if (invite.conversationType === 'group') {
        await openGroupConversation(invite.conversationId, item);
    } else {
        await openConversation(invite.conversationId, item);
    }

    await startCall({
        conversationId: invite.conversationId,
        conversationType: invite.conversationType,
        title: `Encrypted Call: ${invite.fromUsername}`,
        sendInvite: false,
    });
};

incomingCallDeclineBtn.onclick = () => {
    if (!pendingIncomingCall) return;
    const invite = pendingIncomingCall;
    sendCallSignal({
        type: 'call_decline',
        inviteId: invite.inviteId,
        toUserId: invite.fromUserId,
        conversationType: invite.conversationType,
        conversationId: invite.conversationId,
    });
    pendingIncomingCall = null;
    incomingCallModal.close();
};

// ── Conversation list: click to open ─────────────────────────────────────────
conversationList.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    // Pin button
    const pinBtn = target.closest<HTMLElement>('.pin-btn');
    if (pinBtn) {
        const item = pinBtn.closest<HTMLElement>('.conversation-item')!;
        togglePin(item.dataset.id!, item.dataset.type as 'dm' | 'group', item, pinBtn);
        return;
    }

    // Mute button
    const muteBtn = target.closest<HTMLElement>('.mute-btn');
    if (muteBtn) {
        const item = muteBtn.closest<HTMLElement>('.conversation-item')!;
        toggleMute(item.dataset.id!, item.dataset.type as 'dm' | 'group', item, muteBtn);
        return;
    }

    // Conversation row
    const item = target.closest<HTMLElement>('.conversation-item');
    if (!item) return;

    if (item.dataset.type === 'group') {
        openGroupConversation(item.dataset.id!, item);
    } else {
        openConversation(item.dataset.id!, item);
    }
});

async function openConversation(id: string, item: HTMLElement) {
    if (callActive && (callConversationId !== id || callConversationType !== 'dm')) {
        leaveCall(true);
    }

    // Highlight active item
    document.querySelectorAll('.conversation-item').forEach(el => el.classList.remove('bg-base-200'));
    item.classList.add('bg-base-200');

    activeConversationId = id;
    activeConversationType = 'dm';
    activeReceiverPublicKey = null;
    activeGroupKeyring = [];
    activeGroupAdminId = null;
    chatHeaderName.textContent = item.querySelector('.font-medium')?.textContent ?? 'Chat';
    chatHeaderName.classList.remove('text-base-content/40', 'italic');
    closeChatBtn.classList.remove('hidden');
    startCallBtn.classList.remove('hidden');
    groupMembersBtn.classList.add('hidden');
    renameGroupHeaderBtn.classList.add('hidden');
    groupMembersPanel.classList.add('hidden');

    messageInput.disabled = false;
    sendBtn.disabled = false;
    attachBtn.disabled = false;
    messageInput.focus();

    // Fetch recipient public key from server (avoids HTML-attribute encoding issues)
    try {
        const keyRes = await fetch(`/chat/${id}/recipient-key`);
        const keyData = await keyRes.json();
        if (keyData.success && keyData.publicKeyArmored) {
            activeReceiverPublicKey = keyData.publicKeyArmored;
        }
    } catch {
        // Non-fatal: send will show an error if key is still null
    }

    renderedMessageIds.clear();
    avatarCache.clear();
    loadMessages(id);
    void markConversationRead();
    sendChatPresence('open', 'dm', id);
}

async function openGroupConversation(id: string, item: HTMLElement) {
    if (callActive && (callConversationId !== id || callConversationType !== 'group')) {
        leaveCall(true);
    }

    document.querySelectorAll('.conversation-item').forEach(el => el.classList.remove('bg-base-200'));
    item.classList.add('bg-base-200');

    activeConversationId = id;
    activeConversationType = 'group';
    activeReceiverPublicKey = null;
    activeGroupKeyring = [];
    activeGroupAdminId = item.dataset.adminId ?? null;
    chatHeaderName.textContent = item.querySelector('.font-medium')?.textContent ?? 'Group Chat';
    chatHeaderName.classList.remove('text-base-content/40', 'italic');
    closeChatBtn.classList.add('hidden');        // no "close" for groups — use Leave instead
    startCallBtn.classList.remove('hidden');
    groupMembersBtn.classList.remove('hidden');
    renameGroupHeaderBtn.classList.remove('hidden');

    messageInput.disabled = false;
    sendBtn.disabled = false;
    attachBtn.disabled = false;
    messageInput.focus();

    renderedMessageIds.clear();
    avatarCache.clear();

    await refreshGroupKeyring(id);
    loadGroupMessages(id);
    void markConversationRead();
    sendChatPresence('open', 'group', id);
}

// ── Group helpers ─────────────────────────────────────────────────────────────
async function refreshGroupKeyring(groupId: string) {
    try {
        const res = await fetch(`/group/${groupId}/keyring`);
        const data = await res.json();
        if (data.success) activeGroupKeyring = data.keys;
    } catch { /* non-fatal */ }
}

async function loadGroupMessages(groupId: string) {
    messagesContainer.innerHTML = '<div class="m-auto text-base-content/30 text-sm">Loading...</div>';
    try {
        const res = await fetch(`/group/${groupId}/messages`);
        const data = await res.json();
        if (!data.success) throw new Error(data.message);
        await renderMessages(data.messages);
    } catch (err: any) {
        messagesContainer.innerHTML = `<div class="m-auto text-error text-sm">${err.message}</div>`;
    }
}

async function renderMembersPanel(groupId: string) {
    groupMembersPanel.classList.remove('hidden');
    membersList.innerHTML = '<li class="text-xs text-base-content/40 italic p-2">Loading...</li>';
    try {
        const res = await fetch(`/group/${groupId}/info`);
        const data = await res.json();
        if (!data.success) throw new Error(data.message);
        const group = data.group;
        activeGroupAdminId = group.adminId?._id?.toString() ?? group.adminId?.toString() ?? null;

        // Panel title: group name or member list
        const memberNames = group.members.map((m: any) => m.userId.username).join(', ');
        membersPanelTitle.textContent = group.name ?? memberNames;

        // Show delete button only for admin
        if (currentUserId === activeGroupAdminId) {
            deleteGroupBtn.classList.remove('hidden');
        } else {
            deleteGroupBtn.classList.add('hidden');
        }

        membersList.innerHTML = '';
        for (const m of group.members) {
            const li = document.createElement('li');
            li.className = 'flex items-center justify-between gap-2 px-2 py-1 rounded hover:bg-base-200';
            const isAdmin = m.userId._id.toString() === activeGroupAdminId;
            const isSelf  = m.userId._id.toString() === currentUserId;
            const canKick = currentUserId === activeGroupAdminId && !isSelf;

            li.innerHTML = `
                <span class="text-sm truncate">${escHtml(m.userId.username)}${isAdmin ? ' <span class="text-xs opacity-50">(admin)</span>' : ''}</span>
                ${canKick ? `<button class="btn btn-xs btn-error kick-btn" data-member-id="${m.userId._id}">Kick</button>` : ''}
            `;
            membersList.appendChild(li);
        }

        // Kick buttons
        membersList.querySelectorAll<HTMLButtonElement>('.kick-btn').forEach(btn => {
            btn.onclick = () => kickMember(groupId, btn.dataset.memberId!);
        });
    } catch (err: any) {
        membersList.innerHTML = `<li class="text-xs text-error p-2">${err.message}</li>`;
    }
}

async function kickMember(groupId: string, memberId: string) {
    if (!confirm('Remove this member from the group?')) return;
    try {
        const res = await fetch(`/group/${groupId}/members/${memberId}`, { method: 'DELETE' });
        const data = await res.json();
        if (!data.success) throw new Error(data.message);
        renderMembersPanel(groupId);
    } catch (err: any) {
        alert(err.message);
    }
}

// ── Load messages ─────────────────────────────────────────────────────────────
async function loadMessages(conversationId: string) {
    messagesContainer.innerHTML = '<div class="m-auto text-base-content/30 text-sm">Loading...</div>';

    try {
        const res = await fetch(`/chat/${conversationId}/messages`);
        const data = await res.json();
        if (!data.success) throw new Error(data.message);

        await renderMessages(data.messages);
    } catch (err: any) {
        messagesContainer.innerHTML = `<div class="m-auto text-error text-sm">${err.message}</div>`;
    }
}

async function renderMessages(messages: any[]) {
    if (messages.length === 0) {
        messagesContainer.innerHTML = '<div class="m-auto text-base-content/30 text-sm">No messages yet. Say hi!</div>';
        return;
    }
    messagesContainer.innerHTML = '';
    for (const msg of messages) {
        renderedMessageIds.add(msg.id); // track so WS pushes don't duplicate
        const el = await buildMessageEl(msg);
        messagesContainer.appendChild(el);
    }
    scrollMessagesToBottom();
}

function formatBytes(sizeBytes: number): string {
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let unitIndex = 0;
    let value = sizeBytes;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    const rounded = unitIndex === 0 ? Math.round(value).toString() : value.toFixed(2);
    return `${rounded} ${units[unitIndex]}`;
}

function isPreviewableMimeType(mimeType: string): boolean {
    if (!mimeType) return false;
    if (PREVIEWABLE_MIME_TYPES.has(mimeType)) return true;
    return PREVIEWABLE_MIME_PREFIXES.some(prefix => mimeType.startsWith(prefix));
}

function getAttachmentEncryptionKeys(): string[] {
    const myKey = pgpPublicKey();
    if (!myKey) {
        throw new Error('Encryption keys not loaded. Please unlock encryption first.');
    }

    if (activeConversationType === 'group') {
        if (!activeGroupKeyring.length) {
            throw new Error('No encryption keys available for this group.');
        }
        const candidateKeys = [...new Set([...activeGroupKeyring, myKey])];
        const invalid = candidateKeys.filter((key) =>
            !key.includes('-----BEGIN PGP PUBLIC KEY BLOCK-----')
            || !key.includes('-----END PGP PUBLIC KEY BLOCK-----'),
        );
        if (invalid.length > 0) {
            throw new Error('One or more group members have invalid PGP public keys. Ask them to re-import their key and refresh the chat.');
        }
        return candidateKeys;
    }

    if (!activeReceiverPublicKey) {
        throw new Error('Cannot attach file: recipient public key is unavailable.');
    }
    return [...new Set([activeReceiverPublicKey, myKey])];
}

async function getDecryptedAttachment(attachment: MessageAttachment): Promise<DecryptedAttachmentCacheEntry> {
    const cached = decryptedAttachmentCache.get(attachment.attachmentId);
    if (cached) return cached;

    if (!hasCredentials()) {
        throw new Error('Encryption is locked. Unlock your private key first.');
    }

    const response = await fetch(`/attachments/${attachment.attachmentId}`);
    if (!response.ok) {
        const body = await response.text();
        throw new Error(body || 'Failed to download attachment.');
    }

    const encryptedBytes = new Uint8Array(await response.arrayBuffer());
    const decryptedBytes = await decryptBinaryMessageWithKey(
        encryptedBytes,
        pgpPrivateKey()!,
        pgpPassphrase()!,
    );
    const blob = new Blob([decryptedBytes], {
        type: attachment.mimeType || 'application/octet-stream',
    });
    const entry: DecryptedAttachmentCacheEntry = {
        blob,
        objectUrl: URL.createObjectURL(blob),
    };
    decryptedAttachmentCache.set(attachment.attachmentId, entry);
    return entry;
}

function triggerBrowserDownload(url: string, fileName: string) {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
}

function renderAttachmentPreview(previewContainer: HTMLElement, attachment: MessageAttachment, entry: DecryptedAttachmentCacheEntry) {
    previewContainer.innerHTML = '';

    if (attachment.mimeType.startsWith('image/')) {
        const img = document.createElement('img');
        img.src = entry.objectUrl;
        img.alt = attachment.fileName;
        img.className = 'max-h-72 rounded-lg border border-base-300 object-contain bg-black/10';
        previewContainer.appendChild(img);
        return;
    }

    if (attachment.mimeType.startsWith('video/')) {
        const video = document.createElement('video');
        video.src = entry.objectUrl;
        video.controls = true;
        video.className = 'max-h-72 rounded-lg border border-base-300';
        previewContainer.appendChild(video);
        return;
    }

    if (attachment.mimeType.startsWith('audio/')) {
        const audio = document.createElement('audio');
        audio.src = entry.objectUrl;
        audio.controls = true;
        audio.className = 'w-full';
        previewContainer.appendChild(audio);
        return;
    }

    if (attachment.mimeType === 'application/pdf') {
        const frame = document.createElement('iframe');
        frame.src = entry.objectUrl;
        frame.className = 'w-full h-72 rounded-lg border border-base-300 bg-base-100';
        frame.title = attachment.fileName;
        previewContainer.appendChild(frame);
        return;
    }

    if (attachment.mimeType.startsWith('text/')) {
        entry.blob.text().then((text) => {
            const pre = document.createElement('pre');
            pre.className = 'max-h-72 overflow-auto rounded-lg border border-base-300 bg-base-100 p-3 text-xs';
            pre.textContent = text;
            previewContainer.appendChild(pre);
        }).catch(() => {
            previewContainer.textContent = 'Could not render preview.';
        });
        return;
    }

    previewContainer.textContent = 'Preview is not available for this file type.';
}

function buildAttachmentCard(attachment: MessageAttachment): HTMLElement {
    const container = document.createElement('div');
    container.className = 'mt-2 rounded-xl border border-base-300 bg-base-200/60 p-3 text-xs';

    const title = document.createElement('div');
    title.className = 'font-semibold truncate';
    title.textContent = attachment.fileName;

    const meta = document.createElement('div');
    meta.className = 'opacity-70 mt-1';
    meta.textContent = `${attachment.mimeType || 'application/octet-stream'} • ${formatBytes(attachment.sizeBytes)}`;

    const actions = document.createElement('div');
    actions.className = 'mt-2 flex flex-wrap gap-2';

    const downloadBtn = document.createElement('button');
    downloadBtn.type = 'button';
    downloadBtn.className = 'btn btn-xs btn-outline';
    downloadBtn.textContent = 'Decrypt & Download';

    const previewBtn = document.createElement('button');
    previewBtn.type = 'button';
    previewBtn.className = 'btn btn-xs btn-ghost';
    previewBtn.textContent = 'Preview';
    if (!isPreviewableMimeType(attachment.mimeType)) {
        previewBtn.disabled = true;
        previewBtn.classList.add('opacity-50');
    }

    const status = document.createElement('div');
    status.className = 'mt-2 text-xs opacity-70';

    const preview = document.createElement('div');
    preview.className = 'mt-2';

    downloadBtn.onclick = async () => {
        downloadBtn.disabled = true;
        status.textContent = 'Decrypting file...';
        try {
            const entry = await getDecryptedAttachment(attachment);
            triggerBrowserDownload(entry.objectUrl, attachment.fileName);
            status.textContent = 'Ready.';
        } catch (err: any) {
            status.textContent = err.message ?? 'Failed to decrypt attachment.';
        } finally {
            downloadBtn.disabled = false;
        }
    };

    previewBtn.onclick = async () => {
        previewBtn.disabled = true;
        status.textContent = 'Preparing preview...';
        try {
            const entry = await getDecryptedAttachment(attachment);
            renderAttachmentPreview(preview, attachment, entry);
            status.textContent = 'Preview ready.';
        } catch (err: any) {
            status.textContent = err.message ?? 'Failed to load preview.';
        } finally {
            previewBtn.disabled = !isPreviewableMimeType(attachment.mimeType);
        }
    };

    actions.appendChild(downloadBtn);
    actions.appendChild(previewBtn);

    container.appendChild(title);
    container.appendChild(meta);
    container.appendChild(actions);
    container.appendChild(status);
    container.appendChild(preview);
    return container;
}

async function buildMessageEl(msg: {
    id: string;
    senderUsername: string;
    senderId: string;
    content: string | null;
    deleted: boolean;
    createdAt: string;
    createdAtMs?: number;
    readBy?: { userId: string; username: string; readAt: string | null }[];
    reactions?: MessageReaction[];
    attachment?: MessageAttachment | null;
}) {
    const isMine = currentUserId && msg.senderId === currentUserId;

    // Attempt to decrypt the message content
    let displayContent: string;
    let decryptFailed = false;
    if (msg.deleted || msg.content === null) {
        displayContent = 'This message was deleted.';
    } else if (hasCredentials()) {
        try {
            const decrypted = await decryptMessageWithKey(msg.content, pgpPrivateKey()!, pgpPassphrase()!);
            displayContent = decrypted !== null ? decrypted : msg.content; // null = plaintext legacy
        } catch {
            displayContent = msg.content;
            decryptFailed = true;
        }
    } else {
        displayContent = msg.content;
        decryptFailed = true;
    }

    // Fetch avatar (uses cache after first load)
    const avatarUrl = await fetchAvatar(msg.senderId);

    const li = document.createElement('div');
    li.className = `flex flex-col ${isMine ? 'items-end' : 'items-start'} group`;
    li.dataset.messageId = msg.id;
    li.dataset.senderId = msg.senderId;
    if (msg.createdAtMs !== undefined) li.dataset.createdAtMs = String(msg.createdAtMs);

    // Row: avatar + bubble
    const row = document.createElement('div');
    row.className = `flex items-end gap-2 ${isMine ? 'flex-row-reverse' : 'flex-row'}`;

    // Avatar
    const avatar = document.createElement('img');
    avatar.className = 'w-7 h-7 rounded-full object-cover flex-shrink-0 self-end';
    avatar.alt = escHtml(msg.senderUsername);
    avatar.src = avatarUrl ?? '/img/profileplaceholder.jpg';

    const bubble = document.createElement('div');
    bubble.dataset.role = 'message-bubble';
    bubble.dataset.messageDeleted = msg.deleted ? 'true' : 'false';
    bubble.className = `relative max-w-sm px-4 py-2 rounded-2xl text-sm shadow
        ${msg.deleted ? 'bg-base-200 text-base-content/40 italic' : isMine ? 'bg-primary text-primary-content' : 'bg-base-100 text-base-content'}`;

    const isAttachmentOnlyPlaceholder = !!msg.attachment && displayContent === ATTACHMENT_PLACEHOLDER_CONTENT;
    const messageBodyHtml = msg.deleted
        ? 'This message was deleted.'
        : isAttachmentOnlyPlaceholder
            ? ''
            : escHtml(displayContent);

    bubble.innerHTML = `
        <span class="block text-xs font-semibold mb-1 opacity-70">${escHtml(msg.senderUsername)}</span>
        ${messageBodyHtml ? `<span>${messageBodyHtml}</span>` : ''}
        ${decryptFailed ? '<span class="block text-xs opacity-50 mt-1">⚠ Could not decrypt</span>' : ''}
    `;

    if (!msg.deleted && msg.attachment) {
        bubble.appendChild(buildAttachmentCard(msg.attachment));
    }

    // Delete button (own messages only, not already deleted)
    if (isMine && !msg.deleted) {
        const delBtn = document.createElement('button');
        delBtn.className = 'absolute -top-2 -right-2 btn btn-xs btn-error opacity-0 group-hover:opacity-100 transition-opacity rounded-full';
        delBtn.title = 'Delete message';
        delBtn.textContent = '✕';
        delBtn.onclick = () => deleteMessage(msg.id, li);
        bubble.appendChild(delBtn);
    }

    row.appendChild(avatar);
    row.appendChild(bubble);

    const time = document.createElement('span');
    time.className = 'text-xs text-base-content/30 mt-1 px-1';
    time.dataset.role = 'message-time';
    time.textContent = msg.createdAt;

    li.appendChild(row);
    if (!msg.deleted) {
        renderReactionRow(li, normalizeReactions(msg.reactions ?? []));
    }
    li.appendChild(time);

    // Read receipt indicator (own non-deleted messages only)
    if (isMine && !msg.deleted) {
        const readers = (msg.readBy ?? []).filter(r => r.userId !== currentUserId);
        const indicator = buildReadIndicator(readers);
        li.appendChild(indicator);
    }

    return li;
}

// ── Send message ──────────────────────────────────────────────────────────────
async function sendEncryptedMessage(content: string, attachment?: MessageAttachment) {
    if (!activeConversationId) return;

    const trimmedContent = content.trim();
    if (!trimmedContent && !attachment) return;

    let payload = '';
    let url = '';

    if (trimmedContent) {
        if (activeConversationType === 'group') {
            if (!activeGroupKeyring.length) throw new Error('No encryption keys available for this group.');
            const myKey = pgpPublicKey();
            const allKeys = myKey ? [...activeGroupKeyring, myKey] : activeGroupKeyring;
            payload = await encryptGroupMessage(trimmedContent, allKeys);
            url = `/group/${activeConversationId}/messages`;
        } else {
            if (!activeReceiverPublicKey) throw new Error('Cannot send message: recipient public key is unavailable.');
            const myKey = pgpPublicKey();
            if (!myKey) throw new Error('Encryption keys not loaded. Please unlock encryption first.');
            payload = await encryptChatMessage(trimmedContent, activeReceiverPublicKey, myKey);
            url = `/chat/${activeConversationId}/messages`;
        }
    } else {
        url = activeConversationType === 'group'
            ? `/group/${activeConversationId}/messages`
            : `/chat/${activeConversationId}/messages`;
    }

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: payload, attachment }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.message);
}

function isStreamingFetchTransportError(err: unknown): boolean {
    const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
    return message.includes('failed to fetch')
        || message.includes('networkerror')
        || message.includes('duplex')
        || message.includes('streaming request');
}

function shouldForceBufferedAttachmentUpload(): boolean {
    // Firefox has inconsistent behavior with encrypted stream upload + OpenPGP stream output.
    // Use buffered mode there for reliability.
    return /firefox/i.test(navigator.userAgent);
}

async function doSend() {
    const content = messageInput.value.trim();
    if (!content || !activeConversationId) return;

    messageInput.value = '';
    messageInput.style.height = 'auto';
    sendBtn.disabled = true;
    attachBtn.disabled = true;

    try {
        if (activeConversationType === 'group') {
            // Surface a user-friendly keyring error before OpenPGP throws a generic parse error.
            getAttachmentEncryptionKeys();
        }
        await sendEncryptedMessage(content);
        // WebSocket push will deliver the message to all participants in real time
    } catch (err: any) {
        messageInput.value = content; // restore on failure
        alert(err.message);
    } finally {
        sendBtn.disabled = false;
        attachBtn.disabled = false;
        messageInput.focus();
    }
}

sendBtn.onclick = doSend;

messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        doSend();
    }
});

// Auto-grow textarea
messageInput.addEventListener('input', () => {
    messageInput.style.height = 'auto';
    messageInput.style.height = messageInput.scrollHeight + 'px';
});

attachBtn.onclick = () => {
    if (!activeConversationId) return;
    attachmentInput.click();
};

attachmentInput.addEventListener('change', async () => {
    const file = attachmentInput.files?.[0];
    attachmentInput.value = '';
    if (!file || !activeConversationId) return;

    if (file.size <= 0) {
        alert('Cannot upload an empty file.');
        return;
    }
    if (file.size > MAX_CHAT_ATTACHMENT_SIZE_BYTES) {
        alert('File exceeds 5GB maximum size.');
        return;
    }

    const originalText = messageInput.value;
    const caption = messageInput.value.trim();

    sendBtn.disabled = true;
    attachBtn.disabled = true;
    messageInput.disabled = true;

    try {
        const encryptionKeys = getAttachmentEncryptionKeys();

        const uploadUrl = activeConversationType === 'group'
            ? `/group/${activeConversationId}/attachments/upload`
            : `/chat/${activeConversationId}/attachments/upload`;

        const uploadHeaders = {
            'Content-Type': 'application/octet-stream',
            'X-File-Name': encodeURIComponent(file.name),
            'X-File-Mime': file.type || 'application/octet-stream',
            'X-File-Size': String(file.size),
        };

        let uploadRes: Response;
        if (shouldForceBufferedAttachmentUpload()) {
            const fileBytes = new Uint8Array(await file.arrayBuffer());
            const encryptedBytes = await encryptBinaryForKeys(fileBytes, encryptionKeys);
            uploadRes = await fetch(uploadUrl, {
                method: 'POST',
                headers: uploadHeaders,
                body: encryptedBytes,
            });
        } else {
            try {
                const sourceStream = file.stream();
                const encryptedStream = await encryptBinaryStreamForKeys(sourceStream, encryptionKeys);
                uploadRes = await fetch(uploadUrl, {
                    method: 'POST',
                    headers: uploadHeaders,
                    body: encryptedStream,
                    // Required by some fetch implementations for streaming request bodies.
                    duplex: 'half',
                } as RequestInit & { duplex: 'half' });
            } catch (streamErr) {
                if (!isStreamingFetchTransportError(streamErr)) {
                    throw streamErr;
                }

                // Fallback for browsers/runtimes that do not support streaming uploads.
                const fileBytes = new Uint8Array(await file.arrayBuffer());
                const encryptedBytes = await encryptBinaryForKeys(fileBytes, encryptionKeys);
                uploadRes = await fetch(uploadUrl, {
                    method: 'POST',
                    headers: uploadHeaders,
                    body: encryptedBytes,
                });
            }
        }

        const uploadData = await uploadRes.json();
        if (!uploadData.success) throw new Error(uploadData.message);

        if (caption) {
            messageInput.value = '';
            messageInput.style.height = 'auto';
        }

        await sendEncryptedMessage(caption, uploadData.attachment);
    } catch (err: any) {
        messageInput.value = originalText;
        alert(err.message ?? 'Failed to upload attachment.');
    } finally {
        messageInput.disabled = false;
        sendBtn.disabled = false;
        attachBtn.disabled = false;
        messageInput.focus();
    }
});

// ── Delete message ────────────────────────────────────────────────────────────
async function deleteMessage(messageId: string, el: HTMLElement) {
    if (!activeConversationId) return;
    try {
        const url = activeConversationType === 'group'
            ? `/group/${activeConversationId}/messages/${messageId}`
            : `/chat/${activeConversationId}/messages/${messageId}`;
        const res = await fetch(url, { method: 'DELETE' });
        const data = await res.json();
        if (!data.success) throw new Error(data.message);
        // Re-render the bubble as deleted in place
        const bubble = el.querySelector<HTMLElement>('[data-role="message-bubble"]');
        if (!bubble) return;
        bubble.className = 'relative max-w-sm px-4 py-2 rounded-2xl text-sm shadow bg-base-200 text-base-content/40 italic';
        bubble.dataset.messageDeleted = 'true';
        bubble.innerHTML = `<span class="block text-xs font-semibold mb-1 opacity-70">You</span><span>This message was deleted.</span>`;
        el.querySelector('[data-role="reaction-row"]')?.remove();
        if (activeReactionMessageId === messageId) closeReactionPicker();
    } catch (err: any) {
        alert(err.message);
    }
}

// ── Pin / Unpin ───────────────────────────────────────────────────────────────
async function togglePin(id: string, type: 'dm' | 'group', item: HTMLElement, btn: HTMLElement) {
    try {
        const url = type === 'group' ? `/group/${id}/pin` : `/chat/${id}/pin`;
        const res = await fetch(url, { method: 'POST' });
        const data = await res.json();
        if (!data.success) throw new Error(data.message);

        item.dataset.pinned = data.pinned ? 'true' : 'false';
        btn.textContent = data.pinned ? 'Unpin' : 'Pin';
        btn.title = data.pinned ? 'Unpin' : 'Pin';

        // Update pin icon
        const nameDiv = item.querySelector('.flex.items-center.gap-1') as HTMLElement;
        const existingIcon = nameDiv.querySelector<HTMLElement>('.pin-icon');
        if (data.pinned && !existingIcon) {
            const icon = document.createElement('span');
            icon.className = 'pin-icon text-warning text-xs';
            icon.title = 'Pinned';
            icon.textContent = '📌';
            nameDiv.prepend(icon);
        } else if (!data.pinned && existingIcon) {
            existingIcon.remove();
        }

        // Re-sort the list: pinned at top
        const items = Array.from(conversationList.querySelectorAll<HTMLElement>('.conversation-item'));
        items.sort((a, b) => {
            const ap = a.dataset.pinned === 'true' ? 0 : 1;
            const bp = b.dataset.pinned === 'true' ? 0 : 1;
            return ap - bp;
        });
        items.forEach(i => conversationList.appendChild(i));
    } catch (err: any) {
        alert(err.message);
    }
}

async function toggleMute(id: string, type: 'dm' | 'group', item: HTMLElement, btn: HTMLElement) {
    try {
        const url = type === 'group' ? `/group/${id}/mute` : `/chat/${id}/mute`;
        const res = await fetch(url, { method: 'POST' });
        const data = await res.json();
        if (!data.success) throw new Error(data.message);

        item.dataset.muted = data.muted ? 'true' : 'false';
        btn.textContent = data.muted ? 'Unmute' : 'Mute';
        btn.title = data.muted ? 'Unmute' : 'Mute';

        const nameDiv = item.querySelector('.flex.items-center.gap-1') as HTMLElement;
        const existingIcon = nameDiv.querySelector<HTMLElement>('.mute-icon');
        if (data.muted && !existingIcon) {
            const icon = document.createElement('span');
            icon.className = 'mute-icon text-base-content/50 text-xs';
            icon.title = 'Muted';
            icon.textContent = '🔕';
            const groupIcon = nameDiv.querySelector('span[title="Group chat"]');
            if (groupIcon) {
                groupIcon.insertAdjacentElement('beforebegin', icon);
            } else {
                nameDiv.appendChild(icon);
            }
        } else if (!data.muted && existingIcon) {
            existingIcon.remove();
        }
    } catch (err: any) {
        alert(err.message);
    }
}

// ── New chat: friend picker ───────────────────────────────────────────────────
newChatBtn.onclick = async () => {
    if (!friendPicker.classList.contains('hidden')) {
        friendPicker.classList.add('hidden');
        return;
    }
    friendPickerList.innerHTML = '<li class="text-xs text-base-content/40 italic">Loading...</li>';
    friendPicker.classList.remove('hidden');

    try {
        const res = await fetch('/friends/list');
        const data = await res.json();
        if (!data.success || !data.friends.length) {
            friendPickerList.innerHTML = '<li class="text-xs text-base-content/40 italic">No friends yet.</li>';
            return;
        }
        friendPickerList.innerHTML = '';
        for (const f of data.friends) {
            const li = document.createElement('li');
            li.className = 'btn btn-ghost btn-sm justify-start text-left w-full';
            li.textContent = f.username;
            li.onclick = () => startChat(f.id);
            friendPickerList.appendChild(li);
        }
    } catch {
        friendPickerList.innerHTML = '<li class="text-xs text-error">Failed to load friends.</li>';
    }
};

async function startChat(friendId: string) {
    friendPicker.classList.add('hidden');
    try {
        const res = await fetch('/chat/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ friendId }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.message);
        // Redirect to chat page (which will load all convos including the new one)
        window.location.href = `/chat?open=${data.conversationId}&type=dm`;
    } catch (err: any) {
        alert(err.message);
    }
}

// ── Unlock overlay ────────────────────────────────────────────────────────────
const unlockOverlay   = document.getElementById('unlockOverlay')   as HTMLDivElement;
const unlockKeyFile   = document.getElementById('unlockKeyFile')   as HTMLInputElement;
const unlockPassphrase = document.getElementById('unlockPassphrase') as HTMLInputElement;
const unlockBtn       = document.getElementById('unlockBtn')       as HTMLButtonElement;
const unlockError     = document.getElementById('unlockError')     as HTMLParagraphElement;

function showUnlockError(msg: string) {
    unlockError.textContent = msg;
    unlockError.classList.remove('hidden');
}

// Show overlay on load if credentials are missing
if (!hasCredentials()) {
    unlockOverlay.classList.remove('hidden');
}

unlockBtn.onclick = async () => {
    unlockError.classList.add('hidden');
    const file = unlockKeyFile.files?.[0];
    const pass = unlockPassphrase.value;
    if (!file) return showUnlockError('Please select your private key file.');
    if (!pass)  return showUnlockError('Please enter your passphrase.');

    unlockBtn.disabled = true;
    unlockBtn.textContent = 'Verifying…';
    try {
        // @ts-ignore
        const { getgpgPublicKey } = await import('../jslibs/PGPUtils.js');
        const privateKeyArmored = await file.text();
        const publicKeyArmored = await getgpgPublicKey(file, pass); // throws if passphrase wrong

        sessionStorage.setItem('pgpPrivateKey', privateKeyArmored);
        sessionStorage.setItem('pgpPassphrase', pass);
        sessionStorage.setItem('pgpPublicKey', publicKeyArmored);

        unlockOverlay.classList.add('hidden');
        // Re-render open conversation with decrypted messages
        if (activeConversationId) loadMessages(activeConversationId);
    } catch (err: any) {
        showUnlockError(err.message ?? 'Incorrect passphrase or invalid key file.');
    } finally {
        unlockBtn.disabled = false;
        unlockBtn.textContent = 'Unlock';
    }
};

// ── Auto-open conversation from URL param (?open=id) ─────────────────────────
const urlParams = new URLSearchParams(window.location.search);
const openId = urlParams.get('open');
const openType = urlParams.get('type');
if (openId) {
    const typedSelector = openType
        ? `.conversation-item[data-id="${openId}"][data-type="${openType}"]`
        : `.conversation-item[data-id="${openId}"]`;
    const target = conversationList.querySelector<HTMLElement>(typedSelector)
        ?? conversationList.querySelector<HTMLElement>(`.conversation-item[data-id="${openId}"]`);
    if (target) {
        if (target.dataset.type === 'group') {
            openGroupConversation(openId, target);
        } else {
            openConversation(openId, target);
        }
    }
}

// ── Close chat ────────────────────────────────────────────────────────────────
closeChatBtn.onclick = () => {
    if (!activeConversationId) return;
    closeChatModal.showModal();
};

closeChatCancelBtn.onclick = () => closeChatModal.close();

async function doCloseChat(deleteMessages: boolean) {
    if (!activeConversationId) return;
    const convId = activeConversationId;
    closeChatModal.close();

    try {
        const res = await fetch(`/chat/${convId}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deleteMessages }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.message);

        // Remove from sidebar
        const item = conversationList.querySelector<HTMLElement>(`.conversation-item[data-id="${convId}"]`);
        item?.remove();
        closeActiveConversation();
    } catch (err: any) {
        alert(err.message);
    }
}

function closeActiveConversation() {
    if (callActive) {
        leaveCall(true);
    }

    activeConversationId = null;
    activeConversationType = 'dm';
    activeReceiverPublicKey = null;
    activeGroupKeyring = [];
    activeGroupAdminId = null;
    chatHeaderName.textContent = 'Select a chat';
    chatHeaderName.classList.add('text-base-content/40', 'italic');
    closeChatBtn.classList.add('hidden');
    startCallBtn.classList.add('hidden');
    groupMembersBtn.classList.add('hidden');
    renameGroupHeaderBtn.classList.add('hidden');
    groupMembersPanel.classList.add('hidden');
    messagesContainer.innerHTML = '<div id="messagesPlaceholder" class="m-auto text-base-content/30 text-sm select-none">Open a conversation to start chatting</div>';
    messageInput.disabled = true;
    sendBtn.disabled = true;
    attachBtn.disabled = true;
    sendChatPresence('close');
}

window.addEventListener('beforeunload', () => {
    sendChatPresence('close');
    for (const entry of decryptedAttachmentCache.values()) {
        URL.revokeObjectURL(entry.objectUrl);
    }
});

closeChatDeleteBtn.onclick = () => doCloseChat(true);
closeChatOnlyBtn.onclick   = () => doCloseChat(false);

// ── Group members panel ───────────────────────────────────────────────────────
groupMembersBtn.onclick = () => {
    if (!activeConversationId) return;
    if (groupMembersPanel.classList.contains('hidden')) {
        renderMembersPanel(activeConversationId);
    } else {
        groupMembersPanel.classList.add('hidden');
    }
};
closeMembersPanel.onclick = () => groupMembersPanel.classList.add('hidden');

leaveGroupBtn.onclick = async () => {
    if (!activeConversationId) return;
    if (!confirm('Leave this group? Your messages will be deleted.')) return;
    const groupId = activeConversationId;
    try {
        const res = await fetch(`/group/${groupId}/leave`, { method: 'POST' });
        const data = await res.json();
        if (!data.success) throw new Error(data.message);
        const item = conversationList.querySelector<HTMLElement>(`.conversation-item[data-id="${groupId}"]`);
        item?.remove();
        closeActiveConversation();
    } catch (err: any) {
        alert(err.message);
    }
};

// Delete group (admin only)
deleteGroupBtn.onclick = async () => {
    if (!activeConversationId) return;
    if (!confirm('Delete this group for everyone? This cannot be undone.')) return;
    const groupId = activeConversationId;
    try {
        const res = await fetch(`/group/${groupId}`, { method: 'DELETE' });
        const data = await res.json();
        if (!data.success) throw new Error(data.message);
        const item = conversationList.querySelector<HTMLElement>(`.conversation-item[data-id="${groupId}"]`);
        item?.remove();
        closeActiveConversation();
    } catch (err: any) {
        alert(err.message);
    }
};

// Rename group — called from both header button and members panel ✏️ button
function openRenameModal() {
    if (!activeConversationId) return;
    renameGroupInput.value = '';
    renameGroupError.classList.add('hidden');
    renameGroupModal.showModal();
    renameGroupInput.focus();
}

renameGroupHeaderBtn.onclick = openRenameModal;

// Rename group
renameGroupBtn.onclick = openRenameModal;

renameGroupCancelBtn.onclick = () => renameGroupModal.close();

renameGroupConfirmBtn.onclick = async () => {
    if (!activeConversationId) return;
    const groupId = activeConversationId;
    const newName = renameGroupInput.value.trim() || null;
    renameGroupError.classList.add('hidden');
    try {
        const res = await fetch(`/group/${groupId}/name`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.message);
        renameGroupModal.close();
        // Update sidebar and header inline (WS broadcast will also update for other members)
        const item = conversationList.querySelector<HTMLElement>(`.conversation-item[data-id="${groupId}"]`);
        const fallback = item?.querySelector<HTMLElement>('.font-medium')?.dataset.memberList ?? 'Group Chat';
        const displayName = data.name ?? fallback;
        if (item) {
            const nameSpan = item.querySelector<HTMLElement>('.font-medium');
            if (nameSpan) nameSpan.textContent = displayName;
        }
        if (groupId === activeConversationId) {
            chatHeaderName.textContent = displayName;
        }
        membersPanelTitle.textContent = displayName;
    } catch (err: any) {
        renameGroupError.textContent = err.message;
        renameGroupError.classList.remove('hidden');
    }
};


let selectedAddMemberUserId: string | null = null;

addMemberBtn.onclick = async () => {
    if (!activeConversationId) return;
    selectedAddMemberUserId = null;
    addMemberUsernameInput.value = '';
    addMemberError.classList.add('hidden');
    addMemberFriendList.innerHTML = '<li class="text-xs text-base-content/40 italic">Loading...</li>';
    addMemberModal.showModal();

    try {
        const res = await fetch('/friends/list');
        const data = await res.json();
        addMemberFriendList.innerHTML = '';
        if (!data.success || !data.friends.length) {
            addMemberFriendList.innerHTML = '<li class="text-xs text-base-content/40 italic">No friends.</li>';
            return;
        }
        for (const f of data.friends) {
            const li = document.createElement('li');
            li.className = 'flex items-center gap-2 px-2 py-1 rounded cursor-pointer hover:bg-base-300';
            li.dataset.userId = f.id;
            li.innerHTML = `<span class="text-sm">${escHtml(f.username)}</span>`;
            li.onclick = () => {
                addMemberFriendList.querySelectorAll('li').forEach(el => el.classList.remove('bg-primary/20'));
                li.classList.add('bg-primary/20');
                selectedAddMemberUserId = f.id;
                addMemberUsernameInput.value = '';
            };
            addMemberFriendList.appendChild(li);
        }
    } catch {
        addMemberFriendList.innerHTML = '<li class="text-xs text-error">Failed to load friends.</li>';
    }
};

addMemberCancelBtn.onclick = () => addMemberModal.close();

addMemberConfirmBtn.onclick = async () => {
    if (!activeConversationId) return;
    const byUsername = addMemberUsernameInput.value.trim();
    const targetUserId = byUsername ? null : selectedAddMemberUserId;

    addMemberError.classList.add('hidden');
    addMemberConfirmBtn.disabled = true;

    try {
        // Resolve username → userId if provided
        let resolvedId = targetUserId;
        if (byUsername) {
            const searchRes = await fetch(`/user/search?username=${encodeURIComponent(byUsername)}`);
            const searchData = await searchRes.json();
            if (!searchData.success || !searchData.userId) throw new Error('User not found.');
            resolvedId = searchData.userId;
        }
        if (!resolvedId) throw new Error('Please select a friend or enter a username.');

        const res = await fetch(`/group/${activeConversationId}/invite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetUserId: resolvedId }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.message);
        addMemberModal.close();
        renderMembersPanel(activeConversationId!);
    } catch (err: any) {
        addMemberError.textContent = err.message;
        addMemberError.classList.remove('hidden');
    } finally {
        addMemberConfirmBtn.disabled = false;
    }
};

// ── New group modal ───────────────────────────────────────────────────────────
newGroupBtn.onclick = async () => {
    groupNameInput.value = '';
    groupCreateError.classList.add('hidden');
    groupFriendPickerList.innerHTML = '<li class="text-xs text-base-content/40 italic">Loading friends...</li>';
    newGroupModal.showModal();

    try {
        const res = await fetch('/friends/list');
        const data = await res.json();
        groupFriendPickerList.innerHTML = '';
        if (!data.success || !data.friends.length) {
            groupFriendPickerList.innerHTML = '<li class="text-xs text-base-content/40 italic">No friends to add.</li>';
            return;
        }
        for (const f of data.friends) {
            const li = document.createElement('li');
            li.className = 'flex items-center gap-2 px-2 py-1 rounded';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.value = f.id;
            cb.id = `gf-${f.id}`;
            cb.className = 'checkbox checkbox-sm';
            const label = document.createElement('label');
            label.htmlFor = cb.id;
            label.textContent = f.username;
            label.className = 'text-sm cursor-pointer';
            li.appendChild(cb);
            li.appendChild(label);
            groupFriendPickerList.appendChild(li);
        }
    } catch {
        groupFriendPickerList.innerHTML = '<li class="text-xs text-error">Failed to load friends.</li>';
    }
};

groupCreateCancelBtn.onclick = () => newGroupModal.close();

groupCreateBtn.onclick = async () => {
    groupCreateError.classList.add('hidden');
    const name = groupNameInput.value.trim() || null;
    const checked = Array.from(groupFriendPickerList.querySelectorAll<HTMLInputElement>('input[type=checkbox]:checked'));
    const memberIds = checked.map(cb => cb.value);

    if (memberIds.length < 1) {
        groupCreateError.textContent = 'Select at least one friend.';
        groupCreateError.classList.remove('hidden');
        return;
    }
    if (memberIds.length > 9) {
        groupCreateError.textContent = 'Maximum 9 additional members (10 total including you).';
        groupCreateError.classList.remove('hidden');
        return;
    }

    groupCreateBtn.disabled = true;
    try {
        const res = await fetch('/group/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, memberIds }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.message);
        newGroupModal.close();
        window.location.href = `/chat?open=${data.groupId}&type=group`;
    } catch (err: any) {
        groupCreateError.textContent = err.message;
        groupCreateError.classList.remove('hidden');
    } finally {
        groupCreateBtn.disabled = false;
    }
};

// ── Read receipts ─────────────────────────────────────────────────────────────

/** POST to the server to mark all messages in the active conversation as read. */
async function markConversationRead() {
    if (!activeConversationId) return;
    const url = activeConversationType === 'group'
        ? `/group/${activeConversationId}/read`
        : `/chat/${activeConversationId}/read`;
    try {
        await fetch(url, { method: 'POST' });
    } catch { /* non-fatal */ }
}

/**
 * Build the read indicator element appended under an outgoing message.
 * For DMs: single/double checkmark.
 * For groups: initials chips for each reader.
 */
function buildReadIndicator(
    readers: { userId: string; username: string; readAt: string | null }[],
): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'read-receipt-indicator flex items-center gap-0.5 mt-0.5 min-h-[1rem]';

    if (activeConversationType === 'dm') {
        const span = document.createElement('span');
        if (readers.length > 0) {
            const r = readers[0];
            const timeStr = r.readAt
                ? new Date(r.readAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                : '';
            span.className = 'text-xs text-primary font-medium';
            span.textContent = '✓✓';
            span.title = `Read${timeStr ? ` at ${timeStr}` : ''}`;
        } else {
            span.className = 'text-xs text-base-content/30';
            span.textContent = '✓';
            span.title = 'Sent';
        }
        wrap.appendChild(span);
    } else {
        // Group: show a chip per reader
        for (const r of readers) {
            wrap.appendChild(buildReaderChip(r.userId, r.username, r.readAt));
        }
    }

    return wrap;
}

/** Build a single reader chip (initials circle) for group read indicators. */
function buildReaderChip(userId: string, username: string, readAt: string | null): HTMLElement {
    const chip = document.createElement('div');
    chip.className = 'w-4 h-4 rounded-full bg-primary text-primary-content flex items-center justify-center text-[8px] font-bold flex-shrink-0 cursor-default';
    chip.dataset.readerId = userId;
    chip.textContent = username.charAt(0).toUpperCase();
    const timeStr = readAt
        ? new Date(readAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '';
    chip.title = `Read by ${username}${timeStr ? ` at ${timeStr}` : ''}`;
    return chip;
}

/** Update all own outgoing DM message indicators to "read" when the recipient reads. */
function updateDmReadIndicators(readerUserId: string, readerUsername: string, readAt: string) {
    const timeStr = new Date(readAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const msgEls = messagesContainer.querySelectorAll<HTMLElement>('[data-message-id]');
    for (const el of msgEls) {
        if (el.dataset.senderId !== currentUserId) continue;
        const indicator = el.querySelector<HTMLElement>('.read-receipt-indicator');
        if (!indicator) continue;
        indicator.innerHTML = '';
        const span = document.createElement('span');
        span.className = 'text-xs text-primary font-medium';
        span.textContent = '✓✓';
        span.title = `Read by ${readerUsername} at ${timeStr}`;
        indicator.appendChild(span);
    }
}

/**
 * Update own outgoing group messages whose `createdAtMs` ≤ `readAt` to add the reader chip.
 * Skips messages where this reader's chip already exists.
 */
function updateGroupReadIndicators(readerUserId: string, readerUsername: string, readAt: string) {
    const readAtMs = new Date(readAt).getTime();
    const msgEls = messagesContainer.querySelectorAll<HTMLElement>('[data-message-id]');
    for (const el of msgEls) {
        if (el.dataset.senderId !== currentUserId) continue;
        const elMs = parseInt(el.dataset.createdAtMs ?? '0', 10);
        if (elMs > readAtMs) continue;
        const indicator = el.querySelector<HTMLElement>('.read-receipt-indicator');
        if (!indicator) continue;
        // Avoid duplicates
        if (indicator.querySelector(`[data-reader-id="${readerUserId}"]`)) continue;
        indicator.appendChild(buildReaderChip(readerUserId, readerUsername, readAt));
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function escHtml(str: string) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildFallbackName(item: HTMLElement): string {
    return item.querySelector<HTMLElement>('.font-medium')?.textContent ?? 'Group Chat';
}
