import { type Scope, encodeScope } from "../shared/protocol.js";
import { type Handlers, type ServerDispatch, getHandler } from "./server-types.js";
import type { Conversation, Invite, Message, ParticipantActivity } from "../shared/shared-types.js";
import type { IndicatorStore } from "./indicators-store.js";
import type { ServerContext } from "./context.js";
import { checkUpdateActivity } from "./services/getters.js";
import { logError } from "../shared/log.js";

// Descriptor for a single broadcast event - resolved into wire-shaped { scope, data } per recipient by emit
export type PreparedEvent = { scope: Scope, data: unknown, targets: string[] };

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
                const lastMessage = await getHandler(this.handlers, "readConversationLastMessageMetadata")(conversationId);
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

    // Group prepared events by recipient and dispatch one batch per participant
    // Multiple lists let callers atomically deliver related events (e.g. message + activity) so clients never see a half-state
    emit(...lists: PreparedEvent[][]): void {
        const perParticipant = new Map<string, { scope: string, data: unknown }[]>();
        for (const list of lists) {
            for (const prepared of list) {
                const encoded = encodeScope(prepared.scope);
                const subs = this.byScope.get(encoded);
                if (!subs || subs.size === 0) continue;
                for (const target of prepared.targets) {
                    if (!subs.has(target)) continue;
                    let pending = perParticipant.get(target);
                    if (!pending) { pending = []; perParticipant.set(target, pending); }
                    pending.push({ scope: encoded, data: prepared.data });
                }
            }
        }
        for (const [participantId, events] of perParticipant) {
            this.safeDispatch(participantId, { type: "events", events });
        }
    }

    // Prepare helpers ---------------------------------------

    prepareMessage(message: Message): PreparedEvent[] {
        const scope: Scope = { kind: "message", conversationId: message.conversationId };
        const subs = this.byScope.get(encodeScope(scope));
        const targets = subs ? [...subs] : [];
        // Synthesize a virtual activity update for each live message-scope subscriber (the real DB persist happens when unsubscribing from messages and in getMessages)
        const activityEvents = targets.flatMap(participantId => this.prepareParticipantActivity(participantId, {
            conversationId: message.conversationId,
            participantId,
            lastReadMessageId: message.messageId,
            lastReadMessageCreatedAt: message.createdAt,
        }));
        return [{ scope, data: message, targets }, ...activityEvents];
    }

    prepareIndicators(conversationId: string): PreparedEvent[] {
        const scope: Scope = { kind: "indicators", conversationId };
        const subs = this.byScope.get(encodeScope(scope));
        if (!subs?.size) return [];
        return [{ scope, data: this.indicators.list(conversationId), targets: [...subs] }];
    }

    prepareConversation(conversation: Conversation): PreparedEvent[] {
        return [{
            scope: { kind: "conversation" },
            data: { conversationId: conversation.conversationId, data: conversation },
            targets: conversation.participantIds,
        }];
    }

    prepareConversationDeleted(conversationId: string, formerParticipantIds: string[]): PreparedEvent[] {
        return [{
            scope: { kind: "conversation" },
            data: { conversationId, data: null },
            targets: formerParticipantIds,
        }];
    }

    prepareInvite(invite: Invite): PreparedEvent[] {
        return [{
            scope: { kind: "invite" },
            data: { conversationId: invite.conversation.conversationId, toParticipantId: invite.toParticipantId, data: invite },
            targets: [invite.fromParticipantId, invite.toParticipantId],
        }];
    }

    prepareInviteDeleted(conversationId: string, fromParticipantId: string, toParticipantId: string): PreparedEvent[] {
        return [{
            scope: { kind: "invite" },
            data: { conversationId, toParticipantId, data: null },
            targets: [fromParticipantId, toParticipantId],
        }];
    }

    prepareParticipantActivity(participantId: string, activity: ParticipantActivity): PreparedEvent[] {
        return [{
            scope: { kind: "participantActivity" },
            data: { conversationId: activity.conversationId, data: activity },
            targets: [participantId],
        }];
    }

    prepareParticipantActivityDeleted(participantId: string, conversationId: string): PreparedEvent[] {
        return [{
            scope: { kind: "participantActivity" },
            data: { conversationId, data: null },
            targets: [participantId],
        }];
    }

}
