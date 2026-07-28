import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import ChatController from '../Controllers/ChatController';
import UserController from '../Controllers/UserController';
import ConversationModel from '../Models/ConversationModel';
import MessageModel from '../Models/MessageModel';
import UserModel from '../Models/UserModel';

let mongoServer: MongoMemoryServer;

// Two shared users — recreated for every test block
let userA: any;
let userB: any;
let userC: any;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri(), { dbName: 'test' });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await ConversationModel.deleteMany({});
  await MessageModel.deleteMany({});
  await UserModel.deleteMany({});

  userA = await UserController.createUser('chat-key-a', 'Alice');
  userB = await UserController.createUser('chat-key-b', 'Bob');
  userC = await UserController.createUser('chat-key-c', 'Carol');
});

// ── getOrCreateConversation ───────────────────────────────────────────────────
describe('ChatController.getOrCreateConversation', () => {
  it('creates a new conversation between two users', async () => {
    const conv = await ChatController.getOrCreateConversation(
      userA._id.toString(),
      userB._id.toString(),
    );
    expect(conv).toBeDefined();
    expect(conv.participants.map(String)).toContain(userA._id.toString());
    expect(conv.participants.map(String)).toContain(userB._id.toString());
  });

  it('returns the same conversation on a second call', async () => {
    const first  = await ChatController.getOrCreateConversation(userA._id.toString(), userB._id.toString());
    const second = await ChatController.getOrCreateConversation(userA._id.toString(), userB._id.toString());
    expect(first._id.toString()).toBe(second._id.toString());
  });

  it('returns the same conversation regardless of argument order', async () => {
    const ab = await ChatController.getOrCreateConversation(userA._id.toString(), userB._id.toString());
    const ba = await ChatController.getOrCreateConversation(userB._id.toString(), userA._id.toString());
    expect(ab._id.toString()).toBe(ba._id.toString());
  });
});

// ── getConversationsForUser ───────────────────────────────────────────────────
describe('ChatController.getConversationsForUser', () => {
  it('returns conversations the user participates in', async () => {
    await ChatController.getOrCreateConversation(userA._id.toString(), userB._id.toString());
    const convs = await ChatController.getConversationsForUser(userA._id.toString());
    expect(convs.length).toBeGreaterThanOrEqual(1);
  });

  it('excludes conversations hidden by the user', async () => {
    const conv = await ChatController.getOrCreateConversation(userA._id.toString(), userB._id.toString());
    await ChatController.closeConversation(conv._id.toString(), userA._id.toString(), false);
    const convs = await ChatController.getConversationsForUser(userA._id.toString());
    const ids = convs.map((c: any) => c._id.toString());
    expect(ids).not.toContain(conv._id.toString());
  });

  it('still shows conversation for the other participant after one user hides it', async () => {
    const conv = await ChatController.getOrCreateConversation(userA._id.toString(), userB._id.toString());
    await ChatController.closeConversation(conv._id.toString(), userA._id.toString(), false);
    const convs = await ChatController.getConversationsForUser(userB._id.toString());
    const ids = convs.map((c: any) => c._id.toString());
    expect(ids).toContain(conv._id.toString());
  });

  it('lists pinned conversations before unpinned ones', async () => {
    const convAB = await ChatController.getOrCreateConversation(userA._id.toString(), userB._id.toString());
    const convAC = await ChatController.getOrCreateConversation(userA._id.toString(), userC._id.toString());

    // Give convAC a newer lastMessageAt so it would normally sort first
    await ConversationModel.findByIdAndUpdate(convAB._id, { lastMessageAt: new Date(Date.now() - 10000) });
    await ConversationModel.findByIdAndUpdate(convAC._id, { lastMessageAt: new Date() });

    // Pin the older conversation
    await ChatController.togglePin(convAB._id.toString(), userA._id.toString());

    const convs = await ChatController.getConversationsForUser(userA._id.toString());
    expect(convs[0]._id.toString()).toBe(convAB._id.toString());
  });
});

// ── sendMessage ───────────────────────────────────────────────────────────────
describe('ChatController.sendMessage', () => {
  it('creates a message in the conversation', async () => {
    const conv = await ChatController.getOrCreateConversation(userA._id.toString(), userB._id.toString());
    const msg = await ChatController.sendMessage(conv._id.toString(), userA._id.toString(), 'Hello!');
    expect(msg.content).toBe('Hello!');
    expect(msg.senderId.toString()).toBe(userA._id.toString());
  });

  it('updates lastMessageAt on the conversation', async () => {
    const conv = await ChatController.getOrCreateConversation(userA._id.toString(), userB._id.toString());
    const before = conv.lastMessageAt ? conv.lastMessageAt.getTime() : 0;
    await ChatController.sendMessage(conv._id.toString(), userA._id.toString(), 'Tick');
    const updated = await ConversationModel.findById(conv._id).lean();
    expect(updated!.lastMessageAt!.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('throws for empty content', async () => {
    const conv = await ChatController.getOrCreateConversation(userA._id.toString(), userB._id.toString());
    await expect(
      ChatController.sendMessage(conv._id.toString(), userA._id.toString(), ''),
    ).rejects.toThrow('Message content cannot be empty.');
  });

  it('throws when sender is not a participant', async () => {
    const conv = await ChatController.getOrCreateConversation(userA._id.toString(), userB._id.toString());
    await expect(
      ChatController.sendMessage(conv._id.toString(), userC._id.toString(), 'Sneaky'),
    ).rejects.toThrow('Unauthorized.');
  });
});

// ── getMessages ───────────────────────────────────────────────────────────────
describe('ChatController.getMessages', () => {
  it('returns messages sorted oldest-first', async () => {
    const conv = await ChatController.getOrCreateConversation(userA._id.toString(), userB._id.toString());
    await ChatController.sendMessage(conv._id.toString(), userA._id.toString(), 'First');
    await ChatController.sendMessage(conv._id.toString(), userB._id.toString(), 'Second');

    const messages = await ChatController.getMessages(conv._id.toString(), userA._id.toString()) as any[];
    expect(messages[0].content).toBe('First');
    expect(messages[1].content).toBe('Second');
  });

  it('throws when requester is not a participant', async () => {
    const conv = await ChatController.getOrCreateConversation(userA._id.toString(), userB._id.toString());
    await expect(
      ChatController.getMessages(conv._id.toString(), userC._id.toString()),
    ).rejects.toThrow('Unauthorized.');
  });

  it('throws when conversation does not exist', async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    await expect(
      ChatController.getMessages(fakeId, userA._id.toString()),
    ).rejects.toThrow('Conversation not found.');
  });
});

// ── deleteMessage ─────────────────────────────────────────────────────────────
describe('ChatController.deleteMessage', () => {
  it('soft-deletes a message by setting deletedAt', async () => {
    const conv = await ChatController.getOrCreateConversation(userA._id.toString(), userB._id.toString());
    const msg = await ChatController.sendMessage(conv._id.toString(), userA._id.toString(), 'To delete');

    const deleted = await ChatController.deleteMessage(msg._id.toString(), userA._id.toString());
    expect(deleted.deletedAt).toBeDefined();
    expect(deleted.deletedAt).not.toBeNull();
  });

  it('throws when a non-sender tries to delete', async () => {
    const conv = await ChatController.getOrCreateConversation(userA._id.toString(), userB._id.toString());
    const msg = await ChatController.sendMessage(conv._id.toString(), userA._id.toString(), 'Mine');

    await expect(
      ChatController.deleteMessage(msg._id.toString(), userB._id.toString()),
    ).rejects.toThrow('Unauthorized.');
  });

  it('throws when message does not exist', async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    await expect(
      ChatController.deleteMessage(fakeId, userA._id.toString()),
    ).rejects.toThrow('Message not found.');
  });
});

// ── closeConversation ─────────────────────────────────────────────────────────
describe('ChatController.closeConversation', () => {
  it('adds the user to hiddenBy', async () => {
    const conv = await ChatController.getOrCreateConversation(userA._id.toString(), userB._id.toString());
    await ChatController.closeConversation(conv._id.toString(), userA._id.toString(), false);
    const updated = await ConversationModel.findById(conv._id).lean();
    expect(updated!.hiddenBy.map(String)).toContain(userA._id.toString());
  });

  it('with deleteMessages=true soft-deletes all messages', async () => {
    const conv = await ChatController.getOrCreateConversation(userA._id.toString(), userB._id.toString());
    await ChatController.sendMessage(conv._id.toString(), userA._id.toString(), 'Msg 1');
    await ChatController.sendMessage(conv._id.toString(), userB._id.toString(), 'Msg 2');

    await ChatController.closeConversation(conv._id.toString(), userA._id.toString(), true);

    const messages = await MessageModel.find({ conversationId: conv._id }).lean();
    for (const msg of messages) {
      expect(msg.deletedAt).not.toBeNull();
    }
  });

  it('with deleteMessages=false leaves messages intact', async () => {
    const conv = await ChatController.getOrCreateConversation(userA._id.toString(), userB._id.toString());
    await ChatController.sendMessage(conv._id.toString(), userA._id.toString(), 'Keep me');

    await ChatController.closeConversation(conv._id.toString(), userA._id.toString(), false);

    const messages = await MessageModel.find({ conversationId: conv._id }).lean();
    expect(messages[0].deletedAt).toBeNull();
  });

  it('throws when user is not a participant', async () => {
    const conv = await ChatController.getOrCreateConversation(userA._id.toString(), userB._id.toString());
    await expect(
      ChatController.closeConversation(conv._id.toString(), userC._id.toString(), false),
    ).rejects.toThrow('Unauthorized.');
  });
});

// ── togglePin ─────────────────────────────────────────────────────────────────
describe('ChatController.togglePin', () => {
  it('pins an unpinned conversation', async () => {
    const conv = await ChatController.getOrCreateConversation(userA._id.toString(), userB._id.toString());
    const result = await ChatController.togglePin(conv._id.toString(), userA._id.toString());
    expect(result.pinned).toBe(true);
  });

  it('unpins an already-pinned conversation', async () => {
    const conv = await ChatController.getOrCreateConversation(userA._id.toString(), userB._id.toString());
    await ChatController.togglePin(conv._id.toString(), userA._id.toString());
    const result = await ChatController.togglePin(conv._id.toString(), userA._id.toString());
    expect(result.pinned).toBe(false);
  });

  it('only affects the calling user\'s pin state', async () => {
    const conv = await ChatController.getOrCreateConversation(userA._id.toString(), userB._id.toString());
    await ChatController.togglePin(conv._id.toString(), userA._id.toString());
    const updated = await ConversationModel.findById(conv._id).lean();
    expect(updated!.pinnedBy.map(String)).not.toContain(userB._id.toString());
  });

  it('throws when user is not a participant', async () => {
    const conv = await ChatController.getOrCreateConversation(userA._id.toString(), userB._id.toString());
    await expect(
      ChatController.togglePin(conv._id.toString(), userC._id.toString()),
    ).rejects.toThrow('Unauthorized.');
  });

  it('throws when conversation does not exist', async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    await expect(
      ChatController.togglePin(fakeId, userA._id.toString()),
    ).rejects.toThrow('Conversation not found.');
  });
});

// ── markMessagesRead ──────────────────────────────────────────────────────────
describe('ChatController.markMessagesRead', () => {
  it('adds the calling user to readBy on messages sent by the other participant', async () => {
    const conv = await ChatController.getOrCreateConversation(userA._id.toString(), userB._id.toString());
    const msg = await ChatController.sendMessage(conv._id.toString(), userA._id.toString(), 'Hello');

    await ChatController.markMessagesRead(conv._id.toString(), userB._id.toString());

    const updated = await MessageModel.findById(msg._id).lean();
    expect(updated!.readBy.map((r: any) => r.userId.toString())).toContain(userB._id.toString());
  });

  it('does not add the calling user to readBy on their own messages', async () => {
    const conv = await ChatController.getOrCreateConversation(userA._id.toString(), userB._id.toString());
    const msg = await ChatController.sendMessage(conv._id.toString(), userA._id.toString(), 'Mine');

    await ChatController.markMessagesRead(conv._id.toString(), userA._id.toString());

    const updated = await MessageModel.findById(msg._id).lean();
    expect(updated!.readBy.map((r: any) => r.userId.toString())).not.toContain(userA._id.toString());
  });

  it('does not duplicate a readBy entry when called twice', async () => {
    const conv = await ChatController.getOrCreateConversation(userA._id.toString(), userB._id.toString());
    await ChatController.sendMessage(conv._id.toString(), userA._id.toString(), 'Hello');

    await ChatController.markMessagesRead(conv._id.toString(), userB._id.toString());
    await ChatController.markMessagesRead(conv._id.toString(), userB._id.toString());

    const messages = await MessageModel.find({ conversationId: conv._id }).lean();
    const bobEntries = messages[0].readBy.filter((r: any) => r.userId.toString() === userB._id.toString());
    expect(bobEntries.length).toBe(1);
  });

  it('returns a readAt timestamp', async () => {
    const conv = await ChatController.getOrCreateConversation(userA._id.toString(), userB._id.toString());
    await ChatController.sendMessage(conv._id.toString(), userA._id.toString(), 'Tick');
    const before = new Date();
    const result = await ChatController.markMessagesRead(conv._id.toString(), userB._id.toString());
    const after = new Date();
    expect(result.readAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(result.readAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('throws when requester is not a participant', async () => {
    const conv = await ChatController.getOrCreateConversation(userA._id.toString(), userB._id.toString());
    await expect(
      ChatController.markMessagesRead(conv._id.toString(), userC._id.toString()),
    ).rejects.toThrow('Unauthorized.');
  });

  it('throws when conversation does not exist', async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    await expect(
      ChatController.markMessagesRead(fakeId, userA._id.toString()),
    ).rejects.toThrow('Conversation not found.');
  });
});
