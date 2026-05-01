import type { Alias, Conversation, Invite, Message, ParticipantActivity } from "../../shared/shared-types.js";
import { getHandler } from "../server-types.js";
import type { ServerContext, ServiceResult } from "../context.js";

export async function getConversations(ctx: ServerContext, participantId: string): Promise<ServiceResult<Conversation[]>> {
    return { result: await getHandler(ctx.handlers, "readConversations")(participantId), hooks: [] };
}

export async function getInvites(ctx: ServerContext, participantId: string): Promise<ServiceResult<Invite[]>> {
    return { result: await getHandler(ctx.handlers, "readInvites")(participantId), hooks: [] };
}

export async function getAliases(ctx: ServerContext, participantIds: string[]): Promise<ServiceResult<Alias[]>> {
    return { result: await getHandler(ctx.handlers, "readAliases")(participantIds), hooks: [] };
}

export async function getParticipantActivities(ctx: ServerContext, participantId: string): Promise<ServiceResult<ParticipantActivity[]>> {
    return { result: await getHandler(ctx.handlers, "readParticipantActivities")(participantId), hooks: [] };
}

export async function getMessages(
    ctx: ServerContext,
    participantId: string,
    conversationId: string,
    cursorMessageId: string | null,
    after: boolean,
    amount: number,
): Promise<ServiceResult<{ messages: Message[], remainingInDirection: number }>> {
    const result = await getHandler(ctx.handlers, "readMessages")(conversationId, cursorMessageId, after, amount);
    await checkUpdateActivity(ctx, conversationId, participantId, result.messages);
    return { result, hooks: [] };
}

// Update the participant's last-read pointer if any returned message is newer than the cached pointer
// Cache value 0 means no DB row yet, >0 means a row exists with that ts
async function checkUpdateActivity(ctx: ServerContext, conversationId: string, participantId: string, messages: Message[]): Promise<void> {
    if (messages.length === 0) return;

    // Find the newest message of the provided ones
    let newest: Message | null = null;
    for (const message of messages) {
        if (!newest || message.createdAt.getTime() > newest.createdAt.getTime()) newest = message;
    }
    if (!newest) return; // Only really needed for Typescript's not null checker, other than that redundant

    const cacheKey = `${conversationId}|${participantId}`;
    let cachedTs = ctx.activityCache.get(cacheKey);
    if (cachedTs === undefined) {
        const current = await getHandler(ctx.handlers, "readConversationParticipantActivity")(conversationId, participantId);
        cachedTs = current?.lastReadMessageCreatedAt?.getTime() ?? 0;
        ctx.activityCache.set(cacheKey, cachedTs);
    }

    const newestTs = newest.createdAt.getTime();
    if (newestTs <= cachedTs) return;

    const next: ParticipantActivity = {
        conversationId,
        participantId,
        lastReadMessageId: newest.messageId,
        lastReadMessageCreatedAt: newest.createdAt,
    };
    // Both create and update are guarded by a participation check on the consumer's side
    if (cachedTs === 0) await getHandler(ctx.handlers, "createConversationParticipantActivity")(next);
    else await getHandler(ctx.handlers, "updateConversationParticipantActivity")(next);
    ctx.activityCache.set(cacheKey, newestTs);
}
