import type { Message, MessageOptions, Reaction, SystemEvent } from "../../shared/shared-types.js";
import { getHandler } from "../server-types.js";
import { type ServerContext, type ServiceResult, fireHook, newId, now } from "../context.js";
import type { PreparedEvent } from "../subscriptions.js";
import { applyProfanityChecks, isValidEmoji } from "../validation.js";
import { removeIndicator } from "./indicators.js";
import { logError } from "../../shared/log.js";

function normalizeOptions(options: MessageOptions | undefined): MessageOptions {
    return {
        referenceMessageId: options?.referenceMessageId ?? null,
        isForwarded: Boolean(options?.isForwarded),
    };
}

// Persist a fresh message and prepare its broadcast events (message + refreshed conversation summary)
async function persistAndPrepareMessage(ctx: ServerContext, message: Message): Promise<PreparedEvent[][]> {
    await getHandler(ctx.handlers, "createMessage")(message);

    // Read-through cache, on miss fall back to a full DB read
    let conversation = ctx.conversationCache.get(message.conversationId);
    if (!conversation) {
        const fresh = await getHandler(ctx.handlers, "readConversation")(message.conversationId);
        if (!fresh) return []; // Conversation was deleted between the create and the broadcast, skip
        conversation = fresh;
    }

    // Patch the in-flight snapshot rather than re-reading - the only fields that change are lastMessage and lastActivityAt
    // Never regress lastMessage and lastActivityAt, prepended system messages must not pull it backwards
    if (message.createdAt.getTime() >= conversation.lastActivityAt.getTime()) {
        conversation.lastMessage = message;
        conversation.lastActivityAt = message.createdAt;
    }
    ctx.conversationCache.set(message.conversationId, conversation);

    return [ctx.subscriptions.prepareMessage(message, true), ctx.subscriptions.prepareConversation(conversation)];
}

export function buildMessage(participantId: string, conversationId: string, text: string, options: MessageOptions | undefined, systemEvent: SystemEvent | null, createdAt?: Date): Message {
    return {
        messageId: newId(),
        conversationId,
        message: text,
        messageOptions: normalizeOptions(options),
        participantId,
        reactions: [],
        deleted: false,
        systemEvent,
        createdAt: createdAt ?? now(),
        modifiedAt: null,
    };
}

// Client path
export async function sendMessage(ctx: ServerContext, participantId: string, conversationId: string, text: string, options?: MessageOptions): Promise<ServiceResult<string>> {
    if (typeof text !== "string" || text.length === 0) throw new Error("Message must be a non-empty string");
    ctx.rateLimiter.trackMessage(participantId);
    const finalText = await applyProfanityChecks(ctx.handlers, text);

    // Clear the sender's indicator
    await removeIndicator(ctx, participantId, conversationId);

    const message = buildMessage(participantId, conversationId, finalText, options, null);
    const events = await persistAndPrepareMessage(ctx, message);
    ctx.subscriptions.emit(...events);
    return { result: message.messageId, hooks: [() => fireHook(ctx.handlers, "afterMessageCreated", message)] };
}

export async function editMessage(ctx: ServerContext, participantId: string, messageId: string, text: string): Promise<ServiceResult<void>> {
    if (typeof text !== "string" || text.length === 0) throw new Error("Message must be a non-empty string");
    ctx.rateLimiter.trackMessage(participantId);
    const finalText = await applyProfanityChecks(ctx.handlers, text);

    const existing = await getHandler(ctx.handlers, "readMessage")(messageId);
    if (!existing) throw new Error("Message not found");
    if (existing.participantId !== participantId) throw new Error("Not authorized to edit this message");
    if (existing.deleted) throw new Error("Cannot edit deleted message");
    if (existing.systemEvent) throw new Error("Cannot edit a system message");

    // Options can only be set in send and are immutable across edits
    const updated: Message = {
        ...existing,
        message: finalText,
        modifiedAt: now(),
    };
    await getHandler(ctx.handlers, "updateMessage")(updated);
    // If the edited message is the conversation's lastMessage, the cached snapshot is stale, patch it and broadcast a refreshed conversation snapshot so onConversation subscribers see the updated preview
    const cached = ctx.conversationCache.get(updated.conversationId);
    const isLast = cached?.lastMessage?.messageId === updated.messageId;
    if (cached && isLast) {
        cached.lastMessage = updated;
        ctx.conversationCache.set(updated.conversationId, cached);
    }
    ctx.subscriptions.emit(
        ctx.subscriptions.prepareMessage(updated, false),
        ...(cached && isLast ? [ctx.subscriptions.prepareConversation(cached)] : []),
    );
    return { result: undefined, hooks: [] };
}

export async function deleteMessage(ctx: ServerContext, participantId: string, messageId: string): Promise<ServiceResult<void>> {
    const existing = await getHandler(ctx.handlers, "readMessage")(messageId);
    if (!existing) throw new Error("Message not found");
    if (existing.participantId !== participantId) throw new Error("Not authorized to delete this message");
    if (existing.deleted) return { result: undefined, hooks: [] };

    // Keep the row so replies and pagination stay consistent
    const tombstoned: Message = { ...existing, deleted: true, modifiedAt: now() };
    await getHandler(ctx.handlers, "updateMessage")(tombstoned);
    // If the tombstoned message is the conversation's lastMessage, the cached snapshot is stale, patch it and broadcast a refreshed conversation snapshot so onConversation subscribers see the tombstone
    const cached = ctx.conversationCache.get(tombstoned.conversationId);
    const isLast = cached?.lastMessage?.messageId === tombstoned.messageId;
    if (cached && isLast) {
        cached.lastMessage = tombstoned;
        ctx.conversationCache.set(tombstoned.conversationId, cached);
    }
    ctx.subscriptions.emit(
        ctx.subscriptions.prepareMessage(tombstoned, false),
        ...(cached && isLast ? [ctx.subscriptions.prepareConversation(cached)] : []),
    );
    return { result: undefined, hooks: [() => fireHook(ctx.handlers, "afterMessageDeleted", tombstoned)] };
}

export async function addReaction(ctx: ServerContext, participantId: string, messageId: string, content: string): Promise<ServiceResult<string>> {
    if (!isValidEmoji(content)) throw new Error("Reaction must be a valid unicode emoji");
    const existing = await getHandler(ctx.handlers, "readMessage")(messageId);
    if (!existing) throw new Error("Message not found");

    const reaction: Reaction = {
        reactionId: newId(),
        messageId,
        participantId,
        content,
        createdAt: now(),
    };
    // Consumer's onCreateReaction enforces participation and one-reaction-per-(messageId, participantId), the new reaction replaces any prior one
    await getHandler(ctx.handlers, "createReaction")(reaction);

    // Mirror the consumer's replace-on-(messageId, participantId) semantics so the broadcast and the cache stay consistent
    const updated: Message = { ...existing, reactions: [...existing.reactions.filter(r => r.participantId !== participantId), reaction] };

    const cached = ctx.conversationCache.get(existing.conversationId);
    const isLast = cached?.lastMessage?.messageId === messageId;
    if (cached && isLast) {
        cached.lastMessage = updated;
        ctx.conversationCache.set(existing.conversationId, cached);
    }
    // Emit the locally constructed updated message rather than re-reading it. If the reaction landed on the lastMessage also broadcast a refreshed conversation snapshot so onConversation subscribers see the new reaction in the preview
    ctx.subscriptions.emit(
        ctx.subscriptions.prepareMessage(updated, false),
        ...(cached && isLast ? [ctx.subscriptions.prepareConversation(cached)] : []),
    );
    return { result: reaction.reactionId, hooks: [] };
}

export async function removeReaction(ctx: ServerContext, participantId: string, reactionId: string): Promise<ServiceResult<void>> {
    const reaction = await getHandler(ctx.handlers, "readReaction")(reactionId);
    if (!reaction) throw new Error("Reaction not found");
    if (reaction.participantId !== participantId) throw new Error("Not authorized to remove this reaction");
    await getHandler(ctx.handlers, "deleteReaction")(reactionId);

    // Patch the cached snapshot if the reaction's message is the conversation's lastMessage, broadcast both the patched message and a refreshed conversation snapshot
    const conversationId = ctx.conversationCache.findKey(c => c.lastMessage?.messageId === reaction.messageId);
    if (conversationId) {
        const cached = ctx.conversationCache.get(conversationId)!;
        const patched: Message = { ...cached.lastMessage!, reactions: cached.lastMessage!.reactions.filter(r => r.reactionId !== reactionId) };
        cached.lastMessage = patched;
        ctx.conversationCache.set(conversationId, cached);
        ctx.subscriptions.emit(
            ctx.subscriptions.prepareMessage(patched, false),
            ctx.subscriptions.prepareConversation(cached),
        );
        return { result: undefined, hooks: [] };
    }

    // Fallback for reactions on older (non-cached) messages: re-read so subscribers see the post-removal state
    try {
        const message = await getHandler(ctx.handlers, "readMessage")(reaction.messageId);
        if (message) ctx.subscriptions.emit(ctx.subscriptions.prepareMessage(message, false));
    } catch (error) { logError("readMessage", error); }
    return { result: undefined, hooks: [] };
}

// Server-side path, bypasses rate limit + profanity check, returns events for the caller to bundle or emit
// createdAt override is for backdated system messages
export async function internalSendMessage(ctx: ServerContext, conversationId: string, participantId: string, text: string, options?: MessageOptions, systemEvent?: SystemEvent, createdAt?: Date): Promise<ServiceResult<string> & { events: PreparedEvent[][] }> {
    const message = buildMessage(participantId, conversationId, text, options, systemEvent ?? null, createdAt);
    const events = await persistAndPrepareMessage(ctx, message);
    return { result: message.messageId, hooks: [() => fireHook(ctx.handlers, "afterMessageCreated", message)], events };
}
