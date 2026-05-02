import { sanitize } from "../shared/serialization.js";
import { type ClientToServer, isValidScope } from "../shared/protocol.js";
import { logError } from "../shared/log.js";
import type { ServiceResult } from "./context.js";
import type { Conversation, ConversationRecord, Message, MessageOptions, Reaction, Invite, ParticipantActivity, Alias, SystemEvent } from "../shared/shared-types.js";
import {
    type ServerDispatch,
    type RateLimitOptions,
    type CleanupOptions,
    type ResolvedRateLimits,
    type ResolvedCleanup,
    type Handler,
    type Handlers,
} from "./server-types.js";

export type { ServerDispatch, RateLimitOptions, CleanupOptions } from "./server-types.js";
export type { Conversation, ConversationRecord, Message, MessageOptions, SystemEvent, Reaction, Invite, ParticipantActivity, Alias } from "../shared/shared-types.js";
import { Subscriptions } from "./subscriptions.js";
import { RateLimiter } from "./rate-limits.js";
import { CleanupScheduler } from "./cleanup.js";
import { IndicatorStore } from "./indicators-store.js";
import type { ServerContext } from "./context.js";

import * as conversationsService from "./services/conversations.js";
import * as messagesService from "./services/messages.js";
import * as indicatorsService from "./services/indicators.js";
import * as gettersService from "./services/getters.js";
import * as participantsService from "./services/participants.js";

export class Server {
    private dispatch: ServerDispatch;
    private rateLimits: ResolvedRateLimits;
    private cleanup: ResolvedCleanup;
    private handlers: Handlers = {};
    private subscriptions: Subscriptions;
    private rateLimiter: RateLimiter;
    private scheduler: CleanupScheduler;
    private ctx: ServerContext;

    constructor(dispatch: ServerDispatch, rateLimits: RateLimitOptions = {}, cleanup: CleanupOptions = {}) {
        this.dispatch = dispatch;
        this.rateLimits = {
            inviteLimitPerHour: rateLimits.inviteLimitPerHour ?? 10,
            messageLimitPerSecond: rateLimits.messageLimitPerSecond ?? 5,
            conversationParticipantLimit: rateLimits.conversationParticipantLimit ?? 100,
            sweepIntervalSeconds: rateLimits.sweepIntervalSeconds ?? 30,
        };
        this.cleanup = {
            indicatorTtlSeconds: (cleanup.indicatorTtlSeconds && cleanup.indicatorTtlSeconds > 0) ? cleanup.indicatorTtlSeconds : 3,
            indicatorCleanupIntervalSeconds: (cleanup.indicatorCleanupIntervalSeconds && cleanup.indicatorCleanupIntervalSeconds > 0) ? cleanup.indicatorCleanupIntervalSeconds : 5,
            messageAfterDays: cleanup.messageAfterDays ?? null,
            conversationAfterInactiveDays: cleanup.conversationAfterInactiveDays ?? null,
            inviteAfterDays: cleanup.inviteAfterDays ?? 7,
            activityCacheLifetimeMinutes: cleanup.activityCacheLifetimeMinutes ?? 10,
        };

        const activityCache = new Map<string, number>();
        const indicators = new IndicatorStore();
        this.subscriptions = new Subscriptions(this.dispatch, this.handlers, indicators);
        this.rateLimiter = new RateLimiter(this.rateLimits);
        this.scheduler = new CleanupScheduler(this.handlers, this.cleanup, this.rateLimiter, this.rateLimits.sweepIntervalSeconds, activityCache, indicators, this.subscriptions);
        this.ctx = {
            handlers: this.handlers,
            subscriptions: this.subscriptions,
            rateLimiter: this.rateLimiter,
            rateLimits: this.rateLimits,
            activityCache,
            indicators,
        };
        this.scheduler.start();
    }

    stop(): void {
        this.scheduler.stop();
    }

    // Handler registration ----------------------------------------------

    onCreateConversation(handler: Handler<[ConversationRecord, string], void>) { this.handlers.createConversation = handler; }
    onCreateMessage(handler: Handler<[Message], void>) { this.handlers.createMessage = handler; }
    onCreateReaction(handler: Handler<[Reaction], void>) { this.handlers.createReaction = handler; }
    onCreateInvite(handler: Handler<[Invite], void>) { this.handlers.createInvite = handler; }
    onCreateConversationParticipantActivity(handler: Handler<[ParticipantActivity], void>) { this.handlers.createConversationParticipantActivity = handler; }

    onReadConversations(handler: Handler<[string], Conversation[]>) { this.handlers.readConversations = handler; }
    onReadMessages(handler: Handler<[string, string | null, boolean, number], { messages: Message[], remainingInDirection: number }>) { this.handlers.readMessages = handler; }
    onReadInvites(handler: Handler<[string], Invite[]>) { this.handlers.readInvites = handler; }
    onReadAliases(handler: Handler<[string[]], Alias[]>) { this.handlers.readAliases = handler; }
    onReadConversationParticipantActivity(handler: Handler<[string, string], ParticipantActivity | null>) { this.handlers.readConversationParticipantActivity = handler; }
    onReadParticipantActivities(handler: Handler<[string], ParticipantActivity[]>) { this.handlers.readParticipantActivities = handler; }
    onReadMessage(handler: Handler<[string], Message | null>) { this.handlers.readMessage = handler; }
    onReadConversation(handler: Handler<[string], Conversation | null>) { this.handlers.readConversation = handler; }
    onReadInvite(handler: Handler<[string, string], Invite | null>) { this.handlers.readInvite = handler; }
    onReadReaction(handler: Handler<[string], Reaction | null>) { this.handlers.readReaction = handler; }

    onAddConversationParticipant(handler: Handler<[string, string, number], void>) { this.handlers.addConversationParticipant = handler; }
    onRemoveConversationParticipant(handler: Handler<[string, string], void>) { this.handlers.removeConversationParticipant = handler; }
    onUpdateMessage(handler: Handler<[Message], void>) { this.handlers.updateMessage = handler; }
    onUpdateConversationParticipantActivity(handler: Handler<[ParticipantActivity], void>) { this.handlers.updateConversationParticipantActivity = handler; }

    onDeleteReaction(handler: Handler<[string], void>) { this.handlers.deleteReaction = handler; }
    onDeleteConversationWithMessagesAndReactions(handler: Handler<[string], void>) { this.handlers.deleteConversationWithMessagesAndReactions = handler; }
    onDeleteInvites(handler: Handler<[{ conversationId: string, toParticipantId: string }[]], void>) { this.handlers.deleteInvites = handler; }
    onDeleteConversationParticipantActivities(handler: Handler<[string[], string[]], void>) { this.handlers.deleteConversationParticipantActivities = handler; }
    onDeleteMessagesBefore(handler: Handler<[Date], void>) { this.handlers.deleteMessagesBefore = handler; }
    onDeleteInactiveConversationsBefore(handler: Handler<[Date], void>) { this.handlers.deleteInactiveConversationsBefore = handler; }
    onDeleteInvitesBefore(handler: Handler<[Date], void>) { this.handlers.deleteInvitesBefore = handler; }

    onParticipantAuth(handler: Handler<[string, unknown], boolean>) { this.handlers.participantAuth = handler; }
    onInviteAuth(handler: Handler<[string, string], boolean>) { this.handlers.inviteAuth = handler; }
    onProfanityCheckCensor(handler: Handler<[string], string>) { this.handlers.profanityCheckCensor = handler; }
    onProfanityCheckBlock(handler: Handler<[string], boolean>) { this.handlers.profanityCheckBlock = handler; }

    // Transport ----------------------------------------------------------

    async receive(data: unknown): Promise<void> {
        if (!data || typeof data !== "object" || typeof (data as { type?: unknown }).type !== "string") return;
        let message: ClientToServer;
        try { message = sanitize(data as ClientToServer); }
        catch (error) { logError("sanitize", error); return; }

        // "server" is a reserved sentinel for library-authored system messages, clients cannot claim it
        if (message.participantId === "server") {
            if (message.type === "request") this.subscriptions.sendResponse(message.participantId, message.requestId, false, undefined, "Unauthorized");
            return;
        }

        // Auth callback - on failure, reject the pending request promise, sub/unsub failures drop silently
        const authed = await this.verifyAuth(message.participantId, message.authData);
        if (!authed) {
            if (message.type === "request") this.subscriptions.sendResponse(message.participantId, message.requestId, false, undefined, "Unauthorized");
            return;
        }

        // Route to protocol-level handlers
        if (message.type === "request") return this.handleRequest(message.participantId, message.requestId, message.method, message.args);
        if (message.type === "subscribe") return this.handleSubscribe(message.participantId, message.scope);
        if (message.type === "unsubscribe") return this.handleUnsubscribe(message.participantId, message.scope);
    }

    private async verifyAuth(participantId: string, authData: unknown): Promise<boolean> {
        const handler = this.handlers.participantAuth;
        if (!handler) return false;
        try { return await handler(participantId, authData); }
        catch (error) { logError("participantAuth", error); return false; }
    }

    // RPC dispatch -------------------------------------------------------

    // Route to request handlers, send response, then run any hooks
    private async handleRequest(participantId: string, requestId: string, method: string, args: unknown[]): Promise<void> {
        let serviceResult: ServiceResult<unknown>;
        try {
            serviceResult = await this.invoke(participantId, method, args);
            this.subscriptions.sendResponse(participantId, requestId, true, serviceResult.result);
        } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            this.subscriptions.sendResponse(participantId, requestId, false, undefined, text);
            return;
        }
        await this.runHooks(serviceResult.hooks);
    }

    private async runHooks(hooks: ServiceResult<unknown>["hooks"]): Promise<void> {
        for (const hook of hooks) {
            try { await hook(); } catch (error) { logError("hook", error); }
        }
    }

    private invoke(participantId: string, method: string, args: unknown[]): Promise<ServiceResult<unknown>> {
        switch (method) {
            case "createConversation": return conversationsService.createConversation(this.ctx, participantId, args[0] as number | undefined);
            case "createInvite": return conversationsService.createInvite(this.ctx, participantId, args[0] as string, args[1] as string);
            case "revokeInvite": return conversationsService.revokeInvite(this.ctx, participantId, args[0] as string, args[1] as string);
            case "acceptInvite": return conversationsService.acceptInvite(this.ctx, participantId, args[0] as string);
            case "declineInvite": return conversationsService.declineInvite(this.ctx, participantId, args[0] as string);
            case "leaveConversation": return conversationsService.leaveConversation(this.ctx, participantId, args[0] as string);
            case "setIndicator": return indicatorsService.setIndicator(this.ctx, participantId, args[0] as string);
            case "removeIndicator": return indicatorsService.removeIndicator(this.ctx, participantId, args[0] as string);
            case "sendMessage": return messagesService.sendMessage(this.ctx, participantId, args[0] as string, args[1] as string, args[2] as MessageOptions);
            case "editMessage": return messagesService.editMessage(this.ctx, participantId, args[0] as string, args[1] as string);
            case "deleteMessage": return messagesService.deleteMessage(this.ctx, participantId, args[0] as string);
            case "addReaction": return messagesService.addReaction(this.ctx, participantId, args[0] as string, args[1] as string);
            case "removeReaction": return messagesService.removeReaction(this.ctx, participantId, args[0] as string);
            case "getConversations": return gettersService.getConversations(this.ctx, args[0] as string);
            case "getMessages": return gettersService.getMessages(this.ctx, participantId, args[0] as string, args[1] as string | null, args[2] as boolean, args[3] as number);
            case "getInvites": return gettersService.getInvites(this.ctx, args[0] as string);
            case "getAliases": return gettersService.getAliases(this.ctx, args[0] as string[]);
            case "getParticipantActivities": return gettersService.getParticipantActivities(this.ctx, participantId);
            default: throw new Error(`Unknown method: ${method}`);
        }
    }

    // Subscriptions ------------------------------------------------------

    private handleSubscribe(participantId: string, scope: string): void {
        if (!isValidScope(scope)) return;
        this.subscriptions.add(participantId, scope);
    }

    private handleUnsubscribe(participantId: string, scope: string): void {
        this.subscriptions.remove(participantId, scope);
    }

    // Admin --------------------------------------------------------------

    // Resolve the admin promise first, run hooks directly afterwards
    private async runAdmin<T>(work: Promise<ServiceResult<T>>): Promise<T> {
        const sr = await work;
        if (sr.hooks.length > 0) setTimeout(() => void this.runHooks(sr.hooks), 0);
        return sr.result;
    }

    deleteParticipant(participantId: string): Promise<void> {
        return this.runAdmin(participantsService.deleteParticipant(this.ctx, participantId));
    }

    cleanupParticipant(participantId: string): void {
        this.subscriptions.removeAllFor(participantId);
    }

    acceptInvite(conversationId: string, participantId: string): Promise<void> {
        return this.runAdmin(conversationsService.acceptInvite(this.ctx, participantId, conversationId));
    }

    revokeInvite(conversationId: string, fromParticipantId: string, toParticipantId: string): Promise<void> {
        return this.runAdmin(conversationsService.revokeInviteByPair(this.ctx, conversationId, fromParticipantId, toParticipantId));
    }

    joinConversation(conversationId: string, participantId: string): Promise<void> {
        return this.runAdmin(conversationsService.joinConversation(this.ctx, conversationId, participantId));
    }

    leaveConversation(conversationId: string, participantId: string): Promise<void> {
        return this.runAdmin(conversationsService.leaveConversation(this.ctx, participantId, conversationId));
    }

    sendMessage(conversationId: string, participantId: string, message: string, options?: MessageOptions, systemEvent?: SystemEvent): Promise<string> {
        return this.runAdmin(messagesService.addMessage(this.ctx, conversationId, participantId, message, options, systemEvent));
    }

    // Hook registration --------------------------------------------

    onAfterMessageCreated(handler: Handler<[Message], void>) { this.handlers.afterMessageCreated = handler; }
    onAfterMessageDeleted(handler: Handler<[Message], void>) { this.handlers.afterMessageDeleted = handler; }
    onAfterParticipantJoined(handler: Handler<[string, string], void>) { this.handlers.afterParticipantJoined = handler; }
    onAfterParticipantLeft(handler: Handler<[string, string], void>) { this.handlers.afterParticipantLeft = handler; }
    onAfterInviteCreated(handler: Handler<[Invite], void>) { this.handlers.afterInviteCreated = handler; }
    onAfterInviteDeleted(handler: Handler<[string, string, string], void>) { this.handlers.afterInviteDeleted = handler; }
    onAfterConversationCreated(handler: Handler<[Conversation], void>) { this.handlers.afterConversationCreated = handler; }
    onAfterConversationDeleted(handler: Handler<[string], void>) { this.handlers.afterConversationDeleted = handler; }
}
