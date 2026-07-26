import { beforeEach, describe, expect, it, vi } from 'vitest';

type ConversationType = 'dm' | 'group';

type SignalMessage =
  | { type: 'call_incoming'; inviteId: string; fromUserId: string; fromUsername: string; conversationType: ConversationType; conversationId: string; timeoutMs: number }
  | { type: 'call_accepted'; byUserId: string; byUsername: string; conversationType: ConversationType; conversationId: string }
  | { type: 'call_declined'; byUserId: string; byUsername: string; conversationType: ConversationType; conversationId: string }
  | { type: 'call_missed'; toUserId: string; conversationType: ConversationType; conversationId: string }
  | { type: 'call_invite_expired'; inviteId: string; fromUserId: string; fromUsername: string; conversationType: ConversationType; conversationId: string }
  | { type: 'call_room_state'; participants: Array<{ userId: string; username: string }> }
  | { type: 'call_user_joined'; userId: string; username: string }
  | { type: 'call_user_left'; userId: string; username: string }
  | { type: 'call_offer' | 'call_answer' | 'call_ice_candidate'; from: string; payload: unknown }
  | { type: 'call_error'; message: string };

interface TestUser {
  userId: string;
  username: string;
  messages: SignalMessage[];
}

interface PendingInvite {
  inviteId: string;
  fromUserId: string;
  fromUsername: string;
  toUserId: string;
  conversationType: ConversationType;
  conversationId: string;
  timeout: ReturnType<typeof setTimeout>;
}

class MockCallSignalingServer {
  private static nextInviteId = 1;
  private readonly inviteTimeoutMs: number;
  private readonly memberships = new Map<string, Set<string>>();
  private readonly rooms = new Map<string, Map<string, TestUser>>();
  private readonly pendingInvites = new Map<string, PendingInvite>();

  constructor(inviteTimeoutMs = 30000) {
    this.inviteTimeoutMs = inviteTimeoutMs;
  }

  setMembership(conversationType: ConversationType, conversationId: string, memberIds: string[]): void {
    this.memberships.set(this.key(conversationType, conversationId), new Set(memberIds));
  }

  invite(from: TestUser, conversationType: ConversationType, conversationId: string, usersById: Map<string, TestUser>): string[] {
    if (!this.isAuthorized(from.userId, conversationType, conversationId)) {
      from.messages.push({ type: 'call_error', message: 'Unauthorized call invite.' });
      return [];
    }

    const members = this.memberships.get(this.key(conversationType, conversationId));
    if (!members) return [];

    const inviteIds: string[] = [];
    for (const memberId of members) {
      if (memberId === from.userId) continue;
      const target = usersById.get(memberId);
      if (!target) continue;

      const inviteId = String(MockCallSignalingServer.nextInviteId++);
      const timeout = setTimeout(() => {
        const expired = this.clearInvite(inviteId);
        if (!expired) return;

        const caller = usersById.get(expired.fromUserId);
        if (caller) {
          caller.messages.push({
            type: 'call_missed',
            toUserId: expired.toUserId,
            conversationType: expired.conversationType,
            conversationId: expired.conversationId,
          });
        }

        const callee = usersById.get(expired.toUserId);
        if (callee) {
          callee.messages.push({
            type: 'call_invite_expired',
            inviteId: expired.inviteId,
            fromUserId: expired.fromUserId,
            fromUsername: expired.fromUsername,
            conversationType: expired.conversationType,
            conversationId: expired.conversationId,
          });
        }
      }, this.inviteTimeoutMs);

      this.pendingInvites.set(inviteId, {
        inviteId,
        fromUserId: from.userId,
        fromUsername: from.username,
        toUserId: memberId,
        conversationType,
        conversationId,
        timeout,
      });

      target.messages.push({
        type: 'call_incoming',
        inviteId,
        fromUserId: from.userId,
        fromUsername: from.username,
        conversationType,
        conversationId,
        timeoutMs: this.inviteTimeoutMs,
      });

      inviteIds.push(inviteId);
    }

    return inviteIds;
  }

  join(user: TestUser, conversationType: ConversationType, conversationId: string, usersById: Map<string, TestUser>): void {
    if (!this.isAuthorized(user.userId, conversationType, conversationId)) {
      user.messages.push({ type: 'call_error', message: 'Unauthorized call join.' });
      return;
    }

    this.resolveInvitesForJoin(user, conversationType, conversationId, usersById);

    const roomKey = this.key(conversationType, conversationId);
    if (!this.rooms.has(roomKey)) this.rooms.set(roomKey, new Map());
    const room = this.rooms.get(roomKey)!;

    room.set(user.userId, user);

    user.messages.push({
      type: 'call_room_state',
      participants: Array.from(room.values())
        .filter((u) => u.userId !== user.userId)
        .map((u) => ({ userId: u.userId, username: u.username })),
    });

    for (const [uid, peer] of room.entries()) {
      if (uid === user.userId) continue;
      peer.messages.push({ type: 'call_user_joined', userId: user.userId, username: user.username });
    }
  }

  decline(user: TestUser, inviteId: string, usersById: Map<string, TestUser>): void {
    const invite = this.pendingInvites.get(inviteId);
    if (!invite) return;
    if (invite.toUserId !== user.userId) {
      user.messages.push({ type: 'call_error', message: 'Decline invite ownership mismatch.' });
      return;
    }

    this.clearInvite(inviteId);
    const caller = usersById.get(invite.fromUserId);
    if (caller) {
      caller.messages.push({
        type: 'call_declined',
        byUserId: user.userId,
        byUsername: user.username,
        conversationType: invite.conversationType,
        conversationId: invite.conversationId,
      });
    }
  }

  relay(
    from: TestUser,
    conversationType: ConversationType,
    conversationId: string,
    toUserId: string,
    type: 'call_offer' | 'call_answer' | 'call_ice_candidate',
    payload: unknown,
  ): void {
    const room = this.rooms.get(this.key(conversationType, conversationId));
    if (!room?.has(from.userId)) {
      from.messages.push({ type: 'call_error', message: 'Join a call first.' });
      return;
    }

    const to = room.get(toUserId);
    if (!to) {
      from.messages.push({ type: 'call_error', message: 'Target is not in this call.' });
      return;
    }

    to.messages.push({ type, from: from.userId, payload });
  }

  leave(user: TestUser, conversationType: ConversationType, conversationId: string): void {
    const room = this.rooms.get(this.key(conversationType, conversationId));
    if (!room) return;
    if (!room.has(user.userId)) return;

    room.delete(user.userId);
    for (const peer of room.values()) {
      peer.messages.push({ type: 'call_user_left', userId: user.userId, username: user.username });
    }
  }

  private resolveInvitesForJoin(
    user: TestUser,
    conversationType: ConversationType,
    conversationId: string,
    usersById: Map<string, TestUser>,
  ): void {
    for (const [inviteId, invite] of this.pendingInvites.entries()) {
      if (invite.toUserId !== user.userId) continue;
      if (invite.conversationType !== conversationType || invite.conversationId !== conversationId) continue;

      this.clearInvite(inviteId);
      const caller = usersById.get(invite.fromUserId);
      if (!caller) continue;
      caller.messages.push({
        type: 'call_accepted',
        byUserId: user.userId,
        byUsername: user.username,
        conversationType,
        conversationId,
      });
    }
  }

  private clearInvite(inviteId: string): PendingInvite | null {
    const invite = this.pendingInvites.get(inviteId);
    if (!invite) return null;
    clearTimeout(invite.timeout);
    this.pendingInvites.delete(inviteId);
    return invite;
  }

  private isAuthorized(userId: string, conversationType: ConversationType, conversationId: string): boolean {
    const members = this.memberships.get(this.key(conversationType, conversationId));
    return !!members?.has(userId);
  }

  private key(conversationType: ConversationType, conversationId: string): string {
    return `${conversationType}:${conversationId}`;
  }
}

function createUser(userId: string, username: string): TestUser {
  return { userId, username, messages: [] };
}

describe('Call signaling lifecycle', () => {
  let server: MockCallSignalingServer;
  let alice: TestUser;
  let bob: TestUser;
  let charlie: TestUser;
  let users: Map<string, TestUser>;

  beforeEach(() => {
    vi.useFakeTimers();
    server = new MockCallSignalingServer(15000);

    alice = createUser('alice-id', 'Alice');
    bob = createUser('bob-id', 'Bob');
    charlie = createUser('charlie-id', 'Charlie');

    users = new Map([
      [alice.userId, alice],
      [bob.userId, bob],
      [charlie.userId, charlie],
    ]);

    server.setMembership('dm', 'conv-dm', [alice.userId, bob.userId]);
    server.setMembership('group', 'group-1', [alice.userId, bob.userId, charlie.userId]);
  });

  it('sends incoming invites to authorized recipients', () => {
    const inviteIds = server.invite(alice, 'dm', 'conv-dm', users);

    expect(inviteIds).toHaveLength(1);
    const incoming = bob.messages.find((m) => m.type === 'call_incoming');
    expect(incoming).toBeDefined();
    if (!incoming || incoming.type !== 'call_incoming') throw new Error('missing incoming');
    expect(incoming.fromUserId).toBe(alice.userId);
    expect(incoming.conversationId).toBe('conv-dm');
  });

  it('emits accepted to caller when invited user joins before timeout', () => {
    const [inviteId] = server.invite(alice, 'group', 'group-1', users);
    expect(inviteId).toBeDefined();

    server.join(bob, 'group', 'group-1', users);

    const accepted = alice.messages.find((m) => m.type === 'call_accepted');
    expect(accepted).toBeDefined();
    if (!accepted || accepted.type !== 'call_accepted') throw new Error('missing accepted');
    expect(accepted.byUserId).toBe(bob.userId);
  });

  it('emits declined to caller when recipient declines', () => {
    const [inviteId] = server.invite(alice, 'dm', 'conv-dm', users);

    server.decline(bob, inviteId, users);

    const declined = alice.messages.find((m) => m.type === 'call_declined');
    expect(declined).toBeDefined();
    if (!declined || declined.type !== 'call_declined') throw new Error('missing declined');
    expect(declined.byUserId).toBe(bob.userId);
  });

  it('emits missed + invite-expired when invite times out', () => {
    server.invite(alice, 'dm', 'conv-dm', users);

    vi.advanceTimersByTime(15001);

    const missed = alice.messages.find((m) => m.type === 'call_missed');
    const expired = bob.messages.find((m) => m.type === 'call_invite_expired');

    expect(missed).toBeDefined();
    expect(expired).toBeDefined();
  });

  it('relays signaling payload only within joined room', () => {
    server.join(alice, 'dm', 'conv-dm', users);
    server.join(bob, 'dm', 'conv-dm', users);

    server.relay(alice, 'dm', 'conv-dm', bob.userId, 'call_offer', { sdp: 'offer-sdp' });

    const offer = bob.messages.find((m) => m.type === 'call_offer');
    expect(offer).toBeDefined();
    if (!offer || offer.type !== 'call_offer') throw new Error('missing offer');
    expect(offer.from).toBe(alice.userId);
  });

  it('rejects relay when sender is not joined to the room', () => {
    server.relay(alice, 'dm', 'conv-dm', bob.userId, 'call_offer', { sdp: 'x' });

    const err = alice.messages.find((m) => m.type === 'call_error');
    expect(err).toBeDefined();
    if (!err || err.type !== 'call_error') throw new Error('missing error');
    expect(err.message).toContain('Join a call first');
  });

  it('rejects unauthorized invite attempts', () => {
    server.invite(charlie, 'dm', 'conv-dm', users);

    const err = charlie.messages.find((m) => m.type === 'call_error');
    expect(err).toBeDefined();
    if (!err || err.type !== 'call_error') throw new Error('missing error');
    expect(err.message).toContain('Unauthorized call invite');
  });

  it('notifies peers when user leaves the call room', () => {
    server.join(alice, 'group', 'group-1', users);
    server.join(bob, 'group', 'group-1', users);

    server.leave(bob, 'group', 'group-1');

    const left = alice.messages.find((m) => m.type === 'call_user_left');
    expect(left).toBeDefined();
    if (!left || left.type !== 'call_user_left') throw new Error('missing user-left');
    expect(left.userId).toBe(bob.userId);
  });
});
