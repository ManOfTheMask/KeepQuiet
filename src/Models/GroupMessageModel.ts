import mongoose from "mongoose";

const groupMessageSchema = new mongoose.Schema({
    groupId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "GroupConversation",
        required: true,
    },

    senderId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
    },

    content: {
        type: String,
        required: true,
    },
    attachment: {
        type: {
            fileId: { type: mongoose.Schema.Types.ObjectId, required: true },
            fileName: { type: String, required: true },
            mimeType: { type: String, required: true },
            sizeBytes: { type: Number, required: true },
            encryptedSizeBytes: { type: Number, required: true },
        },
        default: null,
    },

    deletedAt: {
        type: Date,
        default: null,
    },

    createdAt: {
        type: Date,
        default: Date.now,
    },

    readBy: {
        type: [
            {
                userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
                readAt: { type: Date, required: true },
            },
        ],
        default: [],
    },
    reactions: {
        type: [
            {
                emoji: { type: String, required: true },
                users: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
            },
        ],
        default: [],
    },
});

const GroupMessageModel = mongoose.model("GroupMessage", groupMessageSchema);

export default GroupMessageModel;
