import { SCOPE } from "../shared/protocol.js";
import { type Handlers, type ServerDispatch, getHandler } from "./server-types.js";
import type { Conversation, Invite, Message } from "../shared/shared-types.js";
import type { IndicatorStore } from "./indicators-store.js";
import { logError } from "../shared/log.js";

export class Subscriptions {
    private byScope = new Map<string, Set<string>>();
    private byParticipant = new Map<string, Set<string>>();

    constructor(
        private dispatch: ServerDispatch,
        private handlers: Handlers,
        private indicators: IndicatorStore,
    ) { }

    // Add a participant to a specific scope
    add(participantId: string, scope: string): boolean {
        // Check if already subscribed
        const scopeSet = this.byScope.get(scope);
        if (scopeSet?.has(participantId)) return false;

        // Enable lookup by scope, and create set if necessary)
        if (scopeSet) scopeSet.add(participantId);
        else this.byScope.set(scope, new Set([participantId]));

        // Also enable lookup by participant ID
        const participantScopes = this.byParticipant.get(participantId);
        if (participantScopes) participantScopes.add(scope);
        else this.byParticipant.set(participantId, new Set([scope]));

        return true;
    }

    // Remove a participant from a specific scope
    remove(participantId: string, scope: string): void {
        // Delete from byScope
        const scopeSet = this.byScope.get(scope);
        if (scopeSet) {
            scopeSet.delete(participantId);
            if (scopeSet.size === 0) this.byScope.delete(scope);
        }

        // Delete from byParticipant
        const participantScopes = this.byParticipant.get(participantId);
        if (participantScopes) {
            participantScopes.delete(scope);
            if (participantScopes.size === 0) this.byParticipant.delete(participantId);
        }
    }

    // Remove a participant from all scopes (unsubscribe from everything)
    removeAllFor(participantId: string): void {
        const scopes = this.byParticipant.get(participantId);
        if (!scopes) return;
        for (const scope of [...scopes]) this.remove(participantId, scope);
    }

    // Wraps the consumer-supplied dispatch so a thrown transport never propagates into the library
    private safeDispatch(participantId: string, payload: unknown): void {
        try { this.dispatch(participantId, payload); }
        catch (error) { logError("dispatch", error); }
    }

    sendResponse(participantId: string, requestId: string, ok: boolean, data: unknown, error?: string): void {
        this.safeDispatch(participantId, { type: "response", requestId, ok, data, error });
    }

    // Targets is an optional iterator of participant IDs, if ommited, it will be distributed to all participants with the scope
    private emit(scope: string, data: unknown, targets?: Iterable<string>): void {
        const subs = this.byScope.get(scope);
        if (!subs || subs.size === 0) return;

        const event = { type: "event", scope, data };
        if (targets) {
            for (const participantId of targets) {
                if (subs.has(participantId)) this.safeDispatch(participantId, event);
            }
        } else {
            for (const participantId of subs) this.safeDispatch(participantId, event);
        }
    }

    broadcastMessage(message: Message): void {
        this.emit(SCOPE.message(message.conversationId), message);
    }

    async broadcastMessageById(messageId: string): Promise<void> {
        try {
            const message = await getHandler(this.handlers, "readMessage")(messageId);
            if (message) this.broadcastMessage(message);
        } catch (error) { logError("readMessage", error); }
    }

    broadcastIndicators(conversationId: string): void {
        const scope = SCOPE.indicators(conversationId);
        if (!this.byScope.get(scope)?.size) return;
        this.emit(scope, this.indicators.list(conversationId));
    }

    broadcastConversation(conversation: Conversation): void {
        this.emit(SCOPE.conversation(), { conversationId: conversation.conversationId, data: conversation }, conversation.participants);
    }

    broadcastConversationDeleted(conversationId: string, formerParticipants: string[]): void {
        this.emit(SCOPE.conversation(), { conversationId, data: null }, formerParticipants);
    }

    broadcastInvite(invite: Invite): void {
        this.emit(SCOPE.invite(), { conversationId: invite.conversation.conversationId, toParticipantId: invite.toParticipantId, data: invite }, [invite.fromParticipantId, invite.toParticipantId]);
    }

    broadcastInviteDeleted(conversationId: string, fromParticipantId: string, toParticipantId: string): void {
        this.emit(SCOPE.invite(), { conversationId, toParticipantId, data: null }, [fromParticipantId, toParticipantId]);
    }
}