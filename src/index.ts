// src/index.ts
import express, { Request, Response } from 'express';
import http from 'http';
import path from 'path'; // Import the 'path' module
import { engine } from 'express-handlebars'; // Import express-handlebars

import 'dotenv/config'; // Load environment variables from .env file
import mongoose from 'mongoose'; 
import UserController from './Controllers/UserController';
import FriendController from './Controllers/FriendController';
import ChatController from './Controllers/ChatController';
import NotificationController from './Controllers/NotificationController';
import GroupController from './Controllers/GroupController';
import ConversationModel from './Models/ConversationModel';
import MessageModel from './Models/MessageModel';
import GroupConversationModel from './Models/GroupConversationModel';
import GroupMessageModel from './Models/GroupMessageModel';
import FriendRequestModel from './Models/FriendRequestModel';
import NotificationModel from './Models/NotificationModel';
import UserModel from './Models/UserModel';
import dotenv from 'dotenv';
import session from 'express-session';
import openpgp from 'openpgp'; // Import OpenPGP for cryptographic operations
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { Transform } from 'stream';
import { GridFSBucket, ObjectId } from 'mongodb';

type CallRoomType = 'dm' | 'group';

interface CallParticipant {
    userId: string;
    username: string;
    ws: WebSocket;
    roomType: CallRoomType;
    roomId: string;
    publicKey: string | null;
}

interface WsSessionState {
    userId: string;
    username: string;
    activeCallRoomKey: string | null;
    activeChatView: { conversationType: CallRoomType; conversationId: string } | null;
}

interface PendingCallInvite {
    inviteId: string;
    fromUserId: string;
    fromUsername: string;
    toUserId: string;
    conversationType: CallRoomType;
    conversationId: string;
    timeout: NodeJS.Timeout;
}

// Extend SessionData to include custom properties
declare module 'express-session' {
    interface SessionData {
        authenticated?: boolean;
        userId?: string;
    }
}

// Define the structure of the challenge data
interface ChallengeData {
    challenge: string;
    publicKey: string;
    userId: string;
    timestamp: number;
}

// In-memory storage for challenges (expires after 5 minutes)
const pendingChallenges = new Map<string, ChallengeData>();

// Helper function to clean up expired challenges
function cleanupExpiredChallenges() {
    const now = Date.now();
    const expireTime = 5 * 60 * 1000; // 5 minutes
    
    for (const [key, data] of pendingChallenges.entries()) {
        if (now - data.timestamp > expireTime) {
            pendingChallenges.delete(key);
        }
    }
}

dotenv.config(); // Load environment variables from .env file

const app = express();
const port = process.env.PORT || 3000;

//init database connection here
const dbUri = process.env.MONGO_URI || 'mongodb://localhost:27017/keepquiet'; // Use a default URI if not set in environment variables
if (!dbUri) {
    console.error('MONGO_URI is not defined in the environment variables.');
    process.exit(1); // Exit the process if MONGO_URI is not set
}
mongoose.connect(dbUri)
.then(() => {
    console.log('Connected to MongoDB');
})

const session_secret = process.env.SESSION_SECRET || 'default-secret'; // Use a default secret if not set in environment variables
const sessionStore = new session.MemoryStore();

interface IceServerEntry { urls: string | string[]; username?: string; credential?: string }
const ICE_SERVERS: IceServerEntry[] = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    ICE_SERVERS.push({
        urls: process.env.TURN_URL.split(','),
        username: process.env.TURN_USERNAME,
        credential: process.env.TURN_CREDENTIAL,
    });
}

const ICE_SERVERS_JSON = JSON.stringify(ICE_SERVERS);

type ConversationScopeType = 'dm' | 'group';

interface ChatAttachmentPayload {
    attachmentId: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    encryptedSizeBytes: number;
}

interface UploadAttachmentHeaders {
    fileName: string;
    mimeType: string;
    sizeBytes: number;
}

const ATTACHMENT_BUCKET_NAME = 'chat_attachments';
const MAX_ATTACHMENT_SIZE_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_ENCRYPTED_ATTACHMENT_SIZE_BYTES = MAX_ATTACHMENT_SIZE_BYTES + (32 * 1024 * 1024);

function getAttachmentBucket(): GridFSBucket {
    const db = mongoose.connection.db;
    if (!db) throw new Error('Database is not ready. Please retry.');
    return new GridFSBucket(db, { bucketName: ATTACHMENT_BUCKET_NAME });
}

function safeAttachmentFilename(fileName: string): string {
    const cleaned = fileName
        .replace(/[\r\n]/g, ' ')
        .replace(/[\\/]/g, '_')
        .trim();
    if (!cleaned) return 'attachment.bin';
    return cleaned.slice(0, 255);
}

function parseAttachmentUploadHeaders(req: Request): UploadAttachmentHeaders {
    const rawName = req.header('x-file-name');
    const rawMime = req.header('x-file-mime');
    const rawSize = req.header('x-file-size');

    if (!rawName || !rawSize) {
        throw new Error('Attachment headers x-file-name and x-file-size are required.');
    }

    let decodedName = rawName;
    try {
        decodedName = decodeURIComponent(rawName);
    } catch {
        decodedName = rawName;
    }

    const sizeBytes = Number(rawSize);
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
        throw new Error('x-file-size must be a positive number.');
    }
    if (sizeBytes > MAX_ATTACHMENT_SIZE_BYTES) {
        throw new Error('File size exceeds the 5GB limit.');
    }

    return {
        fileName: safeAttachmentFilename(decodedName),
        mimeType: (rawMime?.trim() || 'application/octet-stream').slice(0, 200),
        sizeBytes,
    };
}

function serializeAttachment(attachment: any): ChatAttachmentPayload | null {
    if (!attachment?.fileId) return null;
    return {
        attachmentId: attachment.fileId.toString(),
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        encryptedSizeBytes: attachment.encryptedSizeBytes,
    };
}

async function findLiveAttachmentReference(fileId: ObjectId): Promise<{ conversationType: ConversationScopeType; conversationId: string } | null> {
    const dmReference = await MessageModel.findOne(
        { 'attachment.fileId': fileId, deletedAt: null },
        { conversationId: 1 },
    ).lean();
    if (dmReference?.conversationId) {
        return { conversationType: 'dm', conversationId: dmReference.conversationId.toString() };
    }

    const groupReference = await GroupMessageModel.findOne(
        { 'attachment.fileId': fileId, deletedAt: null },
        { groupId: 1 },
    ).lean();
    if (groupReference?.groupId) {
        return { conversationType: 'group', conversationId: groupReference.groupId.toString() };
    }

    return null;
}

async function cleanupAttachmentIfOrphaned(fileId: string | ObjectId): Promise<void> {
    const objectId = typeof fileId === 'string' ? new ObjectId(fileId) : fileId;
    const liveReference = await findLiveAttachmentReference(objectId);
    if (liveReference) return;

    const bucket = getAttachmentBucket();
    try {
        await bucket.delete(objectId);
    } catch {
        // Ignore missing files or race conditions where another cleanup already removed the blob.
    }
}

async function cleanupAttachmentsIfOrphaned(fileIds: Array<string | ObjectId | null | undefined>): Promise<void> {
    const uniqueIds = Array.from(new Set(
        fileIds
            .map((id) => (id ? id.toString() : null))
            .filter((id): id is string => !!id),
    ));

    for (const id of uniqueIds) {
        if (!ObjectId.isValid(id)) continue;
        await cleanupAttachmentIfOrphaned(new ObjectId(id));
    }
}

async function isUserAuthorizedForConversationScope(
    userId: string,
    conversationType: ConversationScopeType,
    conversationId: string,
): Promise<boolean> {
    if (!mongoose.Types.ObjectId.isValid(userId) || !mongoose.Types.ObjectId.isValid(conversationId)) {
        return false;
    }

    const uid = new mongoose.Types.ObjectId(userId);
    const cid = new mongoose.Types.ObjectId(conversationId);

    if (conversationType === 'dm') {
        const conv = await ConversationModel.findById(cid).lean();
        if (!conv) return false;
        return (conv.participants as any[]).some((p: any) => p.equals(uid));
    }

    const group = await GroupConversationModel.findById(cid).lean();
    if (!group) return false;
    return (group.members as any[]).some((m: any) => m.userId.equals(uid));
}

async function uploadEncryptedAttachmentToGridFS(
    req: Request,
    senderId: string,
    conversationType: ConversationScopeType,
    conversationId: string,
    headers: UploadAttachmentHeaders,
): Promise<ChatAttachmentPayload> {
    const bucket = getAttachmentBucket();

    const uploadStream = bucket.openUploadStream(headers.fileName, {
        contentType: 'application/octet-stream',
        metadata: {
            senderId,
            conversationType,
            conversationId,
            originalFileName: headers.fileName,
            originalMimeType: headers.mimeType,
            originalSize: headers.sizeBytes,
            encrypted: true,
        },
    });

    let encryptedSizeBytes = 0;
    const sizeLimiter = new Transform({
        transform(chunk, _enc, callback) {
            encryptedSizeBytes += chunk.length;
            if (encryptedSizeBytes > MAX_ENCRYPTED_ATTACHMENT_SIZE_BYTES) {
                callback(new Error('Encrypted payload exceeds the allowed size limit.'));
                return;
            }
            callback(null, chunk);
        },
    });

    await new Promise<void>((resolve, reject) => {
        const fail = (err: Error) => {
            sizeLimiter.destroy(err);
            uploadStream.destroy(err);
            reject(err);
        };

        req.on('error', fail);
        sizeLimiter.on('error', fail);
        uploadStream.on('error', fail);
        uploadStream.on('finish', () => resolve());

        req.pipe(sizeLimiter).pipe(uploadStream);
    });

    if (encryptedSizeBytes === 0) {
        throw new Error('Attachment body is empty.');
    }

    return {
        attachmentId: uploadStream.id.toString(),
        fileName: headers.fileName,
        mimeType: headers.mimeType,
        sizeBytes: headers.sizeBytes,
        encryptedSizeBytes,
    };
}

// ── WebSocket helpers ──────────────────────────────────────────────────────────
const connectedUsers = new Map<string, Set<WebSocket>>();
const callRooms = new Map<string, Map<string, CallParticipant>>();
const socketState = new Map<WebSocket, WsSessionState>();
const CALL_INVITE_TIMEOUT_MS = 30_000;
const pendingCallInvites = new Map<string, PendingCallInvite>();

function addUserSocket(userId: string, ws: WebSocket) {
    if (!connectedUsers.has(userId)) connectedUsers.set(userId, new Set());
    connectedUsers.get(userId)!.add(ws);
}

function removeUserSocket(userId: string, ws: WebSocket) {
    connectedUsers.get(userId)?.delete(ws);
    if (connectedUsers.get(userId)?.size === 0) connectedUsers.delete(userId);
}

function broadcastToUser(userId: string, data: object) {
    const sockets = connectedUsers.get(userId);
    if (!sockets) return;
    const msg = JSON.stringify(data);
    for (const ws of sockets) {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
}

function sendWsJson(ws: WebSocket, data: object) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function userIsViewingConversation(userId: string, conversationType: CallRoomType, conversationId: string): boolean {
    const sockets = connectedUsers.get(userId);
    if (!sockets) return false;

    for (const ws of sockets) {
        const state = socketState.get(ws);
        if (!state?.activeChatView) continue;
        if (state.activeChatView.conversationType !== conversationType) continue;
        if (state.activeChatView.conversationId !== conversationId) continue;
        return true;
    }
    return false;
}

function makeCallRoomKey(roomType: CallRoomType, roomId: string): string {
    return `${roomType}:${roomId}`;
}

function parseCallRoomKey(roomKey: string): { roomType: CallRoomType; roomId: string } {
    const [roomType, ...rest] = roomKey.split(':');
    return { roomType: roomType as CallRoomType, roomId: rest.join(':') };
}

function broadcastCallRoom(roomKey: string, data: object, excludeUserId?: string) {
    const room = callRooms.get(roomKey);
    if (!room) return;
    for (const [uid, participant] of room.entries()) {
        if (excludeUserId && uid === excludeUserId) continue;
        sendWsJson(participant.ws, data);
    }
}

function clearPendingCallInvite(inviteId: string): PendingCallInvite | null {
    const invite = pendingCallInvites.get(inviteId);
    if (!invite) return null;
    clearTimeout(invite.timeout);
    pendingCallInvites.delete(inviteId);
    return invite;
}

function clearPendingCallInvitesForUser(userId: string) {
    for (const [inviteId, invite] of pendingCallInvites.entries()) {
        if (invite.fromUserId !== userId && invite.toUserId !== userId) continue;
        clearPendingCallInvite(inviteId);
    }
}

function clearPendingCallInvitesForJoin(
    toUserId: string,
    acceptedUsername: string,
    conversationType: CallRoomType,
    conversationId: string,
) {
    for (const [inviteId, invite] of pendingCallInvites.entries()) {
        if (invite.toUserId !== toUserId) continue;
        if (invite.conversationType !== conversationType || invite.conversationId !== conversationId) continue;
        const resolved = clearPendingCallInvite(inviteId);
        if (!resolved) continue;
        broadcastToUser(resolved.fromUserId, {
            type: 'call_accepted',
            byUserId: resolved.toUserId,
            byUsername: acceptedUsername,
            conversationType: resolved.conversationType,
            conversationId: resolved.conversationId,
        });
    }
}

async function isUserAuthorizedForCall(roomType: CallRoomType, roomId: string, userId: string): Promise<boolean> {
    if (!mongoose.Types.ObjectId.isValid(roomId) || !mongoose.Types.ObjectId.isValid(userId)) return false;

    const uid = new mongoose.Types.ObjectId(userId);
    if (roomType === 'dm') {
        const conversation = await ConversationModel.findOne({
            _id: new mongoose.Types.ObjectId(roomId),
            participants: uid,
        })
            .select('_id')
            .lean();
        return !!conversation;
    }

    const group = await GroupConversationModel.findOne({
        _id: new mongoose.Types.ObjectId(roomId),
        'members.userId': uid,
    })
        .select('_id')
        .lean();
    return !!group;
}

async function getCallMemberUserIds(roomType: CallRoomType, roomId: string): Promise<string[]> {
    if (!mongoose.Types.ObjectId.isValid(roomId)) return [];

    if (roomType === 'dm') {
        const conversation = await ConversationModel.findById(roomId)
            .select('participants')
            .lean();
        if (!conversation) return [];
        return (conversation.participants as any[]).map((id: any) => id.toString());
    }

    const group = await GroupConversationModel.findById(roomId)
        .select('members.userId')
        .lean();
    if (!group) return [];
    return (group.members as any[]).map((m: any) => m.userId.toString());
}

function removeSocketFromCall(ws: WebSocket, reason: 'left' | 'disconnect' = 'left') {
    const state = socketState.get(ws);
    if (!state?.activeCallRoomKey) return;

    const roomKey = state.activeCallRoomKey;
    const room = callRooms.get(roomKey);
    if (!room) {
        state.activeCallRoomKey = null;
        return;
    }

    const participant = room.get(state.userId);
    if (participant?.ws !== ws) {
        state.activeCallRoomKey = null;
        return;
    }

    room.delete(state.userId);
    if (room.size === 0) {
        callRooms.delete(roomKey);
    }

    const { roomType, roomId } = parseCallRoomKey(roomKey);
    broadcastCallRoom(
        roomKey,
        {
            type: 'call_user_left',
            conversationType: roomType,
            conversationId: roomId,
            userId: state.userId,
            username: state.username,
            reason,
        },
        state.userId,
    );

    state.activeCallRoomKey = null;
}

async function handleCallJoin(ws: WebSocket, payload: any) {
    const state = socketState.get(ws);
    if (!state) return;

    const conversationType: CallRoomType = payload?.conversationType;
    const conversationId: string = payload?.conversationId;
    const publicKey = typeof payload?.publicKey === 'string' ? payload.publicKey : null;

    if ((conversationType !== 'dm' && conversationType !== 'group') || !conversationId) {
        sendWsJson(ws, { type: 'call_error', message: 'Invalid call room payload.' });
        return;
    }

    const authorized = await isUserAuthorizedForCall(conversationType, conversationId, state.userId);
    if (!authorized) {
        sendWsJson(ws, { type: 'call_error', message: 'Unauthorized call join.' });
        return;
    }

    const roomKey = makeCallRoomKey(conversationType, conversationId);

    clearPendingCallInvitesForJoin(state.userId, state.username, conversationType, conversationId);

    if (state.activeCallRoomKey && state.activeCallRoomKey !== roomKey) {
        removeSocketFromCall(ws, 'left');
    }

    if (!callRooms.has(roomKey)) callRooms.set(roomKey, new Map());
    const room = callRooms.get(roomKey)!;

    const existing = room.get(state.userId);
    if (!existing && room.size >= 10) {
        sendWsJson(ws, { type: 'call_error', message: 'Call is full (10 participants max).' });
        return;
    }

    if (existing && existing.ws !== ws) {
        const oldState = socketState.get(existing.ws);
        if (oldState) oldState.activeCallRoomKey = null;
        sendWsJson(existing.ws, { type: 'call_replaced', conversationType, conversationId });
    }

    room.set(state.userId, {
        userId: state.userId,
        username: state.username,
        ws,
        roomType: conversationType,
        roomId: conversationId,
        publicKey,
    });
    state.activeCallRoomKey = roomKey;

    const participants = Array.from(room.values())
        .filter((p) => p.userId !== state.userId)
        .map((p) => ({ userId: p.userId, username: p.username, publicKey: p.publicKey }));

    sendWsJson(ws, {
        type: 'call_room_state',
        conversationType,
        conversationId,
        participants,
    });

    broadcastCallRoom(
        roomKey,
        {
            type: 'call_user_joined',
            conversationType,
            conversationId,
            userId: state.userId,
            username: state.username,
            publicKey,
        },
        state.userId,
    );
}

function handleCallRelay(ws: WebSocket, payload: any, relayType: 'call_offer' | 'call_answer' | 'call_ice_candidate') {
    const state = socketState.get(ws);
    if (!state?.activeCallRoomKey) {
        sendWsJson(ws, { type: 'call_error', message: 'Join a call first.' });
        return;
    }

    const room = callRooms.get(state.activeCallRoomKey);
    if (!room) {
        state.activeCallRoomKey = null;
        sendWsJson(ws, { type: 'call_error', message: 'Call room no longer exists.' });
        return;
    }

    const to = payload?.to;
    if (!to || typeof to !== 'string') {
        sendWsJson(ws, { type: 'call_error', message: 'Relay target is required.' });
        return;
    }

    const target = room.get(to);
    if (!target) {
        sendWsJson(ws, { type: 'call_error', message: 'Target is not in this call.' });
        return;
    }

    const { roomType, roomId } = parseCallRoomKey(state.activeCallRoomKey);
    const relayPayload: any = {
        type: relayType,
        conversationType: roomType,
        conversationId: roomId,
        from: state.userId,
    };

    if (relayType === 'call_offer') relayPayload.offer = payload?.offer;
    if (relayType === 'call_answer') relayPayload.answer = payload?.answer;
    if (relayType === 'call_ice_candidate') relayPayload.candidate = payload?.candidate;

    sendWsJson(target.ws, relayPayload);
}

async function handleCallSocketMessage(ws: WebSocket, data: any) {
    const type = data?.type;
    if (typeof type !== 'string') return;

    switch (type) {
        case 'chat_presence': {
            const state = socketState.get(ws);
            if (!state) return;

            const action: string = data?.action;
            if (action === 'close') {
                state.activeChatView = null;
                return;
            }

            if (action !== 'open') return;

            const conversationType: CallRoomType = data?.conversationType;
            const conversationId: string = data?.conversationId;
            if ((conversationType !== 'dm' && conversationType !== 'group') || !conversationId) {
                return;
            }

            const authorized = await isUserAuthorizedForCall(conversationType, conversationId, state.userId);
            if (!authorized) return;

            state.activeChatView = { conversationType, conversationId };
            return;
        }
        case 'call_invite': {
            const state = socketState.get(ws);
            if (!state) return;

            const conversationType: CallRoomType = data?.conversationType;
            const conversationId: string = data?.conversationId;
            if ((conversationType !== 'dm' && conversationType !== 'group') || !conversationId) {
                sendWsJson(ws, { type: 'call_error', message: 'Invalid call invite payload.' });
                return;
            }

            const authorized = await isUserAuthorizedForCall(conversationType, conversationId, state.userId);
            if (!authorized) {
                sendWsJson(ws, { type: 'call_error', message: 'Unauthorized call invite.' });
                return;
            }

            const memberIds = await getCallMemberUserIds(conversationType, conversationId);
            for (const memberId of memberIds) {
                if (memberId === state.userId) continue;

                for (const [existingInviteId, existingInvite] of pendingCallInvites.entries()) {
                    if (existingInvite.fromUserId !== state.userId) continue;
                    if (existingInvite.toUserId !== memberId) continue;
                    if (existingInvite.conversationType !== conversationType || existingInvite.conversationId !== conversationId) continue;
                    clearPendingCallInvite(existingInviteId);
                }

                const inviteId = crypto.randomUUID();
                const timeout = setTimeout(() => {
                    const expired = clearPendingCallInvite(inviteId);
                    if (!expired) return;

                    broadcastToUser(expired.fromUserId, {
                        type: 'call_missed',
                        toUserId: expired.toUserId,
                        toUsername: undefined,
                        conversationType: expired.conversationType,
                        conversationId: expired.conversationId,
                    });

                    broadcastToUser(expired.toUserId, {
                        type: 'call_invite_expired',
                        inviteId: expired.inviteId,
                        fromUserId: expired.fromUserId,
                        fromUsername: expired.fromUsername,
                        conversationType: expired.conversationType,
                        conversationId: expired.conversationId,
                    });
                }, CALL_INVITE_TIMEOUT_MS);

                pendingCallInvites.set(inviteId, {
                    inviteId,
                    fromUserId: state.userId,
                    fromUsername: state.username,
                    toUserId: memberId,
                    conversationType,
                    conversationId,
                    timeout,
                });

                broadcastToUser(memberId, {
                    type: 'call_incoming',
                    inviteId,
                    fromUserId: state.userId,
                    fromUsername: state.username,
                    conversationType,
                    conversationId,
                    timeoutMs: CALL_INVITE_TIMEOUT_MS,
                });
            }
            return;
        }
        case 'call_decline': {
            const state = socketState.get(ws);
            if (!state) return;

            const toUserId: string | undefined = data?.toUserId;
            const inviteId: string | undefined = data?.inviteId;
            const conversationType: CallRoomType = data?.conversationType;
            const conversationId: string = data?.conversationId;

            if (!toUserId || !conversationId || (conversationType !== 'dm' && conversationType !== 'group')) {
                return;
            }

            const authorized = await isUserAuthorizedForCall(conversationType, conversationId, state.userId);
            if (!authorized) return;

            if (inviteId) {
                const invite = pendingCallInvites.get(inviteId);
                if (invite && invite.toUserId === state.userId && invite.fromUserId === toUserId) {
                    clearPendingCallInvite(inviteId);
                }
            } else {
                for (const [existingInviteId, invite] of pendingCallInvites.entries()) {
                    if (invite.toUserId !== state.userId || invite.fromUserId !== toUserId) continue;
                    if (invite.conversationType !== conversationType || invite.conversationId !== conversationId) continue;
                    clearPendingCallInvite(existingInviteId);
                }
            }

            broadcastToUser(toUserId, {
                type: 'call_declined',
                byUserId: state.userId,
                byUsername: state.username,
                conversationType,
                conversationId,
            });
            return;
        }
        case 'call_join':
            await handleCallJoin(ws, data);
            return;
        case 'call_leave':
            removeSocketFromCall(ws, 'left');
            return;
        case 'call_offer':
        case 'call_answer':
        case 'call_ice_candidate':
            handleCallRelay(ws, data, type);
            return;
        default:
            return;
    }
}

function parseCookies(header: string): Record<string, string> {
    const cookies: Record<string, string> = {};
    for (const pair of header.split(';')) {
        const [k, ...v] = pair.trim().split('=');
        if (k) cookies[k.trim()] = decodeURIComponent(v.join('='));
    }
    return cookies;
}

function unsignSessionCookie(signed: string, secret: string): string | false {
    if (!signed.startsWith('s:')) return false;
    const str = signed.slice(2);
    const dotIdx = str.lastIndexOf('.');
    if (dotIdx < 1) return false;
    const value = str.slice(0, dotIdx);
    const sig = str.slice(dotIdx + 1);
    const mac = crypto.createHmac('sha256', secret)
        .update(value)
        .digest('base64')
        .replace(/=+$/, '');
    const a = Buffer.from(sig);
    const b = Buffer.from(mac);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b) ? value : false;
}

// Set up Handlebars as the template engine
app.engine('handlebars', engine({
    helpers: {
        eq: (a: any, b: any) => a === b,
        gt: (a: any, b: any) => a > b,
    },
}));
app.set('view engine', 'handlebars');
app.set('views', path.join(__dirname, 'public' ,'views'));

// Serve static files from the 'src/public' directory
// The path.join() method is used to construct a platform-specific path.
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true })); // Middleware to parse URL-encoded bodies
app.use(express.json()); // Middleware to parse JSON bodies
app.use(session({
    secret: session_secret, //add your secret here, it should be a long random string and in environment variables
    store: sessionStore,
    resave: false,
    saveUninitialized: true,
    cookie: {
        secure: false, // Set to true in production (requires HTTPS)
        httpOnly: true,
        maxAge: 1000 * 60 * 60 // 1 hour
    }
}));

// Middleware to protect routes
function requireAuth(req: Request, res: Response, next: any) {
    if (req.session.authenticated) {
        next();
    } else {
        res.redirect('/login');
    }
}

// Inject current user into every template's locals
app.use((req: Request, res: Response, next: any) => {
    res.locals.currentUserId = req.session.userId ?? null;
    next();
});

// Serve the index.html for / route
app.get('/', async (req: Request, res: Response) => {
    if (!req.session.authenticated || !req.session.userId) {
        res.render('home', { title: 'Home', script: 'home', loggedIn: false });
        return;
    }
    try {
        const userId = req.session.userId;
        const [user, pendingRequests, notifications, unreadCount, messagesSent] = await Promise.all([
            UserController.getUserById(userId),
            FriendController.getPendingIncomingRequests(userId),
            NotificationController.getForUser(userId),
            NotificationController.countUnread(userId),
            MessageModel.countDocuments({ senderId: userId, deletedAt: null }),
        ]);
        if (!user) {
            res.render('home', { title: 'Home', script: 'home', loggedIn: false });
            return;
        }
        const recentNotifs = notifications.slice(0, 5).map((n: any) => ({
            id: n._id.toString(),
            title: n.title,
            body: n.body,
            link: n.link,
            read: n.read,
            type: n.type,
            createdAt: new Date(n.createdAt).toLocaleDateString(),
        }));
        const pendingReqs = (pendingRequests as any[]).slice(0, 5).map((r: any) => ({
            requestId: r._id.toString(),
            username: r.fromUserId?.username ?? 'Unknown',
        }));
        res.render('home', {
            title: 'Home',
            script: 'home',
            loggedIn: true,
            username: user.username,
            profilePicture: (user as any).profilePicture ?? null,
            friendsCount: (user.friends ?? []).length,
            pendingCount: pendingRequests.length,
            unreadCount,
            messagesSent,
            memberSince: user.createdAt.toLocaleDateString(),
            recentNotifs,
            pendingReqs,
            hasNotifs: recentNotifs.length > 0,
            hasPending: pendingReqs.length > 0,
            hasManyPending: pendingReqs.length > 5,
        });
    } catch (error) {
        console.error('Error loading dashboard:', error);
        res.render('home', { title: 'Home', script: 'home', loggedIn: false });
    }
});

app.get('/profile', requireAuth, async (req: Request, res: Response) => {
    try {
        const user = await UserController.getUserById(req.session.userId!);
        if (!user) {
            res.status(404).render('404', { title: '404 Not Found' });
            return;
        }
        res.render('profile', {
            title: 'Profile',
            script: 'profile',
            username: user.username,
            publicKey: user.publicKey,
            createdAt: user.createdAt.toLocaleDateString(),
            profilePicture: (user as any).profilePicture ?? null,
        });
    } catch (error) {
        console.error('Error fetching profile:', error);
        res.status(500).send('Internal server error.');
    }
});

// Upload / update profile picture (receives a base64 data URL of the cropped image)
app.post('/profile/avatar', requireAuth, async (req: Request, res: Response) => {
    const { dataUrl } = req.body;
    if (!dataUrl || typeof dataUrl !== 'string') {
        res.status(400).json({ success: false, message: 'dataUrl is required.' });
        return;
    }
    // Only allow image data URLs
    if (!dataUrl.startsWith('data:image/')) {
        res.status(400).json({ success: false, message: 'Invalid image format.' });
        return;
    }
    // Cap at ~200 KB of base64 (256x256 JPEG is typically ~15 KB)
    if (dataUrl.length > 200_000) {
        res.status(400).json({ success: false, message: 'Image is too large.' });
        return;
    }
    try {
        await UserController.updateProfilePicture(req.session.userId!, dataUrl);
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Delete account — verifies the user's PGP private key + passphrase then wipes all data
app.delete('/profile/account', requireAuth, async (req: Request, res: Response) => {
    const { privateKeyArmored, passphrase } = req.body;
    if (!privateKeyArmored || typeof privateKeyArmored !== 'string' ||
        !passphrase        || typeof passphrase        !== 'string') {
        res.status(400).json({ success: false, message: 'Private key and passphrase are required.' });
        return;
    }

    const userId = req.session.userId!;
    try {
        const user = await UserController.getUserById(userId);
        if (!user) {
            res.status(404).json({ success: false, message: 'User not found.' });
            return;
        }

        // Verify the supplied private key decrypts with the passphrase and matches the stored public key
        let privateKey: openpgp.PrivateKey;
        try {
            const encryptedKey = await openpgp.readPrivateKey({ armoredKey: privateKeyArmored });
            privateKey = await openpgp.decryptKey({ privateKey: encryptedKey, passphrase });
        } catch {
            res.status(401).json({ success: false, message: 'Invalid private key or passphrase.' });
            return;
        }

        const storedPublicKeyArmored = (user as any).publicKeyArmored;
        if (storedPublicKeyArmored) {
            try {
                const storedPublicKey = await openpgp.readKey({ armoredKey: storedPublicKeyArmored });
                const suppliedFingerprint = privateKey.toPublic().getFingerprint();
                const storedFingerprint   = storedPublicKey.getFingerprint();
                if (suppliedFingerprint !== storedFingerprint) {
                    res.status(401).json({ success: false, message: 'Private key does not match this account.' });
                    return;
                }
            } catch {
                res.status(500).json({ success: false, message: 'Failed to verify key identity.' });
                return;
            }
        }

        const uid = new mongoose.Types.ObjectId(userId);

        // Remove user from all friends lists
        await UserModel.updateMany({ friends: uid }, { $pull: { friends: uid } });

        // Delete all friend requests involving this user
        await FriendRequestModel.deleteMany({ $or: [{ fromUserId: uid }, { toUserId: uid }] });

        // Delete all notifications for this user
        await NotificationModel.deleteMany({ userId: uid });

        // Delete all DM messages sent by this user and conversations they participate in
        await MessageModel.deleteMany({ senderId: uid });
        await ConversationModel.deleteMany({ participants: uid });

        // Handle group memberships
        const groups = await GroupConversationModel.find({ 'members.userId': uid });
        for (const group of groups) {
            const remainingMembers = (group.members as any[]).filter((m: any) => !m.userId.equals(uid));
            await GroupMessageModel.updateMany(
                { groupId: group._id, senderId: uid, deletedAt: null },
                { $set: { deletedAt: new Date() } },
            );
            if (remainingMembers.length === 0) {
                await GroupMessageModel.deleteMany({ groupId: group._id });
                await GroupConversationModel.findByIdAndDelete(group._id);
            } else {
                const update: any = { $pull: { members: { userId: uid } } };
                if ((group.adminId as any).equals(uid)) {
                    update.$set = { adminId: remainingMembers[0].userId };
                }
                await GroupConversationModel.findByIdAndUpdate(group._id, update);
            }
        }

        // Delete the user document
        await UserController.deleteAccount(userId);

        // Destroy the session
        req.session.destroy(() => {});
        res.json({ success: true });
    } catch (error: any) {
        console.error('Error deleting account:', error);
        res.status(500).json({ success: false, message: 'Failed to delete account.' });
    }
});

// Return a user's avatar by their id (used by the chat UI)
app.get('/user/:userId/avatar', requireAuth, async (req: Request, res: Response) => {
    try {
        const user = await UserController.getUserById(req.params.userId);
        if (!user) {
            res.status(404).json({ success: false, message: 'User not found.' });
            return;
        }
        res.json({ success: true, profilePicture: (user as any).profilePicture ?? null });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Search user by exact username (used by group invite)
app.get('/user/search', requireAuth, async (req: Request, res: Response) => {
    const username = typeof req.query.username === 'string' ? req.query.username.trim() : '';
    if (!username) {
        res.status(400).json({ success: false, message: 'username query param is required.' });
        return;
    }
    try {
        const user = await UserController.getUserByUsername(username);
        if (!user) {
            res.json({ success: false, message: 'User not found.' });
            return;
        }
        res.json({ success: true, userId: (user as any)._id.toString(), username: user.username });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/friends', requireAuth, async (req: Request, res: Response) => {
    try {
        const userId = req.session.userId!;
        const [friends, incomingRequests] = await Promise.all([
            FriendController.getFriends(userId),
            FriendController.getPendingIncomingRequests(userId),
        ]);
        res.render('friends', {
            title: 'Friends List',
            script: 'friends',
            friends: (friends as any[]).map(f => ({
                id: f._id.toString(),
                username: f.username,
                publicKey: f.publicKey,
            })),
            incomingRequests: incomingRequests.map((r: any) => ({
                requestId: r._id.toString(),
                username: (r.fromUserId as any).username,
                publicKey: (r.fromUserId as any).publicKey,
            })),
        });
    } catch (error) {
        console.error('Error loading friends page:', error);
        res.status(500).send('Internal server error.');
    }
});

app.post('/friends/request', requireAuth, async (req: Request, res: Response) => {
    const { publicKey } = req.body;
    if (!publicKey) {
        res.status(400).json({ success: false, message: 'Public key is required.' });
        return;
    }
    try {
        const request = await FriendController.sendFriendRequest(req.session.userId!, publicKey);
        const sender = await UserController.getUserById(req.session.userId!);
        if (sender) {
            const notif = await NotificationController.create(
                (request.toUserId as any).toString(),
                'friend_request',
                'New friend request',
                `${sender.username} sent you a friend request.`,
                '/friends',
            );
            broadcastToUser((request.toUserId as any).toString(), {
                type: 'new_notification',
                notification: {
                    id: notif._id.toString(),
                    type: notif.type,
                    title: notif.title,
                    body: notif.body,
                    link: notif.link,
                    read: notif.read,
                    createdAt: notif.createdAt,
                },
            });
        }
        res.json({ success: true, message: 'Friend request sent.' });
    } catch (error: any) {
        res.status(400).json({ success: false, message: error.message });
    }
});

app.post('/friends/accept/:requestId', requireAuth, async (req: Request, res: Response) => {
    try {
        await FriendController.acceptFriendRequest(req.params.requestId, req.session.userId!);
        res.json({ success: true, message: 'Friend request accepted.' });
    } catch (error: any) {
        res.status(400).json({ success: false, message: error.message });
    }
});

app.post('/friends/decline/:requestId', requireAuth, async (req: Request, res: Response) => {
    try {
        await FriendController.declineFriendRequest(req.params.requestId, req.session.userId!);
        res.json({ success: true, message: 'Friend request declined.' });
    } catch (error: any) {
        res.status(400).json({ success: false, message: error.message });
    }
});

app.post('/friends/remove/:friendId', requireAuth, async (req: Request, res: Response) => {
    try {
        await FriendController.removeFriend(req.session.userId!, req.params.friendId);
        res.json({ success: true, message: 'Friend removed.' });
    } catch (error: any) {
        res.status(400).json({ success: false, message: error.message });
    }
});

// JSON endpoint used by the chat friend-picker
app.get('/friends/list', requireAuth, async (req: Request, res: Response) => {
    try {
        const friends = await FriendController.getFriends(req.session.userId!);
        res.json({
            success: true,
            friends: (friends as any[]).map(f => ({ id: f._id.toString(), username: f.username })),
        });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ── Chat routes ─────────────────────────────────────────────────────────────

app.get('/chat', requireAuth, async (req: Request, res: Response) => {
    try {
        const userId = req.session.userId!;
        const [conversations, groups] = await Promise.all([
            ChatController.getConversationsForUser(userId),
            GroupController.getGroupsForUser(userId),
        ]);

        const serializedDMs = conversations.map((c: any) => ({
            id: c._id.toString(),
            type: 'dm',
            otherUsername: c.other?.username ?? 'Unknown',
            lastMessageAt: c.lastMessageAt ? new Date(c.lastMessageAt).toLocaleString() : null,
            pinned: c.pinned,
            muted: c.muted,
        }));

        const serializedGroups = groups.map((g: any) => {
            const memberList = g.members.map((m: any) => m.userId?.username ?? '').filter(Boolean).join(', ');
            return {
                id: g._id.toString(),
                type: 'group',
                otherUsername: g.name ?? memberList,
                memberList,
                lastMessageAt: g.lastMessageAt ? new Date(g.lastMessageAt).toLocaleString() : null,
                pinned: (g.pinnedBy ?? []).some((p: any) => p.equals(new mongoose.Types.ObjectId(userId))),
                muted: (g.mutedBy ?? []).some((p: any) => p.equals(new mongoose.Types.ObjectId(userId))),
                adminId: g.adminId?.toString() ?? null,
            };
        });

        // Merge and sort: pinned first, then by lastMessageAt
        const allConvos = [...serializedDMs, ...serializedGroups].sort((a: any, b: any) => {
            if (a.pinned && !b.pinned) return -1;
            if (!a.pinned && b.pinned) return 1;
            if (a.lastMessageAt && b.lastMessageAt) return new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime();
            if (a.lastMessageAt) return -1;
            if (b.lastMessageAt) return 1;
            return 0;
        });

        res.render('chat', {
            title: 'Chat',
            script: 'chat',
            conversations: allConvos,
            currentUserId: userId,
            iceServersJson: ICE_SERVERS_JSON,
        });
    } catch (error) {
        console.error('Error loading chat page:', error);
        res.status(500).send('Internal server error.');
    }
});

// Start or open a conversation with a friend by their userId
app.post('/chat/start', requireAuth, async (req: Request, res: Response) => {
    const { friendId } = req.body;
    if (!friendId) {
        res.status(400).json({ success: false, message: 'friendId is required.' });
        return;
    }
    try {
        const conv = await ChatController.getOrCreateConversation(req.session.userId!, friendId);
        // If this user previously closed (hid) the conversation, un-hide it now
        await ConversationModel.findByIdAndUpdate(conv._id, {
            $pull: { hiddenBy: new mongoose.Types.ObjectId(req.session.userId!) },
        });
        res.json({ success: true, conversationId: conv._id.toString() });
    } catch (error: any) {
        res.status(400).json({ success: false, message: error.message });
    }
});

// Get messages for a conversation
app.get('/chat/:conversationId/messages', requireAuth, async (req: Request, res: Response) => {
    try {
        const messages = await ChatController.getMessages(
            req.params.conversationId,
            req.session.userId!
        );
        const serialized = messages.map((m: any) => ({
            id: m._id.toString(),
            senderUsername: m.senderId?.username ?? 'Unknown',
            senderId: m.senderId?._id?.toString(),
            content: m.deletedAt ? null : m.content,
            deleted: !!m.deletedAt,
            createdAt: new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            createdAtMs: new Date(m.createdAt).getTime(),
            readBy: (m.readBy ?? []).map((r: any) => ({
                userId: r.userId?._id?.toString() ?? r.userId?.toString(),
                username: r.userId?.username ?? 'Unknown',
                readAt: r.readAt ? new Date(r.readAt).toISOString() : null,
            })),
            reactions: (m.reactions ?? []).map((r: any) => ({
                emoji: r.emoji,
                users: (r.users ?? []).map((uid: any) => uid.toString()),
            })),
            attachment: serializeAttachment(m.attachment),
        }));
        res.json({ success: true, messages: serialized });
    } catch (error: any) {
        res.status(400).json({ success: false, message: error.message });
    }
});

// Upload an encrypted attachment for a DM conversation (client-side encrypted before upload)
app.post('/chat/:conversationId/attachments/upload', requireAuth, async (req: Request, res: Response) => {
    try {
        const userId = req.session.userId!;
        const conversationId = req.params.conversationId;

        const isAllowed = await isUserAuthorizedForConversationScope(userId, 'dm', conversationId);
        if (!isAllowed) {
            res.status(403).json({ success: false, message: 'Unauthorized.' });
            return;
        }

        const headers = parseAttachmentUploadHeaders(req);
        const attachment = await uploadEncryptedAttachmentToGridFS(
            req,
            userId,
            'dm',
            conversationId,
            headers,
        );

        res.json({ success: true, attachment });
    } catch (error: any) {
        res.status(400).json({ success: false, message: error.message });
    }
});

// Mark all messages in a conversation as read for the current user
app.post('/chat/:conversationId/read', requireAuth, async (req: Request, res: Response) => {
    try {
        const uid = req.session.userId!;
        const { readAt } = await ChatController.markMessagesRead(req.params.conversationId, uid);

        const conv = await ConversationModel.findById(req.params.conversationId);
        const sender = await UserController.getUserById(uid);
        if (conv && sender) {
            const wsMsg = {
                type: 'read_receipt',
                conversationId: req.params.conversationId,
                userId: uid,
                username: sender.username,
                readAt: readAt.toISOString(),
            };
            for (const participantId of conv.participants as any[]) {
                broadcastToUser(participantId.toString(), wsMsg);
            }
        }
        res.json({ success: true });
    } catch (error: any) {
        res.status(400).json({ success: false, message: error.message });
    }
});

// Send a message
app.post('/chat/:conversationId/messages', requireAuth, async (req: Request, res: Response) => {
    const { content, attachment } = req.body;
    if (!content && !attachment) {
        res.status(400).json({ success: false, message: 'content or attachment is required.' });
        return;
    }
    try {
        const message = await ChatController.sendMessage(
            req.params.conversationId,
            req.session.userId!,
            typeof content === 'string' ? content : '',
            attachment,
        );

        // Broadcast new message to all participants via WebSocket
        const conv = await ConversationModel.findById(req.params.conversationId);
        const sender = await UserController.getUserById(req.session.userId!);
        if (conv && sender) {
            const wsMsg = {
                type: 'new_message',
                conversationId: req.params.conversationId,
                message: {
                    id: message._id.toString(),
                    senderUsername: sender.username,
                    senderId: req.session.userId!,
                    content: (message as any).content,
                    deleted: false,
                    createdAt: new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                    createdAtMs: new Date(message.createdAt).getTime(),
                    readBy: [],
                    reactions: [],
                    attachment: serializeAttachment((message as any).attachment),
                },
            };
            for (const participantId of conv.participants as any[]) {
                broadcastToUser(participantId.toString(), wsMsg);
            }

            // Create and push a notification to every participant except the sender
            for (const participantId of conv.participants as any[]) {
                const pid = participantId.toString();
                if (pid === req.session.userId!) continue;

                const isMuted = (conv.mutedBy ?? []).some((m: any) => m.equals(participantId));
                if (isMuted) continue;

                // Avoid DM spam when the recipient already has this exact chat open.
                if (userIsViewingConversation(pid, 'dm', req.params.conversationId)) continue;

                const notif = await NotificationController.create(
                    pid,
                    'message',
                    `New message from ${sender.username}`,
                    '',
                    `/chat?open=${req.params.conversationId}&type=dm`,
                );
                broadcastToUser(pid, {
                    type: 'new_notification',
                    notification: {
                        id: notif._id.toString(),
                        type: notif.type,
                        title: notif.title,
                        body: notif.body,
                        link: notif.link,
                        read: notif.read,
                        createdAt: notif.createdAt,
                    },
                });
            }
        }

        res.json({ success: true, messageId: message._id.toString() });
    } catch (error: any) {
        res.status(400).json({ success: false, message: error.message });
    }
});

// Soft-delete a message
app.delete('/chat/:conversationId/messages/:messageId', requireAuth, async (req: Request, res: Response) => {
    try {
        const deletedMessage = await ChatController.deleteMessage(req.params.messageId, req.session.userId!);

        // Broadcast deletion to all participants via WebSocket
        const conv = await ConversationModel.findById(req.params.conversationId);
        if (conv) {
            const wsMsg = {
                type: 'message_deleted',
                conversationId: req.params.conversationId,
                messageId: req.params.messageId,
            };
            for (const participantId of conv.participants as any[]) {
                broadcastToUser(participantId.toString(), wsMsg);
            }
        }

        await cleanupAttachmentsIfOrphaned([(deletedMessage as any).attachment?.fileId]);

        res.json({ success: true });
    } catch (error: any) {
        res.status(400).json({ success: false, message: error.message });
    }
});

// Toggle reaction on a DM message
app.post('/chat/:conversationId/messages/:messageId/reactions', requireAuth, async (req: Request, res: Response) => {
    const { emoji } = req.body;
    if (!emoji || typeof emoji !== 'string') {
        res.status(400).json({ success: false, message: 'emoji is required.' });
        return;
    }

    try {
        const result = await ChatController.toggleReaction(
            req.params.conversationId,
            req.params.messageId,
            req.session.userId!,
            emoji,
        );

        const conv = await ConversationModel.findById(req.params.conversationId).lean();
        if (conv) {
            const wsMsg = {
                type: 'message_reaction_updated',
                conversationId: req.params.conversationId,
                messageId: req.params.messageId,
                reactions: result.reactions,
            };
            for (const participantId of conv.participants as any[]) {
                broadcastToUser(participantId.toString(), wsMsg);
            }
        }

        res.json({ success: true, ...result });
    } catch (error: any) {
        res.status(400).json({ success: false, message: error.message });
    }
});

// Toggle pin
app.post('/chat/:conversationId/pin', requireAuth, async (req: Request, res: Response) => {
    try {
        const result = await ChatController.togglePin(
            req.params.conversationId,
            req.session.userId!
        );
        res.json({ success: true, ...result });
    } catch (error: any) {
        res.status(400).json({ success: false, message: error.message });
    }
});

// Toggle mute
app.post('/chat/:conversationId/mute', requireAuth, async (req: Request, res: Response) => {
    try {
        const result = await ChatController.toggleMute(
            req.params.conversationId,
            req.session.userId!
        );
        res.json({ success: true, ...result });
    } catch (error: any) {
        res.status(400).json({ success: false, message: error.message });
    }
});

// Close (and optionally delete all messages in) a conversation
app.delete('/chat/:conversationId', requireAuth, async (req: Request, res: Response) => {
    try {
        const deleteMessages = req.body.deleteMessages === true;
        const result = await ChatController.closeConversation(
            req.params.conversationId,
            req.session.userId!,
            deleteMessages,
        );
        if (deleteMessages) {
            await cleanupAttachmentsIfOrphaned((result as any).deletedAttachmentIds ?? []);
        }
        res.json({ success: true });
    } catch (error: any) {
        res.status(400).json({ success: false, message: error.message });
    }
});

// Get the other participant's armored public key for E2E encryption
app.get('/chat/:conversationId/recipient-key', requireAuth, async (req: Request, res: Response) => {
    try {
        const userId = req.session.userId!;
        const conv = await ConversationModel.findById(req.params.conversationId)
            .populate('participants', 'publicKeyArmored username');
        if (!conv) {
            res.status(404).json({ success: false, message: 'Conversation not found.' });
            return;
        }
        const other = (conv.participants as any[]).find(
            (p: any) => p._id.toString() !== userId
        );
        if (!other) {
            res.status(404).json({ success: false, message: 'Recipient not found.' });
            return;
        }
        if (!other.publicKeyArmored) {
            res.status(400).json({ success: false, message: 'Recipient has no armored public key stored. They must re-register.' });
            return;
        }
        res.json({ success: true, publicKeyArmored: other.publicKeyArmored });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ── Notification routes ──────────────────────────────────────────────────────

// List all notifications for the current user
app.get('/notifications', requireAuth, async (req: Request, res: Response) => {
    try {
        const notifications = await NotificationController.getForUser(req.session.userId!);
        res.json({ success: true, notifications });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Mark a single notification as read
app.post('/notifications/:id/read', requireAuth, async (req: Request, res: Response) => {
    try {
        await NotificationController.markRead(req.params.id, req.session.userId!);
        res.json({ success: true });
    } catch (error: any) {
        res.status(400).json({ success: false, message: error.message });
    }
});

// Mark all notifications as read
app.post('/notifications/read-all', requireAuth, async (req: Request, res: Response) => {
    try {
        await NotificationController.markAllRead(req.session.userId!);
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Dismiss (delete) a notification
app.delete('/notifications/:id', requireAuth, async (req: Request, res: Response) => {
    try {
        await NotificationController.dismiss(req.params.id, req.session.userId!);
        res.json({ success: true });
    } catch (error: any) {
        res.status(400).json({ success: false, message: error.message });
    }
});

// Dismiss (delete) all notifications for the current user
app.delete('/notifications', requireAuth, async (req: Request, res: Response) => {
    try {
        const result = await NotificationController.dismissAll(req.session.userId!);
        res.json({ success: true, ...result });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/logout', (req: Request, res: Response) => {
    req.session.destroy((err) => {
        if (err) console.error('Error destroying session:', err);
        res.redirect('/');
    });
});

app.get('/login', (req: Request, res: Response) => {
    res.render('login', { title: 'Login', script: 'login' });
});

app.get('/signup', (req: Request, res: Response) => {
    res.render('signup', { title: 'Sign Up' });
});

app.get('/signup/generate', (req: Request, res: Response) => {
    res.render('generate', { title: 'Generate PGP Key', script: 'generate' });
});

app.post('/signup/generate', (req: Request, res: Response) => {
    const { publicKey, username } = req.body;
    if (!publicKey || !username) {
        res.status(400).json({ success: false, message: 'Public key and username are required.' });
        return;
    }
    // Normalize the public key by removing all whitespace (for dedup lookup)
    const normalizedPublicKey = publicKey.replace(/\s/g, '');

    UserController.createUser(normalizedPublicKey, username, publicKey)
        .then(() => {
            console.log('User created successfully with public key:', normalizedPublicKey);
            res.json({ success: true }); // Respond with JSON on success
        })
        .catch((error) => {
            console.error('Error creating user:', error);
            res.status(500).json({ success: false, message: 'Failed to create user.' });
        });
});

app.get('/signup/import', (req: Request, res: Response) => {
    res.render('import', { title: 'PGP Sign Up', script: 'import' }); 
    // Render the import page with a form to submit PGP key
});

// Handle POST request for importing PGP key
app.post('/signup/import', (req: Request, res: Response) => {
    console.log('body:', req.body); // Log the request body for debugging
    // Access form data from req.body
    const publicKey = req.body.publicKey; // Assuming public key is sent in the body
    const username = req.body.username; // Assuming username is sent in the body
    if (!publicKey || !username) {
        res.status(400).json({ success: false, message: 'Public key and username are required.' });
        return;
    }
    // Call UserController to create a new user with the provided public key and username
    const normalizedImportKey = publicKey.replace(/\s/g, '');
    UserController.createUser(normalizedImportKey, username, publicKey)
        .then(() => {
            console.log('User created successfully with public key:', publicKey);
            res.json({ success: true });
        })
        .catch((error) => {
            console.error('Error creating user:', error);
            res.status(500).json({ success: false, message: 'Failed to create user.' });
        });
});

app.get('/login', async (req: Request, res: Response) => {
    // Render the login page with a form to submit PGP key
    res.render('login', { title: 'Login', script: 'login' });
});

app.get('/login/challenge', async (req: Request, res: Response) => {
    const { publicKey } = req.query; // Use query parameters for GET requests
    if (!publicKey || typeof publicKey !== 'string') {
        res.status(400).json({ success: false, message: 'Public key is required.' });
        return;
    }
    try {
        // Normalize the public key for database lookup
        const normalizedPublicKey = publicKey.replace(/\s/g, '');
        const user = await UserController.getUserByPublicKey(normalizedPublicKey);
        if (!user) {
            res.status(404).json({ success: false, message: 'User not found.' });
            return;
        }

        // Generate a random challenge
        const challenge = crypto.randomBytes(32).toString('hex');
        const challengeId = crypto.randomBytes(16).toString('hex');

        // Encrypt the challenge with the user's public key
        // Use the original, non-normalized publicKey from the request for encryption
        const pgpPublicKey = await openpgp.readKey({ armoredKey: publicKey });
        const message = await openpgp.createMessage({ text: challenge });
        const encryptedChallenge = await openpgp.encrypt({
            message,
            encryptionKeys: pgpPublicKey,
        });

        // Store the challenge data
        pendingChallenges.set(challengeId, {
            challenge,
            publicKey: user.publicKey, // This is the normalized key, which is fine for storage here
            userId: user._id.toString(),
            timestamp: Date.now(),
        });

        // Auto-cleanup after 5 minutes
        setTimeout(() => {
            pendingChallenges.delete(challengeId);
        }, 5 * 60 * 1000);
        
        res.json({ 
            success: true, 
            encryptedChallenge: encryptedChallenge,
            challengeId: challengeId // Send this back to client
        });
    } catch (error) {
        console.error('Error creating challenge:', error);
        res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});

app.post('/login/verify', async (req: Request, res: Response) => {
    const { decryptedChallenge, challengeId } = req.body;
    
    if (!decryptedChallenge || !challengeId) {
        res.status(400).json({ success: false, message: 'Invalid challenge response.' });
        return;
    }
    
    try {
        // Get challenge data
        const challengeData = pendingChallenges.get(challengeId);
        if (!challengeData) {
            res.status(401).json({ success: false, message: 'Challenge not found or expired.' });
            return;
        }
        
        // Verify the decrypted challenge matches the stored challenge
        if (decryptedChallenge === challengeData.challenge) {
            // Set authenticated session
            req.session.authenticated = true;
            req.session.userId = challengeData.userId;
            
            // Remove the used challenge
            pendingChallenges.delete(challengeId);
            
            res.json({ success: true, message: 'Authentication successful.' });
        } else {
            res.status(401).json({ success: false, message: 'Challenge verification failed.' });
        }
    } catch (error) {
        console.error('Error verifying challenge:', error);
        res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});

// ── Group chat routes ─────────────────────────────────────────────────────────

// Create a new group
app.post('/group/create', requireAuth, async (req: Request, res: Response) => {
    const { name, memberIds } = req.body;
    if (!Array.isArray(memberIds) || memberIds.length < 1) {
        res.status(400).json({ success: false, message: 'At least one other member is required.' });
        return;
    }
    try {
        const group = await GroupController.createGroup(req.session.userId!, name ?? null, memberIds);
        res.json({ success: true, groupId: group._id.toString() });
    } catch (err: any) {
        res.status(400).json({ success: false, message: err.message });
    }
});

// Get group info + member list
app.get('/group/:groupId/info', requireAuth, async (req: Request, res: Response) => {
    try {
        const group = await GroupController.getGroupInfo(req.params.groupId, req.session.userId!);
        res.json({ success: true, group });
    } catch (err: any) {
        res.status(400).json({ success: false, message: err.message });
    }
});

// Get the key ring (all members' armored public keys)
app.get('/group/:groupId/keyring', requireAuth, async (req: Request, res: Response) => {
    try {
        const keys = await GroupController.getKeyring(req.params.groupId, req.session.userId!);
        res.json({ success: true, keys });
    } catch (err: any) {
        res.status(400).json({ success: false, message: err.message });
    }
});

// Get messages
app.get('/group/:groupId/messages', requireAuth, async (req: Request, res: Response) => {
    try {
        const messages = await GroupController.getMessages(req.params.groupId, req.session.userId!);
        const serialized = messages.map((m: any) => ({
            id: m._id.toString(),
            senderUsername: m.senderId?.username ?? 'Unknown',
            senderId: m.senderId?._id?.toString(),
            content: m.deletedAt ? null : m.content,
            deleted: !!m.deletedAt,
            createdAt: new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            createdAtMs: new Date(m.createdAt).getTime(),
            readBy: (m.readBy ?? []).map((r: any) => ({
                userId: r.userId?._id?.toString() ?? r.userId?.toString(),
                username: r.userId?.username ?? 'Unknown',
                readAt: r.readAt ? new Date(r.readAt).toISOString() : null,
            })),
            reactions: (m.reactions ?? []).map((r: any) => ({
                emoji: r.emoji,
                users: (r.users ?? []).map((uid: any) => uid.toString()),
            })),
            attachment: serializeAttachment(m.attachment),
        }));
        res.json({ success: true, messages: serialized });
    } catch (err: any) {
        res.status(400).json({ success: false, message: err.message });
    }
});

// Upload an encrypted attachment for a group conversation (client-side encrypted before upload)
app.post('/group/:groupId/attachments/upload', requireAuth, async (req: Request, res: Response) => {
    try {
        const userId = req.session.userId!;
        const groupId = req.params.groupId;

        const isAllowed = await isUserAuthorizedForConversationScope(userId, 'group', groupId);
        if (!isAllowed) {
            res.status(403).json({ success: false, message: 'Unauthorized.' });
            return;
        }

        const headers = parseAttachmentUploadHeaders(req);
        const attachment = await uploadEncryptedAttachmentToGridFS(
            req,
            userId,
            'group',
            groupId,
            headers,
        );

        res.json({ success: true, attachment });
    } catch (error: any) {
        res.status(400).json({ success: false, message: error.message });
    }
});

// Mark all messages in a group as read for the current user
app.post('/group/:groupId/read', requireAuth, async (req: Request, res: Response) => {
    try {
        const uid = req.session.userId!;
        const { readAt } = await GroupController.markMessagesRead(req.params.groupId, uid);

        const group = await GroupConversationModel.findById(req.params.groupId).lean();
        const user = await UserController.getUserById(uid);
        if (group && user) {
            const wsMsg = {
                type: 'group_read_receipt',
                groupId: req.params.groupId,
                userId: uid,
                username: user.username,
                readAt: readAt.toISOString(),
            };
            for (const m of group.members as any[]) {
                broadcastToUser(m.userId.toString(), wsMsg);
            }
        }
        res.json({ success: true });
    } catch (err: any) {
        res.status(400).json({ success: false, message: err.message });
    }
});

// Send a message to a group
app.post('/group/:groupId/messages', requireAuth, async (req: Request, res: Response) => {
    const { content, attachment } = req.body;
    if (!content && !attachment) {
        res.status(400).json({ success: false, message: 'content or attachment is required.' });
        return;
    }
    try {
        const message = await GroupController.sendMessage(
            req.params.groupId,
            req.session.userId!,
            typeof content === 'string' ? content : '',
            attachment,
        );
        const sender = await UserController.getUserById(req.session.userId!);
        const group = await GroupConversationModel.findById(req.params.groupId);

        if (group && sender) {
            const wsMsg = {
                type: 'new_group_message',
                groupId: req.params.groupId,
                message: {
                    id: message._id.toString(),
                    senderUsername: sender.username,
                    senderId: req.session.userId!,
                    content: (message as any).content,
                    deleted: false,
                    createdAt: new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                    createdAtMs: new Date(message.createdAt).getTime(),
                    readBy: [],
                    reactions: [],
                    attachment: serializeAttachment((message as any).attachment),
                },
            };
            for (const m of group.members as any[]) {
                broadcastToUser(m.userId.toString(), wsMsg);
            }

            // Create notifications for every member except sender, respecting per-group mute
            for (const m of group.members as any[]) {
                const recipientId = m.userId.toString();
                if (recipientId === req.session.userId!) continue;

                const isMuted = (group.mutedBy ?? []).some((uid: any) => uid.equals(m.userId));
                if (isMuted) continue;

                 // Avoid group-chat notification spam when the recipient already has this group open.
                if (userIsViewingConversation(recipientId, 'group', req.params.groupId)) continue;

                const notif = await NotificationController.create(
                    recipientId,
                    'message',
                    `New message in group from ${sender.username}`,
                    '',
                    `/chat?open=${req.params.groupId}&type=group`,
                );
                broadcastToUser(recipientId, {
                    type: 'new_notification',
                    notification: {
                        id: notif._id.toString(),
                        type: notif.type,
                        title: notif.title,
                        body: notif.body,
                        link: notif.link,
                        read: notif.read,
                        createdAt: notif.createdAt,
                    },
                });
            }
        }

        res.json({ success: true, messageId: message._id.toString() });
    } catch (err: any) {
        res.status(400).json({ success: false, message: err.message });
    }
});

// Soft-delete a group message
app.delete('/group/:groupId/messages/:messageId', requireAuth, async (req: Request, res: Response) => {
    try {
        const deletedMessage = await GroupController.deleteMessage(req.params.messageId, req.session.userId!);
        const group = await GroupConversationModel.findById(req.params.groupId);
        if (group) {
            const wsMsg = {
                type: 'group_message_deleted',
                groupId: req.params.groupId,
                messageId: req.params.messageId,
            };
            for (const m of group.members as any[]) {
                broadcastToUser(m.userId.toString(), wsMsg);
            }
        }
        await cleanupAttachmentsIfOrphaned([(deletedMessage as any).attachment?.fileId]);
        res.json({ success: true });
    } catch (err: any) {
        res.status(400).json({ success: false, message: err.message });
    }
});

// Toggle reaction on a group message
app.post('/group/:groupId/messages/:messageId/reactions', requireAuth, async (req: Request, res: Response) => {
    const { emoji } = req.body;
    if (!emoji || typeof emoji !== 'string') {
        res.status(400).json({ success: false, message: 'emoji is required.' });
        return;
    }

    try {
        const result = await GroupController.toggleReaction(
            req.params.groupId,
            req.params.messageId,
            req.session.userId!,
            emoji,
        );

        const group = await GroupConversationModel.findById(req.params.groupId).lean();
        if (group) {
            const wsMsg = {
                type: 'group_message_reaction_updated',
                groupId: req.params.groupId,
                messageId: req.params.messageId,
                reactions: result.reactions,
            };
            for (const m of group.members as any[]) {
                broadcastToUser(m.userId.toString(), wsMsg);
            }
        }

        res.json({ success: true, ...result });
    } catch (error: any) {
        res.status(400).json({ success: false, message: error.message });
    }
});

// Invite a member (any member can invite)
app.post('/group/:groupId/invite', requireAuth, async (req: Request, res: Response) => {
    const { targetUserId } = req.body;
    if (!targetUserId) {
        res.status(400).json({ success: false, message: 'targetUserId is required.' });
        return;
    }
    try {
        const newMember = await GroupController.inviteMember(req.params.groupId, req.session.userId!, targetUserId);
        const group = await GroupConversationModel.findById(req.params.groupId).lean();
        const inviter = await UserController.getUserById(req.session.userId!);

        // Notify all current members (including the new one) of the addition
        const wsMsg = {
            type: 'group_member_added',
            groupId: req.params.groupId,
            member: { id: (newMember as any)._id.toString(), username: newMember.username },
        };
        if (group) {
            for (const m of group.members as any[]) {
                broadcastToUser(m.userId.toString(), wsMsg);
            }
        }
        // Also notify the newly added user
        broadcastToUser((newMember as any)._id.toString(), wsMsg);

        // Send notification to the invited user
        if (inviter) {
            await NotificationController.create(
                (newMember as any)._id.toString(),
                'group_invite',
                `Added to group chat`,
                `${inviter.username} added you to a group chat.`,
                `/chat`,
            );
        }

        res.json({ success: true, member: { id: (newMember as any)._id.toString(), username: newMember.username } });
    } catch (err: any) {
        res.status(400).json({ success: false, message: err.message });
    }
});

// Remove a member — admin only
app.delete('/group/:groupId/members/:memberId', requireAuth, async (req: Request, res: Response) => {
    try {
        const result = await GroupController.removeMember(req.params.groupId, req.session.userId!, req.params.memberId);
        const group = await GroupConversationModel.findById(req.params.groupId).lean();
        const wsMsg = {
            type: 'group_member_removed',
            groupId: req.params.groupId,
            memberId: req.params.memberId,
        };
        if (group) {
            for (const m of group.members as any[]) {
                broadcastToUser(m.userId.toString(), wsMsg);
            }
        }
        broadcastToUser(req.params.memberId, wsMsg);
        await cleanupAttachmentsIfOrphaned((result as any).deletedAttachmentIds ?? []);
        res.json({ success: true });
    } catch (err: any) {
        res.status(400).json({ success: false, message: err.message });
    }
});

// Leave a group
app.post('/group/:groupId/leave', requireAuth, async (req: Request, res: Response) => {
    try {
        // Capture members before leave so we can broadcast to all of them
        const groupBefore = await GroupConversationModel.findById(req.params.groupId).lean();
        const result = await GroupController.leaveGroup(req.params.groupId, req.session.userId!);

        if (groupBefore) {
            const wsMsg = {
                type: 'group_member_removed',
                groupId: req.params.groupId,
                memberId: req.session.userId!,
            };
            for (const m of groupBefore.members as any[]) {
                broadcastToUser(m.userId.toString(), wsMsg);
            }
        }
        await cleanupAttachmentsIfOrphaned((result as any).deletedAttachmentIds ?? []);
        res.json({ success: true });
    } catch (err: any) {
        res.status(400).json({ success: false, message: err.message });
    }
});

// Toggle pin for a group
app.post('/group/:groupId/pin', requireAuth, async (req: Request, res: Response) => {
    try {
        const result = await GroupController.togglePin(req.params.groupId, req.session.userId!);
        res.json({ success: true, ...result });
    } catch (err: any) {
        res.status(400).json({ success: false, message: err.message });
    }
});

// Toggle mute for a group
app.post('/group/:groupId/mute', requireAuth, async (req: Request, res: Response) => {
    try {
        const result = await GroupController.toggleMute(req.params.groupId, req.session.userId!);
        res.json({ success: true, ...result });
    } catch (err: any) {
        res.status(400).json({ success: false, message: err.message });
    }
});

// Delete a group — admin only
app.delete('/group/:groupId', requireAuth, async (req: Request, res: Response) => {
    try {
        const group = await GroupConversationModel.findById(req.params.groupId).lean();
        const result = await GroupController.deleteGroup(req.params.groupId, req.session.userId!);

        if (group) {
            const wsMsg = { type: 'group_deleted', groupId: req.params.groupId };
            for (const m of group.members as any[]) {
                broadcastToUser(m.userId.toString(), wsMsg);
            }
        }
        await cleanupAttachmentsIfOrphaned((result as any).deletedAttachmentIds ?? []);
        res.json({ success: true });
    } catch (err: any) {
        res.status(400).json({ success: false, message: err.message });
    }
});

// Rename a group — any member
app.patch('/group/:groupId/name', requireAuth, async (req: Request, res: Response) => {
    const { name } = req.body;
    try {
        const result = await GroupController.renameGroup(req.params.groupId, req.session.userId!, name ?? null);
        const group = await GroupConversationModel.findById(req.params.groupId).lean();
        if (group) {
            const wsMsg = { type: 'group_renamed', groupId: req.params.groupId, name: result.name };
            for (const m of group.members as any[]) {
                broadcastToUser(m.userId.toString(), wsMsg);
            }
        }
        res.json({ success: true, name: result.name });
    } catch (err: any) {
        res.status(400).json({ success: false, message: err.message });
    }
});

// Download encrypted attachment bytes (client decrypts with local private key)
app.get('/attachments/:attachmentId', requireAuth, async (req: Request, res: Response) => {
    try {
        const userId = req.session.userId!;
        const attachmentId = req.params.attachmentId;

        if (!ObjectId.isValid(attachmentId)) {
            res.status(400).json({ success: false, message: 'Invalid attachment id.' });
            return;
        }

        const bucket = getAttachmentBucket();
        const fileId = new ObjectId(attachmentId);
        const files = await bucket.find({ _id: fileId }).toArray();
        if (!files.length) {
            res.status(404).json({ success: false, message: 'Attachment not found.' });
            return;
        }

        const file = files[0];
        const metadata = (file.metadata ?? {}) as {
            conversationType?: ConversationScopeType;
            conversationId?: string;
            originalFileName?: string;
            originalMimeType?: string;
            originalSize?: number;
        };

        const liveReference = await findLiveAttachmentReference(fileId);
        if (!liveReference) {
            await cleanupAttachmentIfOrphaned(fileId);
            res.status(404).json({ success: false, message: 'Attachment not found.' });
            return;
        }

        if (!metadata.conversationType || !metadata.conversationId) {
            res.status(400).json({ success: false, message: 'Attachment metadata is invalid.' });
            return;
        }

        if (metadata.conversationType !== liveReference.conversationType || metadata.conversationId !== liveReference.conversationId) {
            res.status(400).json({ success: false, message: 'Attachment metadata mismatch.' });
            return;
        }

        const isAllowed = await isUserAuthorizedForConversationScope(
            userId,
            metadata.conversationType,
            metadata.conversationId,
        );
        if (!isAllowed) {
            res.status(403).json({ success: false, message: 'Unauthorized.' });
            return;
        }

        const safeName = safeAttachmentFilename(metadata.originalFileName ?? file.filename ?? 'attachment.bin');
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}.pgp"`);
        res.setHeader('X-Attachment-Name', encodeURIComponent(safeName));
        res.setHeader('X-Attachment-Mime', metadata.originalMimeType ?? 'application/octet-stream');
        res.setHeader('X-Attachment-Size', String(metadata.originalSize ?? 0));

        const downloadStream = bucket.openDownloadStream(fileId);
        downloadStream.on('error', () => {
            if (!res.headersSent) {
                res.status(500).json({ success: false, message: 'Failed to stream attachment.' });
            } else {
                res.end();
            }
        });
        downloadStream.pipe(res);
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

//create protected route by using middleware
app.use('/protected', requireAuth, (req: Request, res: Response) => {
    res.render('test', { title: 'Test PGP', script: 'test' });
});

// Serve the 404 page for any unmatched routes
app.use((req: Request, res: Response) => {
    res.status(404).render('404', { title: '404 Not Found' });
});


// You can still add other API routes if needed, for example:
app.get('/api/data', (req: Request, res: Response) => {
  res.json({ message: 'This is an API endpoint!' });
});


// ── HTTP + WebSocket server ───────────────────────────────────────────────────
const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const rawSid = cookies['connect.sid'];
    if (!rawSid) { ws.close(1008, 'Unauthorized'); return; }

    const sessionId = unsignSessionCookie(rawSid, session_secret);
    if (!sessionId) { ws.close(1008, 'Unauthorized'); return; }

    sessionStore.get(sessionId, async (err, sess) => {
        try {
            if (err || !sess?.authenticated || !sess?.userId) {
                ws.close(1008, 'Unauthorized');
                return;
            }
            const userId = sess.userId;
            const user = await UserModel.findById(userId).select('username').lean();
            const username = user?.username ?? 'Unknown';

            addUserSocket(userId, ws);
            socketState.set(ws, { userId, username, activeCallRoomKey: null, activeChatView: null });

            // Track whether this client is still alive between pings
            (ws as any).isAlive = true;
            ws.on('message', async (data) => {
                if (data.toString() === '__pong__') {
                    (ws as any).isAlive = true;
                    return;
                }

                let parsed: any;
                try {
                    parsed = JSON.parse(data.toString());
                } catch {
                    return;
                }

                await handleCallSocketMessage(ws, parsed);
            });

            ws.on('close', () => {
                removeSocketFromCall(ws, 'disconnect');
                clearPendingCallInvitesForUser(userId);
                socketState.delete(ws);
                removeUserSocket(userId, ws);
            });
            ws.on('error', () => {
                removeSocketFromCall(ws, 'disconnect');
                clearPendingCallInvitesForUser(userId);
                socketState.delete(ws);
                removeUserSocket(userId, ws);
            });
        } catch {
            ws.close(1011, 'Session setup failed');
        }
    });
});

// Ping all clients every 30 s; terminate any that haven't responded since the last ping
const wsPingInterval = setInterval(() => {
    for (const ws of wss.clients) {
        if ((ws as any).isAlive === false) {
            ws.terminate();
            continue;
        }
        (ws as any).isAlive = false;
        ws.send('__ping__');
    }
}, 30_000);

wss.on('close', () => clearInterval(wsPingInterval));

server.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
    console.log(`Serving static files from: ${path.join(__dirname, 'public')}`);
});
