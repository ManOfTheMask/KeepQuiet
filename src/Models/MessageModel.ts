import mongoose from "mongoose";

const messageSchema = new mongoose.Schema({
    conversationId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Conversation",
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

const MessageModel = mongoose.model("Message", messageSchema);

export default MessageModel;
