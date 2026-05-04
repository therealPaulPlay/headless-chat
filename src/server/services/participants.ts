import type { Conversation, ConversationRecord, Message } from "../../shared/shared-types.js";
import { getHandler } from "../server-types.js";
import { type AfterHook, type ServerContext, type ServiceResult, fireHook } from "../context.js";
import { emitConversationDeleted } from "./conversations.js";

export async function deleteParticipant(ctx: ServerContext, participantId: string): Promise<ServiceResult<void>> {
    // Must be called AFTER the consumer has removed the user from their users table
    const hooks: AfterHook[] = [];

    // One atomic call removes the participant from every conversation and deletes their activity rows, auto-deleting empty ones
    const { deletedConversations, remainingConversations } = await getHandler(ctx.handlers, "leaveAllConversationsForParticipantAndDeleteParticipantActivities")(participantId);
    for (const c of deletedConversations) hooks.push(...handleAutoDeleted(ctx, participantId, c));
    for (const r of remainingConversations) hooks.push(...handleRemaining(ctx, participantId, r));

    // Catch invites involving this participant that aren't attached to a conversation they were in
    hooks.push(...await cleanupRemainingInvites(ctx, participantId));

    return { result: undefined, hooks };
}

function handleAutoDeleted(ctx: ServerContext, participantId: string, c: { conversationId: string, formerParticipantIds: string[], deletedInvites: { fromParticipantId: string, toParticipantId: string }[] }): AfterHook[] {
    for (const pid of c.formerParticipantIds) ctx.activityCache.invalidate(`${c.conversationId}|${pid}`);
    ctx.conversationCache.invalidate(c.conversationId);
    return [
        ...emitConversationDeleted(ctx, c.conversationId, c.formerParticipantIds, c.deletedInvites),
        () => fireHook(ctx.handlers, "afterParticipantLeft", c.conversationId, participantId),
    ];
}

function handleRemaining(ctx: ServerContext, participantId: string, r: { conversationId: string, conversationRecord: ConversationRecord, remainingParticipantIds: string[], lastMessage: Message | null }): AfterHook[] {
    ctx.activityCache.invalidate(`${r.conversationId}|${participantId}`);
    const refreshed: Conversation = { ...r.conversationRecord, participantIds: r.remainingParticipantIds, lastMessage: r.lastMessage };
    ctx.conversationCache.set(r.conversationId, refreshed);
    // Leaver sees the conversation gone, remaining participants get the refreshed snapshot
    ctx.subscriptions.emit(
        ctx.subscriptions.prepareConversationDeleted(r.conversationId, [participantId]),
        ctx.subscriptions.prepareConversation(refreshed),
    );
    return [() => fireHook(ctx.handlers, "afterParticipantLeft", r.conversationId, participantId)];
}

async function cleanupRemainingInvites(ctx: ServerContext, participantId: string): Promise<AfterHook[]> {
    const invites = await getHandler(ctx.handlers, "readInvitesInvolvingParticipant")(participantId);
    if (invites.length === 0) return [];
    await getHandler(ctx.handlers, "deleteInvites")(invites.map(i => ({ conversationId: i.conversation.conversationId, fromParticipantId: i.fromParticipantId, toParticipantId: i.toParticipantId })));
    ctx.subscriptions.emit(...invites.map(i => ctx.subscriptions.prepareInviteDeleted(i.conversation.conversationId, i.fromParticipantId, i.toParticipantId)));
    return invites.map(i => () => fireHook(ctx.handlers, "afterInviteDeleted", i.conversation.conversationId, i.fromParticipantId, i.toParticipantId));
}
