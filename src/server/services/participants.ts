import { getHandler } from "../server-types.js";
import { type AfterHook, type ServerContext, type ServiceResult, fireHook } from "../context.js";
import { logError } from "../../shared/log.js";
import { leaveConversation } from "./conversations.js";

export async function deleteParticipant(ctx: ServerContext, participantId: string): Promise<ServiceResult<void>> {
    // Must be called AFTER the consumer has removed the user from their users table
    // Walk every conversation and leave every one
    const hooks: AfterHook[] = [];
    const conversations = await getHandler(ctx.handlers, "readConversations")(participantId);
    for (const conversation of conversations) {
        try {
            const sub = await leaveConversation(ctx, participantId, conversation.conversationId);
            hooks.push(...sub.hooks);
        } catch (error) {
            logError(`leaveConversation (${participantId}, ${conversation.conversationId})`, error);
        }
    }

    // Delete all invites this participant has received
    const invites = await getHandler(ctx.handlers, "readInvites")(participantId);
    if (invites.length > 0) {
        await getHandler(ctx.handlers, "deleteInvites")(invites.map(invite => ({ conversationId: invite.conversation.conversationId, toParticipantId: invite.toParticipantId })));
        for (const invite of invites) {
            ctx.subscriptions.broadcastInviteDeleted(invite.conversation.conversationId, invite.fromParticipantId, invite.toParticipantId);
            hooks.push(() => fireHook(ctx.handlers, "afterInviteDeleted", invite.conversation.conversationId, invite.fromParticipantId, invite.toParticipantId));
        }
    }

    return { result: undefined, hooks };
}
