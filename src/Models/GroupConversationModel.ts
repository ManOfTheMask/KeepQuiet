import mongoose from "mongoose";

const groupConversationSchema = new mongoose.Schema({
    name: {
        type: String,
        default: null,
    },

    adminId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
    },

    // Each entry holds a user reference AND their armored public key at join time
    // This forms the "key ring" — all keys needed to encrypt a group message
    members: {
        type: [
            {
                userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
                publicKeyArmored: { type: String, required: true },
            },
        ],
        default: [],
        validate: (v: any[]) => v.length >= 1 && v.length <= 10,
    },

    pinnedBy: {
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

const GroupConversationModel = mongoose.model("GroupConversation", groupConversationSchema);

export default GroupConversationModel;
