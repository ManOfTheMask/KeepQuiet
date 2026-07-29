import mongoose from "mongoose";

const conversationSchema = new mongoose.Schema({
    participants: {
        type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
        required: true,
        validate: (v: any[]) => v.length === 2,
    },
    pinnedBy: {
        type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
        default: [],
    },
    hiddenBy: {
        type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
        default: [],
    },
    mutedBy: {
        type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
        default: [],
    },
    lastMessageAt: {
        type: Date,
        default: null,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

// Ensure only one conversation exists between any two users
conversationSchema.index({ participants: 1 });

const ConversationModel = mongoose.model("Conversation", conversationSchema);

export default ConversationModel;
