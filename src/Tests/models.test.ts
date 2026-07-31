import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import UserModel from '../Models/UserModel';
import ConversationModel from '../Models/ConversationModel';
import MessageModel from '../Models/MessageModel';
import FriendRequestModel from '../Models/FriendRequestModel';
import NotificationModel from '../Models/NotificationModel';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri(), { dbName: 'test' });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Promise.all([
    UserModel.deleteMany({}),
    ConversationModel.deleteMany({}),
    MessageModel.deleteMany({}),
    FriendRequestModel.deleteMany({}),
    NotificationModel.deleteMany({}),
  ]);
});

// ── UserModel ─────────────────────────────────────────────────────────────────
describe('UserModel', () => {
  it('creates a user with required fields', async () => {
    const user = await UserModel.create({ publicKey: 'key1', username: 'user1' });
    expect(user.publicKey).toBe('key1');
    expect(user.username).toBe('user1');
    expect(user.publicKeyArmored).toBeNull();
    expect(user.friends).toEqual([]);
  });

  it('rejects a missing publicKey', async () => {
    await expect(UserModel.create({ username: 'nokey' })).rejects.toThrow();
  });

  it('rejects a missing username', async () => {
    await expect(UserModel.create({ publicKey: 'nousernamekey' })).rejects.toThrow();
  });

  it('enforces unique publicKey constraint', async () => {
    await UserModel.create({ publicKey: 'dupkey', username: 'first' });
    await expect(UserModel.create({ publicKey: 'dupkey', username: 'second' })).rejects.toThrow();
  });

  it('enforces unique username constraint', async () => {
    await UserModel.create({ publicKey: 'key-a', username: 'dupuser' });
    await expect(UserModel.create({ publicKey: 'key-b', username: 'dupuser' })).rejects.toThrow();
  });

  it('stores publicKeyArmored when provided', async () => {
    const user = await UserModel.create({ publicKey: 'key2', username: 'user2', publicKeyArmored: 'armored' });
    expect(user.publicKeyArmored).toBe('armored');
  });

  it('defaults friends to an empty array', async () => {
    const user = await UserModel.create({ publicKey: 'key3', username: 'user3' });
    expect(Array.isArray(user.friends)).toBe(true);
    expect(user.friends).toHaveLength(0);
  });
});

// ── ConversationModel ─────────────────────────────────────────────────────────
describe('ConversationModel', () => {
  let idA: mongoose.Types.ObjectId;
  let idB: mongoose.Types.ObjectId;

  beforeEach(() => {
    idA = new mongoose.Types.ObjectId();
    idB = new mongoose.Types.ObjectId();
  });

  it('creates a conversation with two participants', async () => {
    const conv = await ConversationModel.create({ participants: [idA, idB] });
    expect(conv.participants).toHaveLength(2);
  });

  it('defaults pinnedBy, hiddenBy, and mutedBy to empty arrays', async () => {
    const conv = await ConversationModel.create({ participants: [idA, idB] });
    expect(conv.pinnedBy).toEqual([]);
    expect(conv.hiddenBy).toEqual([]);
    expect(conv.mutedBy).toEqual([]);
  });

  it('defaults lastMessageAt to null', async () => {
    const conv = await ConversationModel.create({ participants: [idA, idB] });
    expect(conv.lastMessageAt).toBeNull();
  });

  it('rejects participants array with fewer than 2 entries', async () => {
    await expect(ConversationModel.create({ participants: [idA] })).rejects.toThrow();
  });

  it('rejects participants array with more than 2 entries', async () => {
    const idC = new mongoose.Types.ObjectId();
    await expect(ConversationModel.create({ participants: [idA, idB, idC] })).rejects.toThrow();
  });
});

// ── MessageModel ──────────────────────────────────────────────────────────────
describe('MessageModel', () => {
  let convId: mongoose.Types.ObjectId;
  let senderId: mongoose.Types.ObjectId;

  beforeEach(() => {
    convId   = new mongoose.Types.ObjectId();
    senderId = new mongoose.Types.ObjectId();
  });

  it('creates a message with required fields', async () => {
    const msg = await MessageModel.create({ conversationId: convId, senderId, content: 'Hello' });
    expect(msg.content).toBe('Hello');
    expect(msg.deletedAt).toBeNull();
  });

  it('rejects a missing conversationId', async () => {
    await expect(MessageModel.create({ senderId, content: 'x' })).rejects.toThrow();
  });

  it('rejects a missing senderId', async () => {
    await expect(MessageModel.create({ conversationId: convId, content: 'x' })).rejects.toThrow();
  });

  it('rejects a missing content', async () => {
    await expect(MessageModel.create({ conversationId: convId, senderId })).rejects.toThrow();
  });

  it('defaults deletedAt to null', async () => {
    const msg = await MessageModel.create({ conversationId: convId, senderId, content: 'Hi' });
    expect(msg.deletedAt).toBeNull();
  });

  it('stores attachment metadata when provided', async () => {
    const attachmentId = new mongoose.Types.ObjectId();
    const msg = await MessageModel.create({
      conversationId: convId,
      senderId,
      content: '[Attachment]',
      attachment: {
        fileId: attachmentId,
        fileName: 'archive.zip',
        mimeType: 'application/zip',
        sizeBytes: 2048,
        encryptedSizeBytes: 4096,
      },
    });

    expect((msg as any).attachment.fileId.toString()).toBe(attachmentId.toString());
    expect((msg as any).attachment.fileName).toBe('archive.zip');
    expect((msg as any).attachment.encryptedSizeBytes).toBe(4096);
  });
});

// ── FriendRequestModel ────────────────────────────────────────────────────────
describe('FriendRequestModel', () => {
  let from: mongoose.Types.ObjectId;
  let to: mongoose.Types.ObjectId;

  beforeEach(() => {
    from = new mongoose.Types.ObjectId();
    to   = new mongoose.Types.ObjectId();
  });

  it('creates a friend request with default pending status', async () => {
    const req = await FriendRequestModel.create({ fromUserId: from, toUserId: to });
    expect(req.status).toBe('pending');
  });

  it('accepts accepted and declined statuses', async () => {
    const a = await FriendRequestModel.create({ fromUserId: from, toUserId: to, status: 'accepted' });
    expect(a.status).toBe('accepted');
    await FriendRequestModel.deleteMany({});
    const d = await FriendRequestModel.create({ fromUserId: from, toUserId: to, status: 'declined' });
    expect(d.status).toBe('declined');
  });

  it('rejects an invalid status value', async () => {
    await expect(
      FriendRequestModel.create({ fromUserId: from, toUserId: to, status: 'ignored' }),
    ).rejects.toThrow();
  });

  it('rejects a missing fromUserId', async () => {
    await expect(FriendRequestModel.create({ toUserId: to })).rejects.toThrow();
  });

  it('rejects a missing toUserId', async () => {
    await expect(FriendRequestModel.create({ fromUserId: from })).rejects.toThrow();
  });

  it('enforces the unique index on (fromUserId, toUserId)', async () => {
    await FriendRequestModel.create({ fromUserId: from, toUserId: to });
    await expect(FriendRequestModel.create({ fromUserId: from, toUserId: to })).rejects.toThrow();
  });
});

// ── NotificationModel ─────────────────────────────────────────────────────────
describe('NotificationModel', () => {
  const userId = new mongoose.Types.ObjectId();

  it('creates a notification with required fields', async () => {
    const n = await NotificationModel.create({
      userId,
      type: 'message',
      title: 'New message',
      body: 'Someone sent you a message',
      link: '/chat/123',
    });
    expect(n.userId.toString()).toBe(userId.toString());
    expect(n.type).toBe('message');
    expect(n.read).toBe(false);
  });

  it('accepts friend_request type', async () => {
    const n = await NotificationModel.create({ userId, type: 'friend_request', title: 'Request' });
    expect(n.type).toBe('friend_request');
  });

  it('rejects invalid type', async () => {
    await expect(
      NotificationModel.create({ userId, type: 'unknown', title: 'Bad' }),
    ).rejects.toThrow();
  });

  it('rejects a missing userId', async () => {
    await expect(NotificationModel.create({ type: 'message', title: 'No user' })).rejects.toThrow();
  });

  it('rejects a missing title', async () => {
    await expect(NotificationModel.create({ userId, type: 'message' })).rejects.toThrow();
  });

  it('defaults body and link to empty strings', async () => {
    const n = await NotificationModel.create({ userId, type: 'message', title: 'Minimal' });
    expect(n.body).toBe('');
    expect(n.link).toBe('');
  });

  it('defaults read to false', async () => {
    const n = await NotificationModel.create({ userId, type: 'message', title: 'Unread' });
    expect(n.read).toBe(false);
  });
});
