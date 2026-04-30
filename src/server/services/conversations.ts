import type { Conversation, ConversationRecord, Invite } from "../../shared/shared-types.js";
import { getHandler } from "../server-types.js";
import { type ServerContext, newId, now } from "../context.js";
import { effectiveMaxParticipants } from "../validation.js";
import { addMessage } from "./messages.js";

export async function createConversation(ctx: ServerContext, participantId: string, maxSize?: number): Promise<string> {
    const conversationId = newId();
    const record: ConversationRecord = {
        conversationId,
        participants: [participantId],
        createdAt: now(),
        lastActivityAt: now(),
        maxSize: maxSize ?? null, // Stored as-is, the global cap is re-applied at every join check
    };
    await getHandler(ctx.handlers, "createConversation")(record);
    const surfaced: Conversation = { ...record, lastMessage: null };
    ctx.subscriptions.broadcastConversation(surfaced);
    return conversationId;
}

export async function createInvite(ctx: ServerContext, fromParticipantId: string, conversationId: string, toParticipantId: string): Promise<void> {
    if (fromParticipantId === toParticipantId) throw new Error("Cannot invite yourself");
    ctx.rateLimiter.trackInvite(fromParticipantId);

    const conversation = await getHandler(ctx.handlers, "readConversation")(conversationId);
    if (!conversation) throw new Error("Conversation not found");
    if (!conversation.participants.includes(fromParticipantId)) throw new Error("Not a participant of this conversation");

    // Capacity check is best-effort, accept-invite enforces it atomically
    const max = effectiveMaxParticipants(conversation.maxSize, ctx.rateLimits.conversationParticipantLimit);
    if (conversation.participants.length >= max) throw new Error("Conversation is full");

    const invite: Invite = {
        fromParticipantId,
        toParticipantId,
        conversation,
        createdAt: now(),
    };
    // Handler dedupes on (conversationId, toParticipantId), throws if recipient is already a participant
    await getHandler(ctx.handlers, "createInvite")(invite);
    ctx.subscriptions.broadcastInvite(invite);
}

export async function revokeInvite(ctx: ServerContext, participantId: string, conversationId: string, toParticipantId: string): Promise<void> {
    const invite = await getHandler(ctx.handlers, "readInvite")(conversationId, toParticipantId);
    if (!invite) throw new Error("Invite not found");
    if (invite.fromParticipantId !== participantId) throw new Error("Not authorized to revoke this invite");
    await getHandler(ctx.handlers, "deleteInvites")([{ conversationId, toParticipantId }]);
    ctx.subscriptions.broadcastInviteDeleted(conversationId, invite.fromParticipantId, toParticipantId);
}

export async function acceptInvite(ctx: ServerContext, participantId: string, conversationId: string): Promise<void> {
    const conversation = await getHandler(ctx.handlers, "readConversation")(conversationId);
    if (!conversation) throw new Error("Conversation not found");

    // Get matching invites
    const invites = await getHandler(ctx.handlers, "readInvites")(participantId);
    const matching = invites.filter(invite => invite.conversation.conversationId === conversationId && invite.toParticipantId === participantId);

    if (!conversation.participants.includes(participantId)) {
        const max = effectiveMaxParticipants(conversation.maxSize, ctx.rateLimits.conversationParticipantLimit);
        // Consumer enforces the cap atomically and throws if rejected
        await getHandler(ctx.handlers, "addConversationParticipant")(conversationId, participantId, max);
        await addMessage(ctx, conversationId, participantId, "", { referenceMessageId: null, isForwarded: false }, { type: "participantJoined", participantId });
    }

    if (matching.length > 0) {
        await getHandler(ctx.handlers, "deleteInvites")(matching.map(invite => ({ conversationId, toParticipantId: invite.toParticipantId })));
        for (const invite of matching) {
            ctx.subscriptions.broadcastInviteDeleted(conversationId, invite.fromParticipantId, invite.toParticipantId);
        }
    }

    const updated = await getHandler(ctx.handlers, "readConversation")(conversationId);
    if (updated) ctx.subscriptions.broadcastConversation(updated);
}

export async function declineInvite(ctx: ServerContext, participantId: string, conversationId: string): Promise<void> {
    const invites = await getHandler(ctx.handlers, "readInvites")(participantId);
    const matching = invites.filter(invite => invite.conversation.conversationId === conversationId && invite.toParticipantId === participantId);
    if (matching.length === 0) return;
    await getHandler(ctx.handlers, "deleteInvites")(matching.map(invite => ({ conversationId, toParticipantId: invite.toParticipantId })));
    for (const invite of matching) {
        ctx.subscriptions.broadcastInviteDeleted(conversationId, invite.fromParticipantId, invite.toParticipantId);
    }
}

export async function leaveConversation(ctx: ServerContext, participantId: string, conversationId: string): Promise<void> {
    const conversation = await getHandler(ctx.handlers, "readConversation")(conversationId);
    if (!conversation) throw new Error("Conversation not found");
    if (!conversation.participants.includes(participantId)) throw new Error("Not a participant of this conversation");

    if (conversation.participants.length === 1) {
        // Delete conversation if now empty
        await getHandler(ctx.handlers, "deleteConversationWithMessagesAndReactions")(conversationId);
        await getHandler(ctx.handlers, "deleteConversationParticipantActivities")([conversationId], conversation.participants);
        ctx.subscriptions.broadcastConversationDeleted(conversationId, conversation.participants);
        return;
    }

    await addMessage(ctx, conversationId, participantId, "", { referenceMessageId: null, isForwarded: false }, { type: "participantLeft", participantId });
    await getHandler(ctx.handlers, "removeConversationParticipant")(conversationId, participantId);
    await getHandler(ctx.handlers, "deleteConversationParticipantActivities")([conversationId], [participantId]);

    // Tell the leaver their entry is gone, then refresh remaining participants' view of the conversation
    ctx.subscriptions.broadcastConversationDeleted(conversationId, [participantId]);
    const updated = await getHandler(ctx.handlers, "readConversation")(conversationId);
    if (updated) ctx.subscriptions.broadcastConversation(updated);
}
