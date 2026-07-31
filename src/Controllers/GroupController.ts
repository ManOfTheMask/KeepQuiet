import mongoose from "mongoose";
import GroupConversationModel from "../Models/GroupConversationModel";
import GroupMessageModel from "../Models/GroupMessageModel";
import UserModel from "../Models/UserModel";

interface MessageAttachmentInput {
    attachmentId: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    encryptedSizeBytes: number;
}

const ATTACHMENT_PLACEHOLDER_CONTENT = "[Attachment]";

function normalizeAttachment(attachment?: MessageAttachmentInput) {
    if (!attachment) return null;
    const {
        attachmentId,
        fileName,
        mimeType,
        sizeBytes,
        encryptedSizeBytes,
    } = attachment;

    if (!mongoose.Types.ObjectId.isValid(attachmentId)) {
        throw new Error("Invalid attachment id.");
    }
    if (!fileName?.trim()) throw new Error("Attachment fileName is required.");
    if (!mimeType?.trim()) throw new Error("Attachment mimeType is required.");
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
        throw new Error("Attachment sizeBytes must be a positive number.");
    }
    if (!Number.isFinite(encryptedSizeBytes) || encryptedSizeBytes <= 0) {
        throw new Error("Attachment encryptedSizeBytes must be a positive number.");
    }

    return {
        fileId: new mongoose.Types.ObjectId(attachmentId),
        fileName: fileName.trim(),
        mimeType: mimeType.trim(),
        sizeBytes,
        encryptedSizeBytes,
    };
}

class GroupController {
    /**
     * Create a new group conversation.
     * adminId is always included as a member.
     * memberUserIds is the additional member ids (up to 9 more, total max 10).
     */
    async createGroup(adminId: string, name: string | null, memberUserIds: string[]) {
        const allIds = Array.from(new Set([adminId, ...memberUserIds]));
        if (allIds.length > 10) throw new Error("Group chats are limited to 10 members.");
        if (allIds.length < 2)  throw new Error("A group requires at least 2 members.");

        // Fetch all users to build the key ring
        const users = await UserModel.find({ _id: { $in: allIds.map(id => new mongoose.Types.ObjectId(id)) } });
        if (users.length !== allIds.length) throw new Error("One or more users not found.");

        const members = users.map(u => ({
            userId: u._id,
            publicKeyArmored: (u as any).publicKeyArmored ?? null,
        }));

        // Every member must have an armored public key for encryption to work
        const missing = members.filter(m => !m.publicKeyArmored).map(m => m.userId.toString());
        if (missing.length > 0) throw new Error(`Some members have no PGP key stored: ${missing.join(", ")}`);

        return await GroupConversationModel.create({
            name: name?.trim() || null,
            adminId: new mongoose.Types.ObjectId(adminId),
            members,
        });
    }

    /** Return all groups the user is a member of, most recently active first. */
    async getGroupsForUser(userId: string) {
        const uid = new mongoose.Types.ObjectId(userId);

        const groups = await GroupConversationModel.find({ "members.userId": uid })
            .populate('members.userId', 'username')
            .sort({ lastMessageAt: -1 })
            .lean();

        return groups.map((g: any) => ({
            ...g,
            muted: (g.mutedBy ?? []).some((p: any) => p.equals(uid)),
        }));
    }

    /** Get group info (name, admin, member list) — must be a member. */
    async getGroupInfo(groupId: string, userId: string) {
        const gid = new mongoose.Types.ObjectId(groupId);
        const uid = new mongoose.Types.ObjectId(userId);

        const group = await GroupConversationModel.findById(gid)
            .populate("members.userId", "username profilePicture")
            .populate("adminId", "username")
            .lean();

        if (!group) throw new Error("Group not found.");
        const isMember = (group.members as any[]).some((m: any) => m.userId._id.equals(uid));
        if (!isMember) throw new Error("Unauthorized.");

        return group;
    }

    /** Return the key ring (array of armoredPublicKeys) for a group — must be a member. */
    async getKeyring(groupId: string, userId: string) {
        const gid = new mongoose.Types.ObjectId(groupId);
        const uid = new mongoose.Types.ObjectId(userId);

        const group = await GroupConversationModel.findById(gid);
        if (!group) throw new Error("Group not found.");

        const isMember = (group.members as any[]).some((m: any) => m.userId.equals(uid));
        if (!isMember) throw new Error("Unauthorized.");

        const memberIds = (group.members as any[]).map((m: any) => m.userId);
        const users = await UserModel.find({ _id: { $in: memberIds } }, 'publicKeyArmored username').lean();
        const userById = new Map(users.map((u: any) => [u._id.toString(), u]));

        const missingOrInvalid: string[] = [];
        let changed = false;

        for (const member of group.members as any[]) {
            const user = userById.get(member.userId.toString());
            const key = user?.publicKeyArmored;
            const looksArmored = typeof key === 'string'
                && key.includes('-----BEGIN PGP PUBLIC KEY BLOCK-----')
                && key.includes('-----END PGP PUBLIC KEY BLOCK-----');

            if (!looksArmored) {
                missingOrInvalid.push(user?.username ?? member.userId.toString());
                continue;
            }

            if (member.publicKeyArmored !== key) {
                member.publicKeyArmored = key;
                changed = true;
            }
        }

        if (missingOrInvalid.length > 0) {
            throw new Error(`Some members have invalid or missing PGP keys: ${missingOrInvalid.join(', ')}`);
        }

        if (changed) {
            await group.save();
        }

        return (group.members as any[]).map((m: any) => m.publicKeyArmored as string);
    }

    /** Get messages for a group — must be a member. */
    async getMessages(groupId: string, userId: string) {
        const gid = new mongoose.Types.ObjectId(groupId);
        const uid = new mongoose.Types.ObjectId(userId);

        const group = await GroupConversationModel.findById(gid).lean();
        if (!group) throw new Error("Group not found.");

        const isMember = (group.members as any[]).some((m: any) => m.userId.equals(uid));
        if (!isMember) throw new Error("Unauthorized.");

        return await GroupMessageModel.find({ groupId: gid })
            .populate("senderId", "username")
            .populate("readBy.userId", "username")
            .sort({ createdAt: 1 })
            .lean();
    }

    /** Mark all unread messages in a group as read for the given user. */
    async markMessagesRead(groupId: string, userId: string) {
        const gid = new mongoose.Types.ObjectId(groupId);
        const uid = new mongoose.Types.ObjectId(userId);

        const group = await GroupConversationModel.findById(gid).lean();
        if (!group) throw new Error("Group not found.");

        const isMember = (group.members as any[]).some((m: any) => m.userId.equals(uid));
        if (!isMember) throw new Error("Unauthorized.");

        const now = new Date();
        await GroupMessageModel.updateMany(
            {
                groupId: gid,
                senderId: { $ne: uid },
                "readBy.userId": { $ne: uid },
                deletedAt: null,
            },
            { $push: { readBy: { userId: uid, readAt: now } } },
        );

        return { readAt: now };
    }

    /** Send a message to a group — must be a member. */
    async sendMessage(
        groupId: string,
        senderId: string,
        content: string,
        attachment?: MessageAttachmentInput,
    ) {
        const normalizedContent = content?.trim() ?? "";
        const normalizedAttachment = normalizeAttachment(attachment);
        if (!normalizedContent && !normalizedAttachment) {
            throw new Error("Message content cannot be empty.");
        }

        const gid = new mongoose.Types.ObjectId(groupId);
        const sid = new mongoose.Types.ObjectId(senderId);

        const group = await GroupConversationModel.findById(gid);
        if (!group) throw new Error("Group not found.");

        const isMember = (group.members as any[]).some((m: any) => m.userId.equals(sid));
        if (!isMember) throw new Error("Unauthorized.");

        const message = await GroupMessageModel.create({
            groupId: gid,
            senderId: sid,
            content: normalizedContent || ATTACHMENT_PLACEHOLDER_CONTENT,
            attachment: normalizedAttachment,
        });

        group.lastMessageAt = new Date();
        await group.save();

        return message;
    }

    /** Soft-delete a message — sender only. */
    async deleteMessage(messageId: string, userId: string) {
        const msg = await GroupMessageModel.findById(messageId);
        if (!msg) throw new Error("Message not found.");
        if (!msg.senderId.equals(new mongoose.Types.ObjectId(userId))) {
            throw new Error("Unauthorized.");
        }
        msg.deletedAt = new Date();
        await msg.save();
        return msg;
    }

    /**
     * Invite / add a member to a group.
     * Any current member can invite. The target must have an armored public key.
     */
    async inviteMember(groupId: string, inviterId: string, targetUserId: string) {
        const gid = new mongoose.Types.ObjectId(groupId);
        const iid = new mongoose.Types.ObjectId(inviterId);
        const tid = new mongoose.Types.ObjectId(targetUserId);

        const group = await GroupConversationModel.findById(gid);
        if (!group) throw new Error("Group not found.");

        const isInviterMember = (group.members as any[]).some((m: any) => m.userId.equals(iid));
        if (!isInviterMember) throw new Error("Only group members can invite others.");

        if ((group.members as any[]).some((m: any) => m.userId.equals(tid))) {
            throw new Error("User is already a member of this group.");
        }

        if (group.members.length >= 10) throw new Error("Group is full (10 members max).");

        const target = await UserModel.findById(tid);
        if (!target) throw new Error("User not found.");
        if (!(target as any).publicKeyArmored) {
            throw new Error("That user has no PGP key stored and cannot join encrypted groups.");
        }

        await GroupConversationModel.findByIdAndUpdate(gid, {
            $push: { members: { userId: tid, publicKeyArmored: (target as any).publicKeyArmored } },
        });

        return target;
    }

    /**
     * Kick a member — admin only.
     * Deletes all messages sent by that member and removes their key from the ring.
     */
    async removeMember(groupId: string, requesterId: string, targetUserId: string) {
        const gid = new mongoose.Types.ObjectId(groupId);
        const rid = new mongoose.Types.ObjectId(requesterId);
        const tid = new mongoose.Types.ObjectId(targetUserId);

        const group = await GroupConversationModel.findById(gid);
        if (!group) throw new Error("Group not found.");

        if (!(group.adminId as any).equals(rid)) {
            throw new Error("Only the group admin can remove members.");
        }

        if (tid.equals(rid)) throw new Error("Admin cannot remove themselves — use leave instead.");

        const messagesWithAttachments = await GroupMessageModel.find(
            { groupId: gid, senderId: tid, deletedAt: null, attachment: { $ne: null } },
            { 'attachment.fileId': 1 },
        ).lean();
        const deletedAttachmentIds = messagesWithAttachments
            .map((m: any) => m?.attachment?.fileId?.toString())
            .filter((id: string | undefined): id is string => !!id);

        // Soft-delete all messages by this member
        await GroupMessageModel.updateMany(
            { groupId: gid, senderId: tid, deletedAt: null },
            { $set: { deletedAt: new Date() } },
        );

        // Remove from members array (and key ring)
        await GroupConversationModel.findByIdAndUpdate(gid, {
            $pull: { members: { userId: tid } },
        });

        return { deletedAttachmentIds };
    }

    /**
     * Leave a group voluntarily.
     * Deletes all messages by this user and removes their key from the ring.
     * If the admin leaves and others remain, promote the earliest-joined member.
     */
    async leaveGroup(groupId: string, userId: string) {
        const gid = new mongoose.Types.ObjectId(groupId);
        const uid = new mongoose.Types.ObjectId(userId);

        const group = await GroupConversationModel.findById(gid);
        if (!group) throw new Error("Group not found.");

        const isMember = (group.members as any[]).some((m: any) => m.userId.equals(uid));
        if (!isMember) throw new Error("You are not a member of this group.");

        const messagesWithAttachments = await GroupMessageModel.find(
            { groupId: gid, senderId: uid, deletedAt: null, attachment: { $ne: null } },
            { 'attachment.fileId': 1 },
        ).lean();
        const deletedAttachmentIds = messagesWithAttachments
            .map((m: any) => m?.attachment?.fileId?.toString())
            .filter((id: string | undefined): id is string => !!id);

        // Soft-delete all messages by this user
        await GroupMessageModel.updateMany(
            { groupId: gid, senderId: uid, deletedAt: null },
            { $set: { deletedAt: new Date() } },
        );

        // Remove member and their key
        const remainingMembers = (group.members as any[]).filter((m: any) => !m.userId.equals(uid));

        if (remainingMembers.length === 0) {
            // Last person leaving — delete the group
            await GroupConversationModel.findByIdAndDelete(gid);
            await GroupMessageModel.deleteMany({ groupId: gid });
            return { deletedAttachmentIds };
        }

        const update: any = { $pull: { members: { userId: uid } } };

        // Promote first remaining member if admin is leaving
        if ((group.adminId as any).equals(uid)) {
            update.$set = { adminId: remainingMembers[0].userId };
        }

        await GroupConversationModel.findByIdAndUpdate(gid, update);
        return { deletedAttachmentIds };
    }

    /**
     * Delete a group entirely — admin only.
     * Hard-deletes all messages and the group document.
     */
    async deleteGroup(groupId: string, userId: string) {
        const gid = new mongoose.Types.ObjectId(groupId);
        const uid = new mongoose.Types.ObjectId(userId);

        const group = await GroupConversationModel.findById(gid);
        if (!group) throw new Error("Group not found.");
        if (!(group.adminId as any).equals(uid)) throw new Error("Only the group admin can delete the group.");

        const messagesWithAttachments = await GroupMessageModel.find(
            { groupId: gid, attachment: { $ne: null } },
            { 'attachment.fileId': 1 },
        ).lean();
        const deletedAttachmentIds = messagesWithAttachments
            .map((m: any) => m?.attachment?.fileId?.toString())
            .filter((id: string | undefined): id is string => !!id);

        await GroupMessageModel.deleteMany({ groupId: gid });
        await GroupConversationModel.findByIdAndDelete(gid);
        return { deletedAttachmentIds };
    }

    /**
     * Rename a group — any member can do this.
     * Pass null or empty string to clear the name (falls back to member list display).
     */
    async renameGroup(groupId: string, userId: string, name: string | null) {
        const gid = new mongoose.Types.ObjectId(groupId);
        const uid = new mongoose.Types.ObjectId(userId);

        const group = await GroupConversationModel.findById(gid);
        if (!group) throw new Error("Group not found.");

        const isMember = (group.members as any[]).some((m: any) => m.userId.equals(uid));
        if (!isMember) throw new Error("Unauthorized.");

        const trimmed = name?.trim() || null;
        await GroupConversationModel.findByIdAndUpdate(gid, { $set: { name: trimmed } });
        return { name: trimmed };
    }

    /** Toggle pin for a user on a group. */
    async togglePin(groupId: string, userId: string) {
        const gid = new mongoose.Types.ObjectId(groupId);
        const uid = new mongoose.Types.ObjectId(userId);

        const group = await GroupConversationModel.findById(gid);
        if (!group) throw new Error("Group not found.");

        const isMember = (group.members as any[]).some((m: any) => m.userId.equals(uid));
        if (!isMember) throw new Error("Unauthorized.");

        const isPinned = (group.pinnedBy as any[]).some((p: any) => p.equals(uid));
        if (isPinned) {
            await GroupConversationModel.findByIdAndUpdate(gid, { $pull: { pinnedBy: uid } });
            return { pinned: false };
        } else {
            await GroupConversationModel.findByIdAndUpdate(gid, { $addToSet: { pinnedBy: uid } });
            return { pinned: true };
        }
    }

    /** Toggle mute for a user on a group. */
    async toggleMute(groupId: string, userId: string) {
        const gid = new mongoose.Types.ObjectId(groupId);
        const uid = new mongoose.Types.ObjectId(userId);

        const group = await GroupConversationModel.findById(gid);
        if (!group) throw new Error("Group not found.");

        const isMember = (group.members as any[]).some((m: any) => m.userId.equals(uid));
        if (!isMember) throw new Error("Unauthorized.");

        const isMuted = (group.mutedBy as any[]).some((p: any) => p.equals(uid));
        if (isMuted) {
            await GroupConversationModel.findByIdAndUpdate(gid, { $pull: { mutedBy: uid } });
            return { muted: false };
        } else {
            await GroupConversationModel.findByIdAndUpdate(gid, { $addToSet: { mutedBy: uid } });
            return { muted: true };
        }
    }

    /** Toggle a reaction on a group message for the calling user. */
    async toggleReaction(groupId: string, messageId: string, userId: string, emoji: string) {
        const cleanEmoji = emoji?.trim();
        if (!cleanEmoji) throw new Error("emoji is required.");

        const gid = new mongoose.Types.ObjectId(groupId);
        const uid = new mongoose.Types.ObjectId(userId);

        const group = await GroupConversationModel.findById(gid);
        if (!group) throw new Error("Group not found.");

        const isMember = (group.members as any[]).some((m: any) => m.userId.equals(uid));
        if (!isMember) throw new Error("Unauthorized.");

        const msg = await GroupMessageModel.findOne({ _id: new mongoose.Types.ObjectId(messageId), groupId: gid });
        if (!msg) throw new Error("Message not found.");
        if (msg.deletedAt) throw new Error("Cannot react to a deleted message.");

        const reactions = (msg.reactions as any[]) ?? [];
        const existing = reactions.find((r: any) => r.emoji === cleanEmoji);

        if (!existing) {
            reactions.push({ emoji: cleanEmoji, users: [uid] });
        } else {
            const alreadyReacted = (existing.users as any[]).some((id: any) => id.equals(uid));
            if (alreadyReacted) {
                existing.users = (existing.users as any[]).filter((id: any) => !id.equals(uid));
            } else {
                existing.users.push(uid);
            }
        }

        msg.reactions = reactions.filter((r: any) => (r.users ?? []).length > 0) as any;
        await msg.save();

        return {
            messageId: msg._id.toString(),
            reactions: (msg.reactions as any[]).map((r: any) => ({
                emoji: r.emoji,
                users: (r.users ?? []).map((id: any) => id.toString()),
            })),
        };
    }
}

export default new GroupController();
