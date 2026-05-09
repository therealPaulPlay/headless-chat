import { type ServerToClient, encodeScope } from "../shared/protocol.js";
import type { Conversation, Invite, Message, MessageOptions, Indicator, Alias, ParticipantActivity } from "../shared/shared-types.js";

export type { Conversation, Message, MessageOptions, Indicator, Invite, ParticipantActivity, Alias } from "../shared/shared-types.js";

export type ClientDispatch = (data: unknown) => void | Promise<void>;
export type GetAuthData = () => unknown | Promise<unknown>;

type AnyHandler = (...args: unknown[]) => void;

type ConversationEvent = { conversationId: string, data: Conversation | null };
type InviteEvent = { conversationId: string, toParticipantId: string, data: Invite | null };
type ParticipantActivityEvent = { conversationId: string, data: ParticipantActivity | null };

// Entry shape for onMany/offMany, kind discriminates the handler signature and whether a conversationId is required
export type SubscriptionEntry =
    | { kind: "message", conversationId: string, handlers: ((message: Message) => void)[] }
    | { kind: "indicators", conversationId: string, handlers: ((indicators: Indicator[]) => void)[] }
    | { kind: "conversation", handlers: ((event: ConversationEvent) => void)[] }
    | { kind: "invite", handlers: ((event: InviteEvent) => void)[] }
    | { kind: "participantActivity", handlers: ((event: ParticipantActivityEvent) => void)[] };

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

    // Reject in-flight RPCs, unsubscribe the server from all scopes, and clear handler tracking. Call when discarding the instance
    dispose(): void {
        for (const { reject } of this.pending.values()) reject(new Error("Client disposed"));
        this.pending.clear();

        // Tell the server to stop pushing for every scope still subscribed locally, the consumer may keep the transport alive (eg. just swapping client instances) so we can't rely on disconnect-driven cleanupParticipant
        // Best-effort only, if the transport is already torn down the dispatch failure is swallowed, since dispose itself shouldn't throw
        const scopes = [...this.scopeHandlers.keys()];
        if (scopes.length > 0) this.sendEnvelope({ type: "unsubscribe", scope: scopes }).catch(() => { });
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

        // Server-pushed events the client is subscribed to, delivered in batches
        if (message.type === "events") {
            for (const event of message.events) {
                const handlers = this.scopeHandlers.get(event.scope);
                if (!handlers) continue;
                for (const handler of handlers) {
                    try { handler(event.data); } catch { }
                }
            }
            return;
        }
    }

    private async sendEnvelope(envelope: object): Promise<void> {
        const authData = await this.getAuthData();
        // Awaited so an async dispatch's rejection propagates, request() uses this to fail the pending RPC promise instead of hanging
        await this.dispatch({ ...envelope, participantId: this.participantId, authData });
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
        // Track the handler locally, only inform the server on the first handler for this scope
        // On dispatch failure, undo the local attach so the consumer can retry from a clean state
        if (!this.attachHandler(scope, handler)) return;
        try { await this.sendEnvelope({ type: "subscribe", scope }); }
        catch (error) { this.detachHandler(handler); throw error; }
    }

    private async unsubscribe(handler: AnyHandler): Promise<void> {
        // Only inform the server when the last handler for the scope is removed
        // On dispatch failure, undo the local detach so the handler keeps receiving events the server is still pushing
        const scope = this.detachHandler(handler);
        if (scope === null) return;
        try { await this.sendEnvelope({ type: "unsubscribe", scope }); }
        catch (error) { this.attachHandler(scope, handler); throw error; }
    }

    // Attach a handler to a scope locally, returns true if this is the first handler for the scope
    private attachHandler(scope: string, handler: AnyHandler): boolean {
        let set = this.scopeHandlers.get(scope);
        const isFirst = !set;
        if (!set) { set = new Set(); this.scopeHandlers.set(scope, set); }
        if (set.has(handler)) return false; // Already attached, no-op
        set.add(handler);
        this.handlerScope.set(handler, scope);
        return isFirst;
    }

    // Detach a handler locally, returns the scope to unsubscribe from if this was the last handler, or null otherwise
    private detachHandler(handler: AnyHandler): string | null {
        const scope = this.handlerScope.get(handler);
        if (!scope) return null;
        this.handlerScope.delete(handler);
        const set = this.scopeHandlers.get(scope);
        if (!set) return null;
        set.delete(handler);
        if (set.size > 0) return null;
        this.scopeHandlers.delete(scope);
        return scope;
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
    addReaction(messageId: string, reaction: string): Promise<string> {
        return this.request<string>("addReaction", [messageId, reaction]);
    }
    removeReaction(reactionId: string): Promise<void> {
        return this.request<void>("removeReaction", [reactionId]);
    }

    // RPC: getters -------------------------------------------------------

    getConversations(): Promise<Conversation[]> {
        return this.request<Conversation[]>("getConversations", []);
    }
    getMessages(conversationId: string, cursorMessageId: string | null, after: boolean, amount: number): Promise<{ messages: Message[], remainingInDirection: number }> {
        return this.request("getMessages", [conversationId, cursorMessageId, after, amount]);
    }
    getMessagesByIds(messageIds: string[]): Promise<Message[]> {
        return this.request<Message[]>("getMessagesByIds", [messageIds]);
    }
    getInvites(): Promise<Invite[]> {
        return this.request<Invite[]>("getInvites", []);
    }
    getAliases(participantIds: string[]): Promise<Alias[]> {
        return this.request<Alias[]>("getAliases", [participantIds]);
    }
    getParticipantActivities(): Promise<ParticipantActivity[]> {
        return this.request<ParticipantActivity[]>("getParticipantActivities", []);
    }
    getHasNew(): Promise<{ hasNewMessages: boolean, hasNewInvites: boolean }> {
        return this.request<{ hasNewMessages: boolean, hasNewInvites: boolean }>("getHasNew", []);
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

    onParticipantActivity(handler: (event: ParticipantActivityEvent) => void): Promise<void> {
        return this.subscribe(encodeScope({ kind: "participantActivity" }), handler as AnyHandler);
    }
    offParticipantActivity(handler: (event: ParticipantActivityEvent) => void): Promise<void> {
        return this.unsubscribe(handler as AnyHandler);
    }

    // Bundle multiple subscriptions in a single envelope to avoid one round-trip per scope on cold start
    // Handlers already attached to a scope are silently skipped, scopes that gain their first handler are batched into one subscribe envelope
    // On dispatch failure, all local attaches done in this call are rolled back so the consumer can retry from a clean state
    async onMany(entries: SubscriptionEntry[]): Promise<void> {
        const scopesToSubscribe: string[] = [];
        const attached: AnyHandler[] = []; // Handlers actually attached by this call, used for rollback if dispatch fails
        for (const entry of entries) {
            const scope = entry.kind === "message" || entry.kind === "indicators"
                ? encodeScope({ kind: entry.kind, conversationId: entry.conversationId })
                : encodeScope({ kind: entry.kind });
            for (const handler of entry.handlers) {
                const wasAttached = this.scopeHandlers.get(scope)?.has(handler as AnyHandler) ?? false;
                if (this.attachHandler(scope, handler as AnyHandler) && !scopesToSubscribe.includes(scope)) {
                    scopesToSubscribe.push(scope);
                }
                if (!wasAttached) attached.push(handler as AnyHandler);
            }
        }
        if (scopesToSubscribe.length === 0) return;
        try { await this.sendEnvelope({ type: "subscribe", scope: scopesToSubscribe }); }
        catch (error) { for (const handler of attached) this.detachHandler(handler); throw error; }
    }

    // Bundled counterpart to off* methods, takes handlers directly since each handler's scope is already tracked from the original attach
    // Only scopes whose last handler is removed are bundled into a single unsubscribe envelope
    // On dispatch failure, all local detaches done in this call are rolled back so the consumer can retry from a clean state
    async offMany(handlers: ((...args: never[]) => void)[]): Promise<void> {
        const scopesToUnsubscribe: string[] = [];
        const detached: { scope: string, handler: AnyHandler }[] = []; // (scope, handler) pairs detached by this call, used for rollback if dispatch fails
        for (const handler of handlers) {
            const previousScope = this.handlerScope.get(handler as AnyHandler);
            const removedScope = this.detachHandler(handler as AnyHandler);
            if (previousScope !== undefined) detached.push({ scope: previousScope, handler: handler as AnyHandler });
            if (removedScope !== null) scopesToUnsubscribe.push(removedScope);
        }
        if (scopesToUnsubscribe.length === 0) return;
        try { await this.sendEnvelope({ type: "unsubscribe", scope: scopesToUnsubscribe }); }
        catch (error) { for (const { scope, handler } of detached) this.attachHandler(scope, handler); throw error; }
    }
}
