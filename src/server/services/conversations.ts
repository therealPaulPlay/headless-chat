import type { Conversation, ConversationRecord, Invite } from "../../shared/shared-types.js";
import { getHandler } from "../server-types.js";
import { type AfterHook, type ServerContext, type ServiceResult, fireHook, newId, now } from "../context.js";
import type { PreparedEvent } from "../subscriptions.js";
import { effectiveMaxParticipants } from "../validation.js";
import { internalSendMessage } from "./messages.js";
import { logError } from "../../shared/log.js";

// Read-through cache lookup, on miss falls back to the readConversation handler and warms the cache
export async function readConversationCached(ctx: ServerContext, conversationId: string): Promise<Conversation | null> {
    const cached = ctx.conversationCache.get(conversationId);
    if (cached) return cached;
    const fresh = await getHandler(ctx.handlers, "readConversation")(conversationId);
    if (fresh) ctx.conversationCache.set(conversationId, fresh);
    return fresh;
}

// Emits side-effects for an already-deleted conversation, broadcasts now and returns hooks to fire later
// Use when the rows have already been removed
export function emitConversationDeleted(ctx: ServerContext, conversationId: string, formerParticipantIds: string[], deletedInvites: { fromParticipantId: string, toParticipantId: string }[]): AfterHook[] {
    // Bundle the conversation deletion with all invite deletions so subscribers see them atomically
    ctx.subscriptions.emit(
        ctx.subscriptions.prepareConversationDeleted(conversationId, formerParticipantIds),
        ...deletedInvites.map(invite => ctx.subscriptions.prepareInviteDeleted(conversationId, invite.fromParticipantId, invite.toParticipantId)),
    );
    const hooks: AfterHook[] = [() => fireHook(ctx.handlers, "afterConversationDeleted", conversationId)];
    for (const invite of deletedInvites) {
        hooks.push(() => fireHook(ctx.handlers, "afterInviteDeleted", conversationId, invite.fromParticipantId, invite.toParticipantId));
    }
    return hooks;
}

export async function createConversation(ctx: ServerContext, participantId: string, maxSize?: number): Promise<ServiceResult<string>> {
    const conversationId = newId();
    const record: ConversationRecord = {
        conversationId,
        createdAt: now(),
        lastActivityAt: now(),
        maxSize: maxSize ?? null, // Stored as-is, the global cap is re-applied at every join check
    };
    // Consumer must atomically insert the conversation row and the creator's participant seat, throwing if the creator is at the per-participant cap
    await getHandler(ctx.handlers, "createConversation")(record, participantId, ctx.rateLimits.conversationLimitPerParticipant);
    const surfaced: Conversation = { ...record, participantIds: [participantId], lastMessage: null };
    ctx.conversationCache.set(conversationId, surfaced);
    ctx.subscriptions.emit(ctx.subscriptions.prepareConversation(surfaced));
    return { result: conversationId, hooks: [() => fireHook(ctx.handlers, "afterConversationCreated", surfaced)] };
}

export async function createInvite(ctx: ServerContext, fromParticipantId: string, conversationId: string, toParticipantId: string): Promise<ServiceResult<void>> {
    ctx.rateLimiter.trackInvite(fromParticipantId);
    return createInviteAdmin(ctx, fromParticipantId, conversationId, toParticipantId);
}

// Admin-friendly variant, no rate limit
export async function createInviteAdmin(ctx: ServerContext, fromParticipantId: string, conversationId: string, toParticipantId: string): Promise<ServiceResult<void>> {
    if (fromParticipantId === toParticipantId) throw new Error("Cannot invite yourself");

    const conversation = await readConversationCached(ctx, conversationId);
    if (!conversation) throw new Error("Conversation not found");
    if (!conversation.participantIds.includes(fromParticipantId)) throw new Error("Not a participant of this conversation");

    // Capacity check is best-effort, accept-invite enforces it atomically
    const max = effectiveMaxParticipants(conversation.maxSize, ctx.rateLimits.conversationParticipantLimit);
    if (conversation.participantIds.length >= max) throw new Error("Conversation is full");

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
    // Handler dedupes on the triple, throws if recipient is already a participant, returns inserted: false on a dedup no-op so we skip the broadcast + hook
    const { inserted } = await getHandler(ctx.handlers, "createInvite")(invite);
    if (!inserted) return { result: undefined, hooks: [] };
    ctx.subscriptions.emit(ctx.subscriptions.prepareInvite(invite));
    return { result: undefined, hooks: [() => fireHook(ctx.handlers, "afterInviteCreated", invite)] };
}

export async function revokeInvite(ctx: ServerContext, participantId: string, conversationId: string, toParticipantId: string): Promise<ServiceResult<void>> {
    // Check first - we shouldn't inform the inviter about a deletion that never happened
    const invite = await getHandler(ctx.handlers, "readInvite")(conversationId, participantId, toParticipantId);
    if (!invite) throw new Error("Invite not found");
    return revokeInviteByPair(ctx, conversationId, participantId, toParticipantId);
}

// Admin-friendly variant
export async function revokeInviteByPair(ctx: ServerContext, conversationId: string, fromParticipantId: string, toParticipantId: string): Promise<ServiceResult<void>> {
    await getHandler(ctx.handlers, "deleteInvites")([{ conversationId, fromParticipantId, toParticipantId }]);
    ctx.subscriptions.emit(ctx.subscriptions.prepareInviteDeleted(conversationId, fromParticipantId, toParticipantId));
    return { result: undefined, hooks: [() => fireHook(ctx.handlers, "afterInviteDeleted", conversationId, fromParticipantId, toParticipantId)] };
}

// Adds the participant atomically, posts the join system message, returns hooks and prepared events for the caller to bundle and emit
async function joinFlow(ctx: ServerContext, conversationId: string, participantId: string, conversation: Conversation): Promise<{ hooks: AfterHook[], events: PreparedEvent[][] }> {
    const max = effectiveMaxParticipants(conversation.maxSize, ctx.rateLimits.conversationParticipantLimit);
    await getHandler(ctx.handlers, "addConversationParticipant")(conversationId, participantId, max, ctx.rateLimits.conversationLimitPerParticipant);
    // Patch the cached snapshot
    const cached = ctx.conversationCache.get(conversationId);
    if (cached && !cached.participantIds.includes(participantId)) {
        ctx.conversationCache.set(conversationId, { ...cached, participantIds: [...cached.participantIds, participantId] });
    }
    // System messages are authored by the reserved "server" participant, the joining participant id is carried in systemEvent
    const sysMsg = await internalSendMessage(ctx, conversationId, "server", "", { referenceMessageId: null, isForwarded: false }, { type: "participantJoined", participantId });
    return {
        hooks: [() => fireHook(ctx.handlers, "afterParticipantJoined", conversationId, participantId), ...sysMsg.hooks],
        events: sysMsg.events,
    };
}

export async function acceptInvite(ctx: ServerContext, participantId: string, conversationId: string): Promise<ServiceResult<void>> {
    const conversation = await readConversationCached(ctx, conversationId);
    if (!conversation) throw new Error("Conversation not found");

    // Fetch only the invites for this participant in this conversation, possibly multiple if several senders invited them
    const matching = await getHandler(ctx.handlers, "readInvitesForRecipient")(conversationId, participantId);

    const hooks: AfterHook[] = [];
    const eventLists: PreparedEvent[][] = [];
    if (!conversation.participantIds.includes(participantId)) {
        const joinResult = await joinFlow(ctx, conversationId, participantId, conversation);
        hooks.push(...joinResult.hooks);
        eventLists.push(...joinResult.events);
    }

    if (matching.length > 0) {
        await getHandler(ctx.handlers, "deleteInvites")(matching.map(invite => ({ conversationId, fromParticipantId: invite.fromParticipantId, toParticipantId: participantId })));
        for (const invite of matching) {
            hooks.push(() => fireHook(ctx.handlers, "afterInviteDeleted", conversationId, invite.fromParticipantId, participantId));
            eventLists.push(ctx.subscriptions.prepareInviteDeleted(conversationId, invite.fromParticipantId, participantId));
        }
    }

    ctx.subscriptions.emit(...eventLists);

    return { result: undefined, hooks };
}

// Admin-only direct add, no invite required
export async function joinConversation(ctx: ServerContext, conversationId: string, participantId: string): Promise<ServiceResult<void>> {
    const conversation = await readConversationCached(ctx, conversationId);
    if (!conversation) throw new Error("Conversation not found");

    const hooks: AfterHook[] = [];
    const eventLists: PreparedEvent[][] = [];
    if (!conversation.participantIds.includes(participantId)) {
        const joinResult = await joinFlow(ctx, conversationId, participantId, conversation);
        hooks.push(...joinResult.hooks);
        eventLists.push(...joinResult.events);
    }

    ctx.subscriptions.emit(...eventLists);

    return { result: undefined, hooks };
}

export async function declineInvite(ctx: ServerContext, participantId: string, conversationId: string): Promise<ServiceResult<void>> {
    const matching = await getHandler(ctx.handlers, "readInvitesForRecipient")(conversationId, participantId);
    if (matching.length === 0) return { result: undefined, hooks: [] };
    await getHandler(ctx.handlers, "deleteInvites")(matching.map(invite => ({ conversationId, fromParticipantId: invite.fromParticipantId, toParticipantId: participantId })));
    // Bundle all invite deletions so subscribers see them as one update
    ctx.subscriptions.emit(...matching.map(invite => ctx.subscriptions.prepareInviteDeleted(conversationId, invite.fromParticipantId, participantId)));
    const hooks: AfterHook[] = matching.map(invite => () => fireHook(ctx.handlers, "afterInviteDeleted", conversationId, invite.fromParticipantId, participantId));
    return { result: undefined, hooks };
}

export async function leaveConversation(ctx: ServerContext, participantId: string, conversationId: string): Promise<ServiceResult<void>> {
    const conversation = await readConversationCached(ctx, conversationId);
    if (!conversation) throw new Error("Conversation not found");
    if (!conversation.participantIds.includes(participantId)) throw new Error("Not a participant of this conversation");

    if (conversation.participantIds.length === 1) {
        // Delete conversation if now empty
        const { deletedInvites } = await getHandler(ctx.handlers, "deleteConversationWithMessagesReactionsInvitesAndActivities")(conversationId);
        for (const pid of conversation.participantIds) ctx.activityCache.invalidate(`${conversationId}|${pid}`);
        ctx.conversationCache.invalidate(conversationId);
        const deleteHooks = emitConversationDeleted(ctx, conversationId, conversation.participantIds, deletedInvites);
        // Signal activity removal to every former participant subscribed to onParticipantActivity
        ctx.subscriptions.emit(...conversation.participantIds.map(pid => ctx.subscriptions.prepareParticipantActivityDeleted(pid, conversationId)));
        return {
            result: undefined,
            hooks: [() => fireHook(ctx.handlers, "afterParticipantLeft", conversationId, participantId), ...deleteHooks],
        };
    }

    // Remove first so the system message and the conversation refresh both reflect the post-leave state
    await getHandler(ctx.handlers, "removeConversationParticipantAndDeleteParticipantActivity")(conversationId, participantId);
    ctx.activityCache.invalidate(`${conversationId}|${participantId}`);
    ctx.conversationCache.invalidate(conversationId);
    // System messages are authored by the reserved "server" participant, the leaving participant id is carried in systemEvent
    const sysMsg = await internalSendMessage(ctx, conversationId, "server", "", { referenceMessageId: null, isForwarded: false }, { type: "participantLeft", participantId });

    // sysMsg.events already carries the refreshed Conversation snapshot (targeted at remaining participants)
    // Recipient sets are disjoint - the leaver is no longer in participants, so the leaver only gets the deleted event
    ctx.subscriptions.emit(
        ctx.subscriptions.prepareConversationDeleted(conversationId, [participantId]),
        ctx.subscriptions.prepareParticipantActivityDeleted(participantId, conversationId),
        ...sysMsg.events,
    );

    return {
        result: undefined,
        hooks: [...sysMsg.hooks, () => fireHook(ctx.handlers, "afterParticipantLeft", conversationId, participantId)],
    };
}
