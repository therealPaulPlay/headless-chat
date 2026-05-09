import type { Alias, Conversation, Invite, Message, ParticipantActivity } from "../../shared/shared-types.js";
import { getHandler } from "../server-types.js";
import type { ServerContext, ServiceResult } from "../context.js";

export async function getConversations(ctx: ServerContext, participantId: string): Promise<ServiceResult<Conversation[]>> {
    const result = await getHandler(ctx.handlers, "readConversations")(participantId);
    // Warm the cache so subsequent per-conversation reads avoid the heavy join
    for (const conversation of result) ctx.conversationCache.set(conversation.conversationId, conversation);
    return { result, hooks: [] };
}

export async function getInvites(ctx: ServerContext, participantId: string): Promise<ServiceResult<Invite[]>> {
    return { result: await getHandler(ctx.handlers, "readInvitesInvolvingParticipant")(participantId), hooks: [] };
}

export async function getAliases(ctx: ServerContext, participantIds: string[]): Promise<ServiceResult<Alias[]>> {
    return { result: await getHandler(ctx.handlers, "readAliases")(participantIds), hooks: [] };
}

export async function getParticipantActivities(ctx: ServerContext, participantId: string): Promise<ServiceResult<ParticipantActivity[]>> {
    const result = await getHandler(ctx.handlers, "readParticipantActivities")(participantId);
    // Populate or update the activity cache
    for (const activity of result) {
        ctx.activityCache.set(`${activity.conversationId}|${participantId}`, activity.lastReadMessageCreatedAt.getTime());
    }
    return { result, hooks: [] };
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

export async function getMessagesByIds(ctx: ServerContext, messageIds: string[]): Promise<ServiceResult<Message[]>> {
    if (messageIds.length === 0) return { result: [], hooks: [] };
    const result = await getHandler(ctx.handlers, "readMessagesByIds")(messageIds);
    return { result, hooks: [] };
}

export async function getHasNew(ctx: ServerContext, participantId: string): Promise<ServiceResult<{ hasNewMessages: boolean, hasNewInvites: boolean }>> {
    const result = await getHandler(ctx.handlers, "readHasNew")(participantId);
    return { result, hooks: [] };
}

// Update the participant's last-read message if any of the provided messages is newer than the cached one
export async function checkUpdateActivity(ctx: ServerContext, conversationId: string, participantId: string, messages: { messageId: string, createdAt: Date }[]): Promise<void> {
    if (messages.length === 0) return;

    // Find the latest message of the provided ones
    let latestMessage: { messageId: string, createdAt: Date } | null = null;
    for (const message of messages) {
        if (!latestMessage || message.createdAt.getTime() > latestMessage.createdAt.getTime()) latestMessage = message;
    }
    if (!latestMessage) return; // Only really needed for Typescript's not null checker, other than that redundant

    const cacheKey = `${conversationId}|${participantId}`;
    let cachedReadTs = ctx.activityCache.get(cacheKey);
    if (cachedReadTs === undefined) {
        const stored = await getHandler(ctx.handlers, "readConversationParticipantActivity")(conversationId, participantId);
        cachedReadTs = stored?.lastReadMessageCreatedAt?.getTime() ?? 0;
        ctx.activityCache.set(cacheKey, cachedReadTs);
    }

    const latestMessageTs = latestMessage.createdAt.getTime();
    if (latestMessageTs <= cachedReadTs) return;

    const updatedActivity: ParticipantActivity = {
        conversationId,
        participantId,
        lastReadMessageId: latestMessage.messageId,
        lastReadMessageCreatedAt: latestMessage.createdAt,
    };
    // Both create and update are guarded by a participation check on the consumer's side
    if (cachedReadTs === 0) await getHandler(ctx.handlers, "createConversationParticipantActivity")(updatedActivity);
    else await getHandler(ctx.handlers, "updateConversationParticipantActivity")(updatedActivity);
    ctx.activityCache.set(cacheKey, latestMessageTs);
    ctx.subscriptions.emit(ctx.subscriptions.prepareParticipantActivity(participantId, updatedActivity));
}
