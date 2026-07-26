import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import FriendController from '../Controllers/FriendController';
import UserController from '../Controllers/UserController';
import UserModel from '../Models/UserModel';
import FriendRequestModel from '../Models/FriendRequestModel';

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
  await UserModel.deleteMany({});
  await FriendRequestModel.deleteMany({});
});

// ── Helpers ───────────────────────────────────────────────────────────────────
async function makeUser(key: string, name: string) {
  return UserController.createUser(key, name, key); // publicKeyArmored = key for simplicity
}

// ── sendFriendRequest ─────────────────────────────────────────────────────────
describe('FriendController.sendFriendRequest', () => {
  it('creates a pending friend request', async () => {
    const sender   = await makeUser('key-a', 'Alice');
    const receiver = await makeUser('key-b', 'Bob');

    const request = await FriendController.sendFriendRequest(sender._id.toString(), 'key-b');
    expect(request.status).toBe('pending');
    expect(request.fromUserId.toString()).toBe(sender._id.toString());
    expect(request.toUserId.toString()).toBe(receiver._id.toString());
  });

  it('throws when sender and receiver are the same user', async () => {
    const user = await makeUser('key-self', 'Self');
    await expect(
      FriendController.sendFriendRequest(user._id.toString(), 'key-self'),
    ).rejects.toThrow('You cannot send a friend request to yourself.');
  });

  it('throws when target public key does not match any user', async () => {
    const sender = await makeUser('key-c', 'Charlie');
    await expect(
      FriendController.sendFriendRequest(sender._id.toString(), 'no-such-key'),
    ).rejects.toThrow('No user found with that public key.');
  });

  it('throws when a pending request already exists', async () => {
    const a = await makeUser('key-d', 'Dave');
    const b = await makeUser('key-e', 'Eve');
    await FriendController.sendFriendRequest(a._id.toString(), 'key-e');
    await expect(
      FriendController.sendFriendRequest(a._id.toString(), 'key-e'),
    ).rejects.toThrow('A pending friend request already exists');
  });

  it('throws when they are already friends', async () => {
    const a = await makeUser('key-f', 'Frank');
    const b = await makeUser('key-g', 'Grace');
    const req = await FriendController.sendFriendRequest(a._id.toString(), 'key-g');
    await FriendController.acceptFriendRequest(req._id.toString(), b._id.toString());
    await expect(
      FriendController.sendFriendRequest(a._id.toString(), 'key-g'),
    ).rejects.toThrow('You are already friends with this user.');
  });
});

// ── acceptFriendRequest ───────────────────────────────────────────────────────
describe('FriendController.acceptFriendRequest', () => {
  it('deletes the request and adds each user to the other\'s friends list', async () => {
    const a = await makeUser('key-h', 'Heidi');
    const b = await makeUser('key-i', 'Ivan');

    const req = await FriendController.sendFriendRequest(a._id.toString(), 'key-i');
    await FriendController.acceptFriendRequest(req._id.toString(), b._id.toString());

    const updatedA = await UserModel.findById(a._id);
    const updatedB = await UserModel.findById(b._id);
    expect(updatedA!.friends.map(String)).toContain(b._id.toString());
    expect(updatedB!.friends.map(String)).toContain(a._id.toString());

    const updatedReq = await FriendRequestModel.findById(req._id);
    expect(updatedReq).toBeNull();
  });

  it('throws when the request does not belong to the accepting user', async () => {
    const a  = await makeUser('key-j', 'Judy');
    const b  = await makeUser('key-k', 'Karl');
    const outsider = await makeUser('key-l', 'Laura');

    const req = await FriendController.sendFriendRequest(a._id.toString(), 'key-k');
    await expect(
      FriendController.acceptFriendRequest(req._id.toString(), outsider._id.toString()),
    ).rejects.toThrow('Unauthorized.');
  });

  it('throws when accepting an already-resolved request', async () => {
    const a = await makeUser('key-m', 'Mallory');
    const b = await makeUser('key-n', 'Niaj');

    const req = await FriendController.sendFriendRequest(a._id.toString(), 'key-n');
    await FriendController.acceptFriendRequest(req._id.toString(), b._id.toString());
    await expect(
      FriendController.acceptFriendRequest(req._id.toString(), b._id.toString()),
    ).rejects.toThrow('Friend request not found.');
  });

  it('throws when the request id does not exist', async () => {
    const b = await makeUser('key-o', 'Olivia');
    const fakeId = new mongoose.Types.ObjectId().toString();
    await expect(
      FriendController.acceptFriendRequest(fakeId, b._id.toString()),
    ).rejects.toThrow('Friend request not found.');
  });
});

// ── declineFriendRequest ──────────────────────────────────────────────────────
describe('FriendController.declineFriendRequest', () => {
  it('deletes the request when declined', async () => {
    const a = await makeUser('key-p', 'Peggy');
    const b = await makeUser('key-q', 'Quinn');

    const req = await FriendController.sendFriendRequest(a._id.toString(), 'key-q');
    await FriendController.declineFriendRequest(req._id.toString(), b._id.toString());

    const updated = await FriendRequestModel.findById(req._id);
    expect(updated).toBeNull();
  });

  it('throws for unauthorized user', async () => {
    const a = await makeUser('key-r', 'Roger');
    const b = await makeUser('key-s', 'Sybil');
    const other = await makeUser('key-t', 'Trent');

    const req = await FriendController.sendFriendRequest(a._id.toString(), 'key-s');
    await expect(
      FriendController.declineFriendRequest(req._id.toString(), other._id.toString()),
    ).rejects.toThrow('Unauthorized.');
  });
});

// ── getFriends ────────────────────────────────────────────────────────────────
describe('FriendController.getFriends', () => {
  it('returns populated friend documents', async () => {
    const a = await makeUser('key-u', 'Uma');
    const b = await makeUser('key-v', 'Victor');

    const req = await FriendController.sendFriendRequest(a._id.toString(), 'key-v');
    await FriendController.acceptFriendRequest(req._id.toString(), b._id.toString());

    const friendsOfA = await FriendController.getFriends(a._id.toString()) as any[];
    expect(friendsOfA).toHaveLength(1);
    expect(friendsOfA[0].username).toBe('Victor');
  });

  it('returns empty array when user has no friends', async () => {
    const user = await makeUser('key-w', 'Walter');
    const friends = await FriendController.getFriends(user._id.toString());
    expect(friends).toHaveLength(0);
  });

  it('throws when userId is missing', async () => {
    await expect(FriendController.getFriends('')).rejects.toThrow('User ID is required.');
  });
});

// ── getPendingIncomingRequests ────────────────────────────────────────────────
describe('FriendController.getPendingIncomingRequests', () => {
  it('returns pending requests directed at the user', async () => {
    const a = await makeUser('key-x', 'Xavier');
    const b = await makeUser('key-y', 'Yvonne');

    await FriendController.sendFriendRequest(a._id.toString(), 'key-y');
    const pending = await FriendController.getPendingIncomingRequests(b._id.toString()) as any[];
    expect(pending).toHaveLength(1);
    expect((pending[0].fromUserId as any).username).toBe('Xavier');
  });

  it('returns empty array after request is accepted', async () => {
    const a = await makeUser('key-z0', 'Zara');
    const b = await makeUser('key-z1', 'Zeke');

    const req = await FriendController.sendFriendRequest(a._id.toString(), 'key-z1');
    await FriendController.acceptFriendRequest(req._id.toString(), b._id.toString());

    const pending = await FriendController.getPendingIncomingRequests(b._id.toString());
    expect(pending).toHaveLength(0);
  });
});
