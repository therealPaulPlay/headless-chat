import { getHandler } from "../server-types.js";
import type { ServerContext } from "../context.js";
import { leaveConversation } from "./conversations.js";

export async function deleteParticipant(ctx: ServerContext, participantId: string): Promise<void> {
    // Must be called AFTER the consumer has removed the user from their users table
    // Walk every conversation and leave every one
    const conversations = await getHandler(ctx.handlers, "readConversations")(participantId);
    for (const conversation of conversations) {
        try { await leaveConversation(ctx, participantId, conversation.conversationId); }
        catch (error) { console.error(`headless-chat failed to remove ${participantId} from ${conversation.conversationId}:`, error); }
    }

    // Delete all invites this participant has received
    const invites = await getHandler(ctx.handlers, "readInvites")(participantId);
    if (invites.length > 0) {
        await getHandler(ctx.handlers, "deleteInvites")(invites.map(invite => ({ conversationId: invite.conversation.conversationId, toParticipantId: invite.toParticipantId })));
        for (const invite of invites) {
            ctx.subscriptions.broadcastInviteDeleted(invite.conversation.conversationId, invite.fromParticipantId, invite.toParticipantId);
        }
    }
}