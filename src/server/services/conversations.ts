import type { Conversation, ConversationRecord, Invite } from "../../shared/shared-types.js";
import { getHandler } from "../server-types.js";
import { type AfterHook, type ServerContext, type ServiceResult, fireHook, newId, now } from "../context.js";
import { effectiveMaxParticipants } from "../validation.js";
import { addMessage } from "./messages.js";
import { logError } from "../../shared/log.js";

// Adds the participant atomically, posts the join system message, returns hooks to fire after RPC response
async function joinFlow(ctx: ServerContext, conversationId: string, participantId: string, conversation: Conversation): Promise<AfterHook[]> {
    const max = effectiveMaxParticipants(conversation.maxSize, ctx.rateLimits.conversationParticipantLimit);
    await getHandler(ctx.handlers, "addConversationParticipant")(conversationId, participantId, max);
    const sysMsg = await addMessage(ctx, conversationId, participantId, "", { referenceMessageId: null, isForwarded: false }, { type: "participantJoined", participantId });
    return [() => fireHook(ctx.handlers, "afterParticipantJoined", conversationId, participantId), ...sysMsg.hooks];
}

export async function createConversation(ctx: ServerContext, participantId: string, maxSize?: number): Promise<ServiceResult<string>> {
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
    return { result: conversationId, hooks: [() => fireHook(ctx.handlers, "afterConversationCreated", surfaced)] };
}

export async function createInvite(ctx: ServerContext, fromParticipantId: string, conversationId: string, toParticipantId: string): Promise<ServiceResult<void>> {
    if (fromParticipantId === toParticipantId) throw new Error("Cannot invite yourself");
    ctx.rateLimiter.trackInvite(fromParticipantId);

    const conversation = await getHandler(ctx.handlers, "readConversation")(conversationId);
    if (!conversation) throw new Error("Conversation not found");
    if (!conversation.participants.includes(fromParticipantId)) throw new Error("Not a participant of this conversation");

    // Capacity check is best-effort, accept-invite enforces it atomically
    const max = effectiveMaxParticipants(conversation.maxSize, ctx.rateLimits.conversationParticipantLimit);
    if (conversation.participants.length >= max) throw new Error("Conversation is full");

    // Optional consumer-defined gate, e.g. for blocking participants
    if (ctx.handlers.inviteAuth) {
        let allowed: boolean;
        try { allowed = await ctx.handlers.inviteAuth(fromParticipantId, toParticipantId); }
        catch (error) { logError("inviteAuth", error); throw new Error("Invite check failed"); }
        if (!allowed) throw new Error("Not authorized to invite this participant");
    }

    const invite: Invite = {
        fromParticipantId,
        toParticipantId,
        conversation,
        createdAt: now(),
    };
    // Handler dedupes on (conversationId, toParticipantId), throws if recipient is already a participant
    await getHandler(ctx.handlers, "createInvite")(invite);
    ctx.subscriptions.broadcastInvite(invite);
    return { result: undefined, hooks: [() => fireHook(ctx.handlers, "afterInviteCreated", invite)] };
}

export async function revokeInvite(ctx: ServerContext, participantId: string, conversationId: string, toParticipantId: string): Promise<ServiceResult<void>> {
    const invite = await getHandler(ctx.handlers, "readInvite")(conversationId, toParticipantId);
    if (!invite) throw new Error("Invite not found");
    if (invite.fromParticipantId !== participantId) throw new Error("Not authorized to revoke this invite");
    return revokeInviteByPair(ctx, conversationId, invite.fromParticipantId, toParticipantId);
}

// Admin-friendly variant, no ownership check
export async function revokeInviteByPair(ctx: ServerContext, conversationId: string, fromParticipantId: string, toParticipantId: string): Promise<ServiceResult<void>> {
    await getHandler(ctx.handlers, "deleteInvites")([{ conversationId, toParticipantId }]);
    ctx.subscriptions.broadcastInviteDeleted(conversationId, fromParticipantId, toParticipantId);
    return { result: undefined, hooks: [() => fireHook(ctx.handlers, "afterInviteDeleted", conversationId, fromParticipantId, toParticipantId)] };
}

export async function acceptInvite(ctx: ServerContext, participantId: string, conversationId: string): Promise<ServiceResult<void>> {
    const conversation = await getHandler(ctx.handlers, "readConversation")(conversationId);
    if (!conversation) throw new Error("Conversation not found");

    // Get matching invites
    const invites = await getHandler(ctx.handlers, "readInvites")(participantId);
    const matching = invites.filter(invite => invite.conversation.conversationId === conversationId && invite.toParticipantId === participantId);

    const hooks: AfterHook[] = [];
    if (!conversation.participants.includes(participantId)) {
        hooks.push(...await joinFlow(ctx, conversationId, participantId, conversation));
    }

    if (matching.length > 0) {
        await getHandler(ctx.handlers, "deleteInvites")(matching.map(invite => ({ conversationId, toParticipantId: invite.toParticipantId })));
        for (const invite of matching) {
            ctx.subscriptions.broadcastInviteDeleted(conversationId, invite.fromParticipantId, invite.toParticipantId);
            hooks.push(() => fireHook(ctx.handlers, "afterInviteDeleted", conversationId, invite.fromParticipantId, invite.toParticipantId));
        }
    }

    const updated = await getHandler(ctx.handlers, "readConversation")(conversationId);
    if (updated) ctx.subscriptions.broadcastConversation(updated);

    return { result: undefined, hooks };
}

// Admin-only direct add, no invite required
export async function joinConversation(ctx: ServerContext, conversationId: string, participantId: string): Promise<ServiceResult<void>> {
    const conversation = await getHandler(ctx.handlers, "readConversation")(conversationId);
    if (!conversation) throw new Error("Conversation not found");

    const hooks: AfterHook[] = [];
    if (!conversation.participants.includes(participantId)) {
        hooks.push(...await joinFlow(ctx, conversationId, participantId, conversation));
    }

    const updated = await getHandler(ctx.handlers, "readConversation")(conversationId);
    if (updated) ctx.subscriptions.broadcastConversation(updated);

    return { result: undefined, hooks };
}

export async function declineInvite(ctx: ServerContext, participantId: string, conversationId: string): Promise<ServiceResult<void>> {
    const invites = await getHandler(ctx.handlers, "readInvites")(participantId);
    const matching = invites.filter(invite => invite.conversation.conversationId === conversationId && invite.toParticipantId === participantId);
    if (matching.length === 0) return { result: undefined, hooks: [] };
    await getHandler(ctx.handlers, "deleteInvites")(matching.map(invite => ({ conversationId, toParticipantId: invite.toParticipantId })));
    const hooks: AfterHook[] = [];
    for (const invite of matching) {
        ctx.subscriptions.broadcastInviteDeleted(conversationId, invite.fromParticipantId, invite.toParticipantId);
        hooks.push(() => fireHook(ctx.handlers, "afterInviteDeleted", conversationId, invite.fromParticipantId, invite.toParticipantId));
    }
    return { result: undefined, hooks };
}

export async function leaveConversation(ctx: ServerContext, participantId: string, conversationId: string): Promise<ServiceResult<void>> {
    const conversation = await getHandler(ctx.handlers, "readConversation")(conversationId);
    if (!conversation) throw new Error("Conversation not found");
    if (!conversation.participants.includes(participantId)) throw new Error("Not a participant of this conversation");

    if (conversation.participants.length === 1) {
        // Delete conversation if now empty
        await getHandler(ctx.handlers, "deleteConversationWithMessagesAndReactions")(conversationId);
        await getHandler(ctx.handlers, "deleteConversationParticipantActivities")([conversationId], conversation.participants);
        ctx.subscriptions.broadcastConversationDeleted(conversationId, conversation.participants);
        return {
            result: undefined,
            hooks: [
                () => fireHook(ctx.handlers, "afterParticipantLeft", conversationId, participantId),
                () => fireHook(ctx.handlers, "afterConversationDeleted", conversationId),
            ],
        };
    }

    const sysMsg = await addMessage(ctx, conversationId, participantId, "", { referenceMessageId: null, isForwarded: false }, { type: "participantLeft", participantId });
    await getHandler(ctx.handlers, "removeConversationParticipant")(conversationId, participantId);
    await getHandler(ctx.handlers, "deleteConversationParticipantActivities")([conversationId], [participantId]);

    // Tell the leaver their entry is gone, then refresh remaining participants' view of the conversation
    ctx.subscriptions.broadcastConversationDeleted(conversationId, [participantId]);
    const updated = await getHandler(ctx.handlers, "readConversation")(conversationId);
    if (updated) ctx.subscriptions.broadcastConversation(updated);

    return {
        result: undefined,
        hooks: [...sysMsg.hooks, () => fireHook(ctx.handlers, "afterParticipantLeft", conversationId, participantId)],
    };
}
