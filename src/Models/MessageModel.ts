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
});

const MessageModel = mongoose.model("Message", messageSchema);

export default MessageModel;
