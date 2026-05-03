import { type ServerToClient, encodeScope } from "../shared/protocol.js";
import type { Conversation, Invite, Message, MessageOptions, Indicator, Alias, ParticipantActivity } from "../shared/shared-types.js";

export type { Conversation, Message, MessageOptions, Indicator, Invite, ParticipantActivity, Alias } from "../shared/shared-types.js";

export type ClientDispatch = (data: unknown) => void;
export type GetAuthData = () => unknown | Promise<unknown>;

type AnyHandler = (...args: unknown[]) => void;

type ConversationEvent = { conversationId: string, data: Conversation | null };
type InviteEvent = { conversationId: string, toParticipantId: string, data: Invite | null };

export class Client {
    private dispatch: ClientDispatch;
    private participantId: string;
    private getAuthData: GetAuthData;

    private nextRequestId = 1;
    private pending = new Map<string, { resolve: (value: unknown) => void, reject: (reason: unknown) => void }>();

    private scopeHandlers = new Map<string, Set<AnyHandler>>();
    private handlerScope = new Map<AnyHandler, string>();

    constructor(dispatch: ClientDispatch, participantId: string, getAuthData: GetAuthData) {
        this.dispatch = dispatch;
        this.participantId = participantId;
        this.getAuthData = getAuthData;
    }

    // Reject in-flight RPCs and clear handler tracking, call when discarding the instance
    dispose(): void {
        for (const { reject } of this.pending.values()) reject(new Error("Client disposed"));
        this.pending.clear();
        this.scopeHandlers.clear();
        this.handlerScope.clear();
    }

    // Transport ----------------------------------------------------------

    receive(data: unknown): void {
        if (!data || typeof data !== "object") return;
        const message = data as ServerToClient;

        // Responses to the requests from the player
        if (message.type === "response") {
            const pending = this.pending.get(message.requestId);
            if (!pending) return; // Not a response we are waiting/looking for, skip
            this.pending.delete(message.requestId);

            // Resolve or reject depending on the outcome
            if (message.ok) pending.resolve(message.data);
            else pending.reject(new Error(message.error ?? "Request failed"));
            return;
        }

        // Server-pushed events that the client is subscribed to
        if (message.type === "event") {
            const handlers = this.scopeHandlers.get(message.scope);
            if (!handlers) return;
            for (const handler of handlers) {
                try { handler(message.data); } catch { /* spec: client handler errors are suppressed */ }
            }
            return;
        }
    }

    private async sendEnvelope(envelope: object): Promise<void> {
        const authData = await this.getAuthData();
        this.dispatch({ ...envelope, participantId: this.participantId, authData });
    }

    private async request<T>(method: string, args: unknown[]): Promise<T> {
        // Reserve a pending entry, the response handler in receive() resolves or rejects it
        const requestId = String(this.nextRequestId++);
        const promise = new Promise<T>((resolve, reject) => {
            this.pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject });
        });

        // If the send itself fails (auth, encode, dispatch), drop the pending entry so the map doesn't leak
        try { await this.sendEnvelope({ type: "request", requestId, method, args }); }
        catch (error) { this.pending.delete(requestId); throw error; }

        return promise;
    }

    private async subscribe(scope: string, handler: AnyHandler): Promise<void> {
        // Track the handler locally and remember which scope it belongs to so off* can find it
        let set = this.scopeHandlers.get(scope);
        const isFirst = !set;
        if (!set) { set = new Set(); this.scopeHandlers.set(scope, set); }
        set.add(handler);
        this.handlerScope.set(handler, scope);

        // Only inform the server on the first handler for this scope, subsequent calls are local-only
        if (isFirst) await this.sendEnvelope({ type: "subscribe", scope });
    }

    private async unsubscribe(handler: AnyHandler): Promise<void> {
        // Look up which scope this handler was registered under
        const scope = this.handlerScope.get(handler);
        if (!scope) return;
        this.handlerScope.delete(handler);

        const set = this.scopeHandlers.get(scope);
        if (!set) return;
        set.delete(handler);

        // Only inform the server when the last handler for this scope is removed
        if (set.size === 0) {
            this.scopeHandlers.delete(scope);
            await this.sendEnvelope({ type: "unsubscribe", scope });
        }
    }

    // RPC: conversations -------------------------------------------------

    createConversation(maxSize?: number): Promise<string> {
        return this.request<string>("createConversation", maxSize === undefined ? [] : [maxSize]);
    }
    createInvite(conversationId: string, participantId: string): Promise<void> {
        return this.request<void>("createInvite", [conversationId, participantId]);
    }
    revokeInvite(conversationId: string, toParticipantId: string): Promise<void> {
        return this.request<void>("revokeInvite", [conversationId, toParticipantId]);
    }
    acceptInvite(conversationId: string): Promise<void> {
        return this.request<void>("acceptInvite", [conversationId]);
    }
    declineInvite(conversationId: string): Promise<void> {
        return this.request<void>("declineInvite", [conversationId]);
    }
    leaveConversation(conversationId: string): Promise<void> {
        return this.request<void>("leaveConversation", [conversationId]);
    }
    setIndicator(conversationId: string): Promise<void> {
        return this.request<void>("setIndicator", [conversationId]);
    }
    removeIndicator(conversationId: string): Promise<void> {
        return this.request<void>("removeIndicator", [conversationId]);
    }

    // RPC: messages ------------------------------------------------------

    sendMessage(conversationId: string, message: string, options?: MessageOptions): Promise<string> {
        return this.request<string>("sendMessage", [conversationId, message, options]);
    }
    editMessage(messageId: string, message: string): Promise<void> {
        return this.request<void>("editMessage", [messageId, message]);
    }
    deleteMessage(messageId: string): Promise<void> {
        return this.request<void>("deleteMessage", [messageId]);
    }
    addReaction(messageId: string, reaction: string): Promise<void> {
        return this.request<void>("addReaction", [messageId, reaction]);
    }
    removeReaction(reactionId: string): Promise<void> {
        return this.request<void>("removeReaction", [reactionId]);
    }

    // RPC: getters -------------------------------------------------------

    getConversations(participantId: string): Promise<Conversation[]> {
        return this.request<Conversation[]>("getConversations", [participantId]);
    }
    getMessages(conversationId: string, cursorMessageId: string | null, after: boolean, amount: number): Promise<{ messages: Message[], remainingInDirection: number }> {
        return this.request("getMessages", [conversationId, cursorMessageId, after, amount]);
    }
    getInvites(participantId: string): Promise<Invite[]> {
        return this.request<Invite[]>("getInvites", [participantId]);
    }
    getAliases(participantIds: string[]): Promise<Alias[]> {
        return this.request<Alias[]>("getAliases", [participantIds]);
    }
    getParticipantActivities(): Promise<ParticipantActivity[]> {
        return this.request<ParticipantActivity[]>("getParticipantActivities", []);
    }

    // Event subscriptions ------------------------------------------------

    onMessage(conversationId: string, handler: (message: Message) => void): Promise<void> {
        return this.subscribe(encodeScope({ kind: "message", conversationId }), handler as AnyHandler);
    }
    offMessage(handler: (message: Message) => void): Promise<void> {
        return this.unsubscribe(handler as AnyHandler);
    }

    onIndicators(conversationId: string, handler: (indicators: Indicator[]) => void): Promise<void> {
        return this.subscribe(encodeScope({ kind: "indicators", conversationId }), handler as AnyHandler);
    }
    offIndicators(handler: (indicators: Indicator[]) => void): Promise<void> {
        return this.unsubscribe(handler as AnyHandler);
    }

    onConversation(handler: (event: ConversationEvent) => void): Promise<void> {
        return this.subscribe(encodeScope({ kind: "conversation" }), handler as AnyHandler);
    }
    offConversation(handler: (event: ConversationEvent) => void): Promise<void> {
        return this.unsubscribe(handler as AnyHandler);
    }

    onInvite(handler: (event: InviteEvent) => void): Promise<void> {
        return this.subscribe(encodeScope({ kind: "invite" }), handler as AnyHandler);
    }
    offInvite(handler: (event: InviteEvent) => void): Promise<void> {
        return this.unsubscribe(handler as AnyHandler);
    }
}
