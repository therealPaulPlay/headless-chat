import type { Message, MessageOptions, Reaction, SystemEvent } from "../../shared/shared-types.js";
import { getHandler } from "../server-types.js";
import { type ServerContext, newId, now } from "../context.js";
import { applyProfanityChecks, isValidEmoji } from "../validation.js";
import { removeIndicator } from "./indicators.js";

function normalizeOptions(options: MessageOptions | undefined): MessageOptions {
    return {
        referenceMessageId: options?.referenceMessageId ?? null,
        isForwarded: Boolean(options?.isForwarded),
    };
}

// Persist a fresh message, fan out to message subscribers, and refresh the conversation summary
async function persistAndFanoutMessage(ctx: ServerContext, message: Message): Promise<void> {
    await getHandler(ctx.handlers, "createMessage")(message);
    ctx.subscriptions.broadcastMessage(message);
    const conversation = await getHandler(ctx.handlers, "readConversation")(message.conversationId);
    if (conversation) ctx.subscriptions.broadcastConversation(conversation);
}

function buildMessage(participantId: string, conversationId: string, text: string, options: MessageOptions, systemEvent: SystemEvent | null): Message {
    return {
        messageId: newId(),
        conversationId,
        message: text,
        messageOptions: normalizeOptions(options),
        participantId,
        reactions: [],
        deleted: false,
        systemEvent,
        createdAt: now(),
        modifiedAt: null,
    };
}

export async function sendMessage(ctx: ServerContext, participantId: string, conversationId: string, text: string, options: MessageOptions): Promise<string> {
    if (typeof text !== "string" || text.length === 0) throw new Error("Message must be a non-empty string");
    ctx.rateLimiter.trackMessage(participantId);
    const finalText = await applyProfanityChecks(ctx.handlers, text);

    // Clear the sender's indicator
    await removeIndicator(ctx, participantId, conversationId);

    const message = buildMessage(participantId, conversationId, finalText, options, null);
    await persistAndFanoutMessage(ctx, message);
    return message.messageId;
}

export async function editMessage(ctx: ServerContext, participantId: string, messageId: string, text: string, options: MessageOptions): Promise<void> {
    if (typeof text !== "string" || text.length === 0) throw new Error("Message must be a non-empty string");
    ctx.rateLimiter.trackMessage(participantId);
    const finalText = await applyProfanityChecks(ctx.handlers, text);

    const existing = await getHandler(ctx.handlers, "readMessage")(messageId);
    if (!existing) throw new Error("Message not found");
    if (existing.participantId !== participantId) throw new Error("Not authorized to edit this message");
    if (existing.deleted) throw new Error("Cannot edit deleted message");
    if (existing.systemEvent) throw new Error("Cannot edit a system message");

    const updated: Message = {
        ...existing,
        message: finalText,
        messageOptions: normalizeOptions(options),
        modifiedAt: now(),
    };
    await getHandler(ctx.handlers, "updateMessage")(updated);
    ctx.subscriptions.broadcastMessage(updated);
}

export async function deleteMessage(ctx: ServerContext, participantId: string, messageId: string): Promise<void> {
    const existing = await getHandler(ctx.handlers, "readMessage")(messageId);
    if (!existing) throw new Error("Message not found");
    if (existing.participantId !== participantId) throw new Error("Not authorized to delete this message");
    if (existing.deleted) return;

    // Keep the row so replies and pagination stay consisten
    const tombstoned: Message = { ...existing, deleted: true, modifiedAt: now() };
    await getHandler(ctx.handlers, "updateMessage")(tombstoned);
    ctx.subscriptions.broadcastMessage(tombstoned);
}

export async function addReaction(ctx: ServerContext, participantId: string, messageId: string, content: string): Promise<void> {
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
    // Consumer's onCreateReaction enforces participation and dedup on (messageId, participantId)
    await getHandler(ctx.handlers, "createReaction")(reaction);
    await ctx.subscriptions.broadcastMessageById(messageId);
}

export async function removeReaction(ctx: ServerContext, participantId: string, reactionId: string): Promise<void> {
    const reaction = await getHandler(ctx.handlers, "readReaction")(reactionId);
    if (!reaction) throw new Error("Reaction not found");
    if (reaction.participantId !== participantId) throw new Error("Not authorized to remove this reaction");
    await getHandler(ctx.handlers, "deleteReaction")(reactionId);
    await ctx.subscriptions.broadcastMessageById(reaction.messageId);
}

export async function addMessage(ctx: ServerContext, conversationId: string, participantId: string, text: string, options: MessageOptions, systemEvent?: SystemEvent): Promise<string> {
    // Server-side path, bypasses rate limit + profanity check
    const message = buildMessage(participantId, conversationId, text, options, systemEvent ?? null);
    await persistAndFanoutMessage(ctx, message);
    return message.messageId;
}
