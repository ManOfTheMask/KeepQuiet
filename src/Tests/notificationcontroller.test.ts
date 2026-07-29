import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import NotificationController from '../Controllers/NotificationController';
import NotificationModel from '../Models/NotificationModel';

let mongoServer: MongoMemoryServer;
const uid1 = new mongoose.Types.ObjectId().toString();
const uid2 = new mongoose.Types.ObjectId().toString();

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri(), { dbName: 'test' });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await NotificationModel.deleteMany({});
});

// ── Helper ────────────────────────────────────────────────────────────────────
async function makeNotification(userId = uid1, overrides: Record<string, any> = {}) {
  return NotificationController.create(
    userId,
    overrides.type ?? 'message',
    overrides.title ?? 'Test Title',
    overrides.body  ?? 'Test body',
    overrides.link  ?? '/chat/test',
  );
}

// ── create ────────────────────────────────────────────────────────────────────
describe('NotificationController.create', () => {
  it('creates a notification with the correct fields', async () => {
    const n = await makeNotification(uid1);
    expect(n.userId.toString()).toBe(uid1);
    expect(n.type).toBe('message');
    expect(n.title).toBe('Test Title');
    expect(n.body).toBe('Test body');
    expect(n.link).toBe('/chat/test');
  });

  it('defaults read to false', async () => {
    const n = await makeNotification();
    expect(n.read).toBe(false);
  });

  it('accepts friend_request type', async () => {
    const n = await makeNotification(uid1, { type: 'friend_request' });
    expect(n.type).toBe('friend_request');
  });
});

// ── getForUser ────────────────────────────────────────────────────────────────
describe('NotificationController.getForUser', () => {
  it('returns notifications newest first', async () => {
    await makeNotification(uid1, { title: 'Old' });
    await new Promise(r => setTimeout(r, 5)); // ensure createdAt differs
    await makeNotification(uid1, { title: 'New' });

    const results = await NotificationController.getForUser(uid1) as any[];
    expect(results[0].title).toBe('New');
    expect(results[1].title).toBe('Old');
  });

  it('returns only notifications for the specified user', async () => {
    await makeNotification(uid1, { title: 'For uid1' });
    await makeNotification(uid2, { title: 'For uid2' });

    const results = await NotificationController.getForUser(uid1) as any[];
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('For uid1');
  });

  it('returns at most 50 notifications', async () => {
    const creates = Array.from({ length: 60 }, (_, i) =>
      makeNotification(uid1, { title: `Notif ${i}` }),
    );
    await Promise.all(creates);
    const results = await NotificationController.getForUser(uid1);
    expect(results.length).toBe(50);
  });
});

// ── countUnread ───────────────────────────────────────────────────────────────
describe('NotificationController.countUnread', () => {
  it('counts only unread notifications', async () => {
    const n1 = await makeNotification(uid1);
    await makeNotification(uid1);
    await NotificationController.markRead(n1._id.toString(), uid1);

    const count = await NotificationController.countUnread(uid1);
    expect(count).toBe(1);
  });

  it('returns 0 when all notifications are read', async () => {
    await makeNotification(uid1);
    await NotificationController.markAllRead(uid1);
    const count = await NotificationController.countUnread(uid1);
    expect(count).toBe(0);
  });

  it('does not count another user\'s unread notifications', async () => {
    await makeNotification(uid2);
    const count = await NotificationController.countUnread(uid1);
    expect(count).toBe(0);
  });
});

// ── markRead ──────────────────────────────────────────────────────────────────
describe('NotificationController.markRead', () => {
  it('sets read=true on the notification', async () => {
    const n = await makeNotification(uid1);
    await NotificationController.markRead(n._id.toString(), uid1);
    const updated = await NotificationModel.findById(n._id).lean();
    expect(updated!.read).toBe(true);
  });

  it('throws for a non-existent notification id', async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    await expect(NotificationController.markRead(fakeId, uid1)).rejects.toThrow(
      'Notification not found.',
    );
  });

  it('throws when the notification belongs to a different user', async () => {
    const n = await makeNotification(uid1);
    await expect(NotificationController.markRead(n._id.toString(), uid2)).rejects.toThrow(
      'Unauthorized.',
    );
  });
});

// ── markAllRead ───────────────────────────────────────────────────────────────
describe('NotificationController.markAllRead', () => {
  it('marks all unread notifications for a user as read', async () => {
    await makeNotification(uid1);
    await makeNotification(uid1);
    await NotificationController.markAllRead(uid1);

    const unread = await NotificationModel.find({ userId: uid1, read: false }).lean();
    expect(unread).toHaveLength(0);
  });

  it('does not affect other users\' notifications', async () => {
    await makeNotification(uid2);
    await NotificationController.markAllRead(uid1);

    const unread = await NotificationModel.find({ userId: uid2, read: false }).lean();
    expect(unread).toHaveLength(1);
  });
});

// ── dismiss ───────────────────────────────────────────────────────────────────
describe('NotificationController.dismiss', () => {
  it('permanently deletes the notification', async () => {
    const n = await makeNotification(uid1);
    await NotificationController.dismiss(n._id.toString(), uid1);
    const found = await NotificationModel.findById(n._id).lean();
    expect(found).toBeNull();
  });

  it('throws when the notification does not exist', async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    await expect(NotificationController.dismiss(fakeId, uid1)).rejects.toThrow(
      'Notification not found.',
    );
  });

  it('throws when the notification belongs to a different user', async () => {
    const n = await makeNotification(uid1);
    await expect(NotificationController.dismiss(n._id.toString(), uid2)).rejects.toThrow(
      'Unauthorized.',
    );
    // Confirm it was not deleted
    const still = await NotificationModel.findById(n._id).lean();
    expect(still).not.toBeNull();
  });
});

// ── dismissAll ───────────────────────────────────────────────────────────────
describe('NotificationController.dismissAll', () => {
  it('deletes all notifications for the specified user', async () => {
    await makeNotification(uid1, { title: 'A' });
    await makeNotification(uid1, { title: 'B' });
    await makeNotification(uid2, { title: 'Other user' });

    const result = await NotificationController.dismissAll(uid1);
    expect(result.deletedCount).toBe(2);

    const mine = await NotificationModel.find({ userId: uid1 }).lean();
    const theirs = await NotificationModel.find({ userId: uid2 }).lean();
    expect(mine).toHaveLength(0);
    expect(theirs).toHaveLength(1);
  });

  it('returns 0 when user has no notifications', async () => {
    const result = await NotificationController.dismissAll(uid1);
    expect(result.deletedCount).toBe(0);
  });
});
