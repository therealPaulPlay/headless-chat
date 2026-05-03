import { type Scope, encodeScope } from "../shared/protocol.js";
import { type Handlers, type ServerDispatch, getHandler } from "./server-types.js";
import type { Conversation, Invite, Message, ParticipantActivity } from "../shared/shared-types.js";
import type { IndicatorStore } from "./indicators-store.js";
import type { ServerContext } from "./context.js";
import { checkUpdateActivity } from "./services/getters.js";
import { logError } from "../shared/log.js";

export class Subscriptions {
    // Map keys are encoded scope strings since Map needs primitive keys, the public API speaks in Scope objects
    private byScope = new Map<string, Set<string>>();
    private byParticipant = new Map<string, Set<Scope>>();

    // Injected by Server after construction since ctx references subscriptions back
    private ctx!: ServerContext;

    constructor(
        private dispatch: ServerDispatch,
        private handlers: Handlers,
        private indicators: IndicatorStore,
    ) { }

    setContext(ctx: ServerContext): void { this.ctx = ctx; }

    // Add a participant to a specific scope
    add(participantId: string, scope: Scope): boolean {
        const encoded = encodeScope(scope);

        // Check if already subscribed
        const scopeSet = this.byScope.get(encoded);
        if (scopeSet?.has(participantId)) return false;

        // Enable lookup by scope, and create set if necessary
        if (scopeSet) scopeSet.add(participantId);
        else this.byScope.set(encoded, new Set([participantId]));

        // Also enable lookup by participant ID
        const participantScopes = this.byParticipant.get(participantId);
        if (participantScopes) participantScopes.add(scope);
        else this.byParticipant.set(participantId, new Set([scope]));

        return true;
    }

    // Remove a participant from a specific scope
    remove(participantId: string, scope: Scope): void {
        const encoded = encodeScope(scope);

        // Delete from byScope
        const scopeSet = this.byScope.get(encoded);
        if (scopeSet) {
            scopeSet.delete(participantId);
            if (scopeSet.size === 0) this.byScope.delete(encoded);
        }

        // Delete from byParticipant - the Set holds Scope objects, callers pass a fresh one so a linear lookup by encoded equality is needed
        const participantScopes = this.byParticipant.get(participantId);
        if (participantScopes) {
            for (const stored of participantScopes) {
                if (encodeScope(stored) === encoded) { participantScopes.delete(stored); break; }
            }
            if (participantScopes.size === 0) this.byParticipant.delete(participantId);
        }

        // Update participant activity to last message read over the subscription
        if (scope.kind === "message") {
            const conversationId = scope.conversationId;
            (async () => {
                const lastMessage = await getHandler(this.handlers, "readConversationLastMessage")(conversationId);
                if (!lastMessage) return; // Empty conversation, exit
                await checkUpdateActivity(this.ctx, conversationId, participantId, [lastMessage]);
            })().catch(error => logError("markConversationRead", error));
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
    private emit(scope: Scope, data: unknown, targets?: Iterable<string>): void {
        const encoded = encodeScope(scope);
        const subs = this.byScope.get(encoded);
        if (!subs || subs.size === 0) return;

        const event = { type: "event", scope: encoded, data };
        if (targets) {
            for (const participantId of targets) {
                if (subs.has(participantId)) this.safeDispatch(participantId, event);
            }
        } else {
            for (const participantId of subs) this.safeDispatch(participantId, event);
        }
    }

    broadcastMessage(message: Message): void {
        this.emit({ kind: "message", conversationId: message.conversationId }, message);

        // Synthesize a virtual activity update for each live message-scope subscriber (the real DB persist happens when ubsubscribing from messages and in getMessages)
        const messageSubs = this.byScope.get(encodeScope({ kind: "message", conversationId: message.conversationId }));
        if (!messageSubs) return;
        for (const participantId of messageSubs) {
            this.broadcastParticipantActivity({
                conversationId: message.conversationId,
                participantId,
                lastReadMessageId: message.messageId,
                lastReadMessageCreatedAt: message.createdAt,
            });
        }
    }

    broadcastParticipantActivity(activity: ParticipantActivity): void {
        this.emit({ kind: "participantActivity" }, activity, [activity.participantId]);
    }

    async broadcastMessageById(messageId: string): Promise<void> {
        try {
            const message = await getHandler(this.handlers, "readMessage")(messageId);
            if (message) this.broadcastMessage(message);
        } catch (error) { logError("readMessage", error); }
    }

    broadcastIndicators(conversationId: string): void {
        const scope: Scope = { kind: "indicators", conversationId };
        if (!this.byScope.get(encodeScope(scope))?.size) return;
        this.emit(scope, this.indicators.list(conversationId));
    }

    broadcastConversation(conversation: Conversation): void {
        this.emit({ kind: "conversation" }, { conversationId: conversation.conversationId, data: conversation }, conversation.participants);
    }

    broadcastConversationDeleted(conversationId: string, formerParticipants: string[]): void {
        this.emit({ kind: "conversation" }, { conversationId, data: null }, formerParticipants);
    }

    broadcastInvite(invite: Invite): void {
        this.emit({ kind: "invite" }, { conversationId: invite.conversation.conversationId, toParticipantId: invite.toParticipantId, data: invite }, [invite.fromParticipantId, invite.toParticipantId]);
    }

    broadcastInviteDeleted(conversationId: string, fromParticipantId: string, toParticipantId: string): void {
        this.emit({ kind: "invite" }, { conversationId, toParticipantId, data: null }, [fromParticipantId, toParticipantId]);
    }
}
