<p align="center">
   <img src="/src/public/img/LogoFull.png" alt="KeepQuiet logo" />
</p>

# KeepQuiet

> **⚠ Work in progress — KeepQuiet is nearing the V1.0 release.**

KeepQuiet is a self-hostable, end-to-end encrypted messaging application. All encryption and decryption happens entirely in the browser using [OpenPGP.js](https://openpgpjs.org/). The server never sees plaintext messages or private keys — it only stores ciphertext and public keys.

---

## Features

- **End-to-end encrypted DMs** — messages are encrypted in the browser before being sent; the server only stores ciphertext
- **PGP challenge-response login** — no passwords; authentication is proven by decrypting a server challenge with your private key
- **Real-time messaging** — WebSocket delivery so messages appear instantly without refreshing
- **Real-time notifications** — in-app notification bell for new messages and friend requests, pushed via WebSocket
- **Notification quality controls** — mute/unmute per DM or group, browser notification toggle, and automatic suppression when you already have that chat open
- **Friends system** — send, accept, and decline friend requests by sharing your public key; remove friends and permanently delete your conversation with them in one action
- **Conversation management** — pin conversations, close a DM (with the option to delete all messages), and re-open it later by messaging the same friend again
- **Message deletion** — soft-delete individual messages; deleted messages show a placeholder to all participants
- **Emoji reactions (DMs + groups)** — react to individual messages with emoji chips, live counts, and one-tap toggles in real time
- **Read receipts (DMs + groups)** — sent messages show delivery/read state; DMs use checkmarks and groups show per-reader chips with timestamps
- **Chat usability improvements** — scrollable message pane with stable auto-scroll behavior for incoming messages
- **Dashboard** — logged-in users see a summary of stats (friend count, messages sent, unread notifications, pending requests), quick-action buttons, and an inline accept/decline panel for incoming friend requests
- **Profile page** — displays your username, member-since date, and your full ASCII-armored PGP public key with a one-click copy-to-clipboard button
- **Profile pictures (avatars)** — upload/crop a profile picture from the profile page; avatars are shown on the dashboard and in chat
- **Group chats** — multi-participant E2EE conversations with up to 10 members; each member's public key forms a shared key ring so messages are encrypted for every participant; members can invite others, leave, or rename the group; the group admin can kick members and delete the group
- **Voice/video calls for DMs and groups (up to 10 people)** — WebRTC-based encrypted calls integrated into the chat view with participant list, mute/camera controls, and leave handling
- **Unified chat + call layout** — calls run inside the same chat screen (not a separate page/modal), so users can text and talk at the same time
- **Resizable call/chat split** — users can drag the splitter to show more call area or more message area
- **Persistent in-view call controls** — call buttons stay visible while resizing
- **Incoming call flow** — real-time call invite modal with **Accept** / **Decline**, caller feedback for accepts/declines, and invite-expiry handling
- **Missed-call signaling** — unanswered invites expire automatically and emit caller/callee status events
- **Screen sharing** — optional in-call display sharing with one-click start/stop and automatic camera restore
- **Camera-off by default in calls** — users join calls with camera disabled until they explicitly enable it
- **Account deletion** — permanently delete your account (requires PGP key + passphrase verification); cleans up all associated data including friends, DMs, group memberships, and notifications

---

## How It Works

### Authentication
KeepQuiet uses a **PGP challenge-response** flow instead of passwords:

1. On signup, the browser generates a PGP key pair. The private key is downloaded to your device and never leaves it. The public key is registered with the server.
2. On login, you upload your private key file and enter your passphrase. The client extracts the public key, sends it to `GET /login/challenge` to receive a server-generated random challenge encrypted with that public key.
3. The client decrypts the challenge locally and sends the plaintext answer to `POST /login/verify`. A successful match establishes an authenticated server-side session (1-hour cookie).
4. Challenges expire after 5 minutes and are deleted from memory after use, preventing replay attacks.
5. If PGP credentials are not already in `sessionStorage`, an unlock overlay prompts you to re-enter them so messages can be decrypted without logging out.

### Messaging
- Conversations are 1-to-1 DMs between friends.
- Messages are encrypted in the browser with the recipient's public key (and your own, so you can read your sent messages) before being sent.
- Real-time delivery is handled via **WebSockets**. The server stores only encrypted ciphertext.
- Read receipts are tracked per message using `readBy` entries (`userId`, `readAt`).
- Reactions are tracked per message using `reactions` entries (`emoji`, `users[]`).
- The client marks messages as read when you view a conversation, then broadcasts a real-time receipt update.
- In DMs, outgoing messages show single-check (sent) and double-check (read). In groups, outgoing messages show per-reader chips.
- Both DMs and groups support emoji reactions with live count updates.
- You can soft-delete any message you sent.
- You can close a conversation (hide it from your sidebar). When closing, you are prompted to either keep the messages or permanently delete them. Opening a new chat with the same friend restores the conversation.

### Friends
- Users find each other by sharing their PGP public key.
- Friend requests can be sent, accepted, or declined from the Friends page. Accepting or declining a request permanently deletes it from the database.
- Friends can be removed at any time from the Friends page. Removing a friend also permanently deletes the shared conversation and all its messages.
- The friends list is used in the chat friend picker to start new conversations.

### Notifications
- A bell icon in the navbar shows unread notifications with a live badge count.
- Notifications are pushed in real time via WebSocket when a friend request is received or a new message arrives.
- Each notification has a **Mark read** button and a **Dismiss** button (permanently deletes the notification).
- Both navbar and home dashboard recent-notifications panels stay synchronized in real time.
- **Mark all read** and **Dismiss all** are available for bulk actions.
- Browser notifications can be toggled on/off directly in the toolbar.
- Message notifications are suppressed when the recipient is already viewing that exact DM/group conversation.

### Group Chats
- Groups can have 2–10 members; each member's public key is stored in the group's **key ring** at join time.
- When sending a message, the client encrypts the content with every member's public key so that each participant can decrypt it.
- Any member can invite a friend (who must have a stored PGP key), rename the group, leave, or pin the group.
- The admin can additionally kick members and delete the group entirely.
- If a member leaves or is kicked, their messages are soft-deleted and their key is removed from the ring.
- If the admin leaves, the longest-standing remaining member is automatically promoted.
- Deleting the group hard-deletes all group messages and the group document.

### Voice / Video Calls
- Calls are available inside both DMs and group chats.
- Group and call capacity is limited to **10 participants**.
- The call view is embedded directly in the chat window and appears above the message pane.
- A resize handle lets users adjust the split between call content and text chat.
- Call controls remain visible while resizing.
- Joining a call requires authorization against conversation membership (DM participant or group member).
- Peer negotiation includes reconnection-safe handling to improve reliability for users joining active calls.
- Call invites are delivered in real time over WebSocket:
   - Recipients can **Accept** or **Decline**.
   - Accepting joins the call room and notifies the caller.
   - Declining notifies the caller immediately.
   - Unanswered invites automatically expire after a timeout and emit missed/expired events.
- Media transport uses WebRTC peer connections with ICE/STUN (and optional TURN relay).
- In-call controls include mute/unmute, camera on/off, screen share, and leave call.
- Camera starts **off by default** until the user enables it.
- Stopping screen share exits smoothly and restores the camera track without spurious warnings.

### Account Deletion
- Users can permanently delete their account from the Profile page.
- Deletion requires uploading the private key and entering the passphrase to verify ownership.
- All associated data is cleaned up: friend links, friend requests, notifications, DMs, and group memberships (including admin handoff or group deletion if the user was the last member).

### Real-time (WebSockets)
All real-time communication goes through a single WebSocket endpoint at `/ws`. The server authenticates the connection by reading and verifying the session cookie on the initial HTTP upgrade request.

#### DM events
| Direction | Event type | Payload |
|---|---|---|
| Server → Client | `new_message` | `{ conversationId, message: { id, senderUsername, senderId, content, deleted, createdAt } }` |
| Server → Client | `new_notification` | `{ notification: { id, type, title, body, link, read, createdAt } }` |
| Server → Client | `message_deleted` | `{ conversationId, messageId }` |
| Server → Client | `message_reaction_updated` | `{ conversationId, messageId, reactions: [{ emoji, users[] }] }` |
| Server → Client | `read_receipt` | `{ conversationId, userId, username, readAt }` |
| Server → Client | `__ping__` | keepalive ping (string literal) |
| Client → Server | `__pong__` | keepalive response (string literal) |

#### Group events
| Direction | Event type | Payload |
|---|---|---|
| Server → Client | `new_group_message` | `{ groupId, message: { id, senderUsername, senderId, content, deleted, createdAt } }` |
| Server → Client | `group_message_deleted` | `{ groupId, messageId }` |
| Server → Client | `group_message_reaction_updated` | `{ groupId, messageId, reactions: [{ emoji, users[] }] }` |
| Server → Client | `group_member_added` | `{ groupId, userId, username }` |
| Server → Client | `group_member_removed` | `{ groupId, userId }` |
| Server → Client | `group_deleted` | `{ groupId }` |
| Server → Client | `group_renamed` | `{ groupId, name }` |
| Server → Client | `group_read_receipt` | `{ groupId, userId, username, readAt }` |
| Client → Server | `chat_presence` | `{ action: 'open'|'close', conversationType?, conversationId? }` |

#### Call signaling events
| Direction | Event type | Payload |
|---|---|---|
| Client → Server | `call_invite` | `{ conversationType, conversationId }` |
| Server → Client | `call_incoming` | `{ inviteId, fromUserId, fromUsername, conversationType, conversationId, timeoutMs }` |
| Client → Server | `call_join` | `{ conversationType, conversationId, publicKey? }` |
| Server → Client | `call_room_state` | `{ conversationType, conversationId, participants[] }` |
| Server → Client | `call_user_joined` | `{ conversationType, conversationId, userId, username, publicKey? }` |
| Server → Client | `call_user_left` | `{ conversationType, conversationId, userId, username, reason }` |
| Client ↔ Server | `call_offer` | `{ conversationType, conversationId, to/from, offer }` |
| Client ↔ Server | `call_answer` | `{ conversationType, conversationId, to/from, answer }` |
| Client ↔ Server | `call_ice_candidate` | `{ conversationType, conversationId, to/from, candidate }` |
| Client → Server | `call_decline` | `{ inviteId, toUserId, conversationType, conversationId }` |
| Server → Client | `call_declined` | `{ byUserId, byUsername, conversationType, conversationId }` |
| Server → Client | `call_accepted` | `{ byUserId, byUsername, conversationType, conversationId }` |
| Server → Client | `call_missed` | `{ toUserId, conversationType, conversationId }` |
| Server → Client | `call_invite_expired` | `{ inviteId, fromUserId, fromUsername, conversationType, conversationId }` |
| Server → Client | `call_error` | `{ message }` |

Connections that miss two consecutive pings are terminated automatically.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Server | Node.js, Express 5, TypeScript |
| Templating | Express Handlebars |
| Database | MongoDB (Mongoose) |
| Real-time | WebSockets (`ws`) |
| Encryption | OpenPGP.js (client-side) |
| Styling | Tailwind CSS v4, DaisyUI v5 |
| Bundler | Vite |
| Testing | Vitest |

---

## Database Schema

### User
| Field | Type | Notes |
|---|---|---|
| `username` | string | unique |
| `publicKey` | string | fingerprint; unique |
| `publicKeyArmored` | string | full ASCII-armored public key |
| `friends` | ObjectId[] | references User |
| `profilePicture` | string \| null | base64 image data URL |
| `createdAt` | datetime | |
| `updatedAt` | datetime | |

### Conversation
| Field | Type | Notes |
|---|---|---|
| `participants` | ObjectId[] | exactly 2; references User |
| `lastMessageAt` | datetime | used for sorting |
| `pinnedBy` | ObjectId[] | users who pinned this conversation |
| `mutedBy` | ObjectId[] | users who muted this conversation |
| `hiddenBy` | ObjectId[] | users who closed/hid this conversation |
| `createdAt` | datetime | |

### Message
| Field | Type | Notes |
|---|---|---|
| `conversationId` | ObjectId | references Conversation |
| `senderId` | ObjectId | references User |
| `content` | string | PGP-encrypted ciphertext |
| `deletedAt` | datetime | set when soft-deleted; `null` otherwise |
| `readBy` | `{ userId: ObjectId, readAt: datetime }[]` | users who have read this message |
| `reactions` | `{ emoji: string, users: ObjectId[] }[]` | reaction buckets keyed by emoji |
| `createdAt` | datetime | |

### FriendRequest
| Field | Type | Notes |
|---|---|---|
| `fromUserId` | ObjectId | references User |
| `toUserId` | ObjectId | references User |
| `status` | enum | `pending`, `accepted`, `declined` (app flow deletes accepted/declined requests) |
| `createdAt` | datetime | |

### Notification
| Field | Type | Notes |
|---|---|---|
| `userId` | ObjectId | recipient; references User |
| `type` | enum | `friend_request`, `message`, `group_invite` |
| `title` | string | short heading shown in the bell dropdown |
| `body` | string | optional detail text |
| `link` | string | where the "Open" button navigates |
| `read` | boolean | `false` until marked read |
| `createdAt` | datetime | |

### GroupConversation
| Field | Type | Notes |
|---|---|---|
| `name` | string \| null | optional display name; falls back to member list |
| `adminId` | ObjectId | references User; the group creator/current admin |
| `members` | `{ userId: ObjectId, publicKeyArmored: string }[]` | 1–10 entries; forms the encryption key ring |
| `pinnedBy` | ObjectId[] | users who pinned this group |
| `mutedBy` | ObjectId[] | users who muted this group |
| `lastMessageAt` | datetime \| null | used for sorting |
| `createdAt` | datetime | |

### GroupMessage
| Field | Type | Notes |
|---|---|---|
| `groupId` | ObjectId | references GroupConversation |
| `senderId` | ObjectId | references User |
| `content` | string | PGP-encrypted ciphertext (encrypted for every member's key) |
| `deletedAt` | datetime | set when soft-deleted; `null` otherwise |
| `readBy` | `{ userId: ObjectId, readAt: datetime }[]` | members who have read this message |
| `reactions` | `{ emoji: string, users: ObjectId[] }[]` | reaction buckets keyed by emoji |
| `createdAt` | datetime | |

---

## API Routes

### Pages
| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Home / dashboard (stats + quick actions when logged in) |
| `GET` | `/profile` | Profile page (username, member since, armored public key) |
| `GET` | `/friends` | Friends page (friends list + incoming requests) |
| `GET` | `/chat` | Chat page (conversation list + message view) |

### Auth / User
| Method | Path | Description |
|---|---|---|
| `GET` | `/login` | Login page |
| `GET` | `/login/challenge` | Request a PGP-encrypted challenge for the given public key |
| `POST` | `/login/verify` | Submit the decrypted challenge to complete authentication |
| `GET` | `/signup` | Sign-up landing |
| `GET` | `/signup/generate` | Generate a new PGP key pair |
| `GET` | `/signup/import` | Import an existing PGP key |
| `POST` | `/signup/generate` | Register with a generated key |
| `POST` | `/signup/import` | Register with an imported key |
| `POST` | `/profile/avatar` | Upload or update your profile picture (base64 data URL) |
| `GET` | `/user/:userId/avatar` | Get a user avatar (used by the chat UI) |
| `GET` | `/user/search` | Search for a user by exact username (used by group invite) |
| `DELETE` | `/profile/account` | Permanently delete your account (requires private key + passphrase) |
| `POST` | `/logout` | Destroy session |

### Friends
| Method | Path | Description |
|---|---|---|
| `POST` | `/friends/request` | Send a friend request (by public key) |
| `POST` | `/friends/accept/:requestId` | Accept a friend request (deletes the request record) |
| `POST` | `/friends/decline/:requestId` | Decline a friend request (deletes the request record) |
| `POST` | `/friends/remove/:friendId` | Remove a friend and permanently delete the shared conversation and all messages |
| `GET` | `/friends/list` | JSON list of friends (used by friend picker) |

### Chat
| Method | Path | Description |
|---|---|---|
| `GET` | `/chat` | Chat page (lists all conversations) |
| `POST` | `/chat/start` | Get or create a conversation with a friend |
| `GET` | `/chat/:conversationId/messages` | Load messages for a conversation |
| `POST` | `/chat/:conversationId/read` | Mark all unread messages in a conversation as read (current user) |
| `POST` | `/chat/:conversationId/messages` | Send a message |
| `DELETE` | `/chat/:conversationId/messages/:messageId` | Soft-delete a message |
| `POST` | `/chat/:conversationId/messages/:messageId/reactions` | Toggle an emoji reaction on a DM message |
| `POST` | `/chat/:conversationId/pin` | Toggle pin for a conversation |
| `POST` | `/chat/:conversationId/mute` | Toggle mute for a conversation |
| `DELETE` | `/chat/:conversationId` | Close (and optionally delete messages in) a conversation |
| `GET` | `/chat/:conversationId/recipient-key` | Fetch the recipient's public key for encryption |

### Notifications
| Method | Path | Description |
|---|---|---|
| `GET` | `/notifications` | List all notifications for the current user |
| `POST` | `/notifications/read-all` | Mark all notifications as read |
| `POST` | `/notifications/:id/read` | Mark a single notification as read |
| `DELETE` | `/notifications` | Dismiss all notifications |
| `DELETE` | `/notifications/:id` | Dismiss (permanently delete) a notification |

### Group Chats
| Method | Path | Description |
|---|---|---|
| `POST` | `/group/create` | Create a new group with a name and initial member list |
| `GET` | `/group/:groupId/info` | Get group info (name, admin, member list) |
| `GET` | `/group/:groupId/keyring` | Get the array of armored public keys for all members |
| `GET` | `/group/:groupId/messages` | Load messages for a group |
| `POST` | `/group/:groupId/read` | Mark all unread messages in a group as read (current user) |
| `POST` | `/group/:groupId/messages` | Send a message to a group |
| `DELETE` | `/group/:groupId/messages/:messageId` | Soft-delete a group message (sender only) |
| `POST` | `/group/:groupId/messages/:messageId/reactions` | Toggle an emoji reaction on a group message |
| `POST` | `/group/:groupId/invite` | Invite a user to the group (any member) |
| `DELETE` | `/group/:groupId/members/:memberId` | Kick a member (admin only) |
| `POST` | `/group/:groupId/leave` | Leave the group |
| `POST` | `/group/:groupId/pin` | Toggle pin for the group |
| `POST` | `/group/:groupId/mute` | Toggle mute for the group |
| `PATCH` | `/group/:groupId/name` | Rename the group (any member) |
| `DELETE` | `/group/:groupId` | Delete the group entirely (admin only) |

### Call Transport (WebSocket)
Call signaling is handled over the existing authenticated WebSocket endpoint at `/ws`.
There are no separate REST call routes; call state is synchronized via the event protocol documented above.

---

## How To Run

### Prerequisites
- Node.js 18+
- A running MongoDB instance

### Setup

1. **Clone the repository and install dependencies:**
   ```bash
   git clone https://github.com/ManOfTheMask/KeepQuiet.git
   cd KeepQuiet
   npm install
   ```

2. **Create a `.env` file** in the project root:
   ```env
   MONGO_URI="mongodb://localhost:27017/KeepQuiet"
   SESSION_SECRET="your-session-secret"
   # Optional TURN relay (recommended for restrictive NAT/firewalls)
   TURN_URL="turn:your-turn.example.com:3478,turns:your-turn.example.com:5349"
   TURN_USERNAME="your-turn-username"
   TURN_CREDENTIAL="your-turn-password"
   ```

3. **Run the application:**

   | Command | Description |
   |---|---|
   | `npm run dev` | Start in development mode with file watching |
   | `npm run build` | Compile and bundle for production |
   | `npm run start` | Start the production build |
   | `npm run test` | Build and run the test suite |
   | `npm run clean` | Delete the `dist/` directory |

---

## Upcoming Features

- ~~**Theme picker** — let users choose from DaisyUI's built-in themes or customise accent colours~~
- ~~**Group chats** — multi-participant conversations with shared group key management up to 10 people~~
- ~~**Message reactions** — emoji reactions on individual messages~~
- ~~**Read receipts** — show when a message has been seen by the recipient~~
- **File / image sharing** — encrypted attachment support
- **Notification preferences** — advanced controls (quiet hours, mention-only rules, per-device behavior)
- ~~**E2EE Voice & Video Chat** — E2EE Voice & Video Chat for 10 people~~
- ~~**Call invites + timeout handling** — incoming call modal, accept/decline, missed/expired statuses~~
- ~~**Screen sharing in calls** — switch outgoing video track to display capture and restore camera~~
- **Mobile app** — a native wrapper (e.g. Capacitor or Tauri) around the existing web UI

---

## Tests Added

- Added call signaling lifecycle coverage in `src/Tests/callsignaling.test.ts`.
- Covered scenarios:
   - authorized invite delivery
   - accept flow on join
   - decline flow
   - invite timeout -> missed/expired events
   - signaling relay authorization
   - leave notifications

---

## Contributing

Contributions are welcome as long as they align with the goal of the project: private, self-hosted, end-to-end encrypted messaging that is simple to use.

---

## Release Progress

KeepQuiet is now in late-stage feature polishing and adding and is **nearing a V1.0 release**.
