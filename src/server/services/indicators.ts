import { getHandler } from "../server-types.js";
import { type ServerContext, type ServiceResult, now } from "../context.js";

export async function setIndicator(ctx: ServerContext, participantId: string, conversationId: string): Promise<ServiceResult<void>> {
    // Participation gate, indicators only live for participants of the conversation
    const conversation = await getHandler(ctx.handlers, "readConversation")(conversationId);
    if (!conversation || !conversation.participants.includes(participantId)) throw new Error("Not a participant of this conversation");

    ctx.indicators.set(conversationId, participantId, now());
    ctx.subscriptions.broadcastIndicators(conversationId);
    return { result: undefined, hooks: [] };
}

export async function removeIndicator(ctx: ServerContext, participantId: string, conversationId: string): Promise<ServiceResult<void>> {
    ctx.indicators.delete(conversationId, participantId);
    ctx.subscriptions.broadcastIndicators(conversationId);
    return { result: undefined, hooks: [] };
}
