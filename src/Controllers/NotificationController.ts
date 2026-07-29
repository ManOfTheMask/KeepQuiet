import NotificationModel from "../Models/NotificationModel";
import mongoose from "mongoose";

class NotificationController {
    async create(
        userId: string,
        type: "friend_request" | "message" | "group_invite",
        title: string,
        body: string,
        link: string,
    ) {
        return await NotificationModel.create({
            userId: new mongoose.Types.ObjectId(userId),
            type,
            title,
            body,
            link,
        });
    }

    /** Return notifications for a user, newest first (max 50). */
    async getForUser(userId: string) {
        return await NotificationModel.find({
            userId: new mongoose.Types.ObjectId(userId),
        })
            .sort({ createdAt: -1 })
            .limit(50)
            .lean();
    }

    /** Count unread notifications. */
    async countUnread(userId: string) {
        return await NotificationModel.countDocuments({
            userId: new mongoose.Types.ObjectId(userId),
            read: false,
        });
    }

    /** Mark a notification as read (must belong to the user). */
    async markRead(notificationId: string, userId: string) {
        const n = await NotificationModel.findById(notificationId);
        if (!n) throw new Error("Notification not found.");
        if (!n.userId.equals(new mongoose.Types.ObjectId(userId))) throw new Error("Unauthorized.");
        n.read = true;
        await n.save();
        return n;
    }

    /** Mark all notifications as read for a user. */
    async markAllRead(userId: string) {
        await NotificationModel.updateMany(
            { userId: new mongoose.Types.ObjectId(userId), read: false },
            { $set: { read: true } },
        );
    }

    /** Permanently delete a notification (dismiss). */
    async dismiss(notificationId: string, userId: string) {
        const n = await NotificationModel.findById(notificationId);
        if (!n) throw new Error("Notification not found.");
        if (!n.userId.equals(new mongoose.Types.ObjectId(userId))) throw new Error("Unauthorized.");
        await n.deleteOne();
    }

    /** Permanently delete all notifications for a user (dismiss all). */
    async dismissAll(userId: string) {
        const result = await NotificationModel.deleteMany({
            userId: new mongoose.Types.ObjectId(userId),
        });
        return { deletedCount: result.deletedCount ?? 0 };
    }
}

export default new NotificationController();
