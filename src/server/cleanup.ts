import { type ResolvedCleanup, getHandler } from "./server-types.js";
import { type ServerContext, fireHook } from "./context.js";
import { emitConversationDeleted } from "./services/conversations.js";
import { buildMessage } from "./services/messages.js";
import { logError, logInfo } from "../shared/log.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export class CleanupScheduler {
    private indicatorTimer: ReturnType<typeof setInterval> | null = null;
    private dailyTimer: ReturnType<typeof setInterval> | null = null;
    private rateLimitSweepTimer: ReturnType<typeof setInterval> | null = null;
    private cacheSweepTimer: ReturnType<typeof setInterval> | null = null;

    constructor(
        private ctx: ServerContext,
        private cleanup: ResolvedCleanup,
        private sweepIntervalSeconds: number,
    ) { }

    start(): void {
        this.indicatorTimer = setInterval(() => this.runIndicators(), this.cleanup.indicatorCleanupIntervalSeconds * 1000);
        this.indicatorTimer.unref?.(); // Unref to let the node process exit naturally

        this.dailyTimer = setInterval(() => void this.runDaily(), ONE_DAY_MS);
        this.dailyTimer.unref?.();

        this.rateLimitSweepTimer = setInterval(() => this.runRateLimits(), this.sweepIntervalSeconds * 1000);
        this.rateLimitSweepTimer.unref?.();

        this.cacheSweepTimer = setInterval(() => this.runCaches(), this.cleanup.cacheCleanupIntervalSeconds * 1000);
        this.cacheSweepTimer.unref?.();
    }

    stop(): void {
        if (this.indicatorTimer) clearInterval(this.indicatorTimer);
        if (this.dailyTimer) clearInterval(this.dailyTimer);
        if (this.rateLimitSweepTimer) clearInterval(this.rateLimitSweepTimer);
        if (this.cacheSweepTimer) clearInterval(this.cacheSweepTimer);
        this.indicatorTimer = null;
        this.dailyTimer = null;
        this.rateLimitSweepTimer = null;
        this.cacheSweepTimer = null;
    }

    private runIndicators(): void {
        // Broadcast affected conversations so subscribers see the post-sweep indicator state
        // Not logged because work is bounded by active typers & it runs every few seconds (log spam)
        const affected = this.ctx.indicators.sweep(Date.now() - this.cleanup.indicatorTtlSeconds * 1000);
        for (const conversationId of affected) this.ctx.subscriptions.emit(this.ctx.subscriptions.prepareIndicators(conversationId));
    }

    private runCaches(): void {
        const startedAt = Date.now();
        const threshold = startedAt - this.cleanup.cacheEntryTtlMinutes * 60 * 1000;
        const activityRemoved = this.ctx.activityCache.sweep(threshold);
        const conversationRemoved = this.ctx.conversationCache.sweep(threshold);
        const durationMs = Date.now() - startedAt;
        
        // Only log when slow
        if (durationMs > 50) {
            logInfo("slow cache sweep", {
                activityRemoved, activityRemaining: this.ctx.activityCache.size(),
                conversationRemoved, conversationRemaining: this.ctx.conversationCache.size(),
                durationMs,
            });
        }
    }

    private runRateLimits(): void {
        const startedAt = Date.now();
        const { removed, remaining } = this.ctx.rateLimiter.sweep();
        const durationMs = Date.now() - startedAt;
        
        // Only log when slow
        if (durationMs > 50) {
            logInfo("slow rate limit sweep", { removed, remaining, durationMs });
        }
    }

    private async runDaily(): Promise<void> {
        const now = Date.now();
        if (this.cleanup.messageAfterDays && this.cleanup.messageAfterDays > 0) {
            const handler = getHandler(this.ctx.handlers, "deleteMessagesBefore");
            const threshold = new Date(now - this.cleanup.messageAfterDays * ONE_DAY_MS);
            const startedAt = Date.now();
            try {
                const { affectedConversationIds } = await handler(threshold);
                logInfo("daily messageAfterDays cleanup", { affectedConversations: affectedConversationIds.length, durationMs: Date.now() - startedAt });

                // Post a "messagesRemoved" system message per affected conversation, backdated so it sorts before any surviving message and never bumps lastActivityAt
                // Not broadcast, live clients still hold the older messages in memory until they refresh
                if (affectedConversationIds.length > 0) {
                    const sysMsgCreatedAt = new Date(threshold.getTime() - 1);
                    const sysMsgs = affectedConversationIds.map(conversationId =>
                        buildMessage("server", conversationId, "", undefined, { type: "messagesRemoved" }, sysMsgCreatedAt),
                    );
                    try {
                        // Handler dedups per conversation and returns the resulting oldest system message for each (just-inserted or pre-existing)
                        const { oldestMessagesByConversationId } = await getHandler(this.ctx.handlers, "createMessagesSystemRemoved")(sysMsgs);

                        // Patch caches before firing hooks so hooks reading through the cache see post-cleanup state
                        for (const [conversationId, oldest] of oldestMessagesByConversationId) {
                            const cached = this.ctx.conversationCache.get(conversationId);
                            // Cached lastMessage was deleted by this run, which means no newer message survived (otherwise the cache would have held that one), so the returned oldest is the new lastMessage
                            if (cached?.lastMessage && cached.lastMessage.createdAt < threshold) {
                                this.ctx.conversationCache.set(conversationId, { ...cached, lastMessage: oldest });
                            }
                        }

                        // Fire afterMessageCreated only for sysMsgs we actually inserted (matched by messageId against the ones we built locally)
                        const ourSysMsgIds = new Set(sysMsgs.map(m => m.messageId));
                        for (const oldest of oldestMessagesByConversationId.values()) {
                            if (ourSysMsgIds.has(oldest.messageId)) fireHook(this.ctx.handlers, "afterMessageCreated", oldest);
                        }
                    } catch (error) {
                        // Insert failure leaves the DB in an unknown state, invalidate stale entries so next read repopulates
                        this.ctx.conversationCache.invalidateMatching(c => c.lastMessage !== null && c.lastMessage.createdAt < threshold);
                        logError("createMessagesSystemRemoved", error);
                    }
                }
            } catch (error) { logError("deleteMessagesBefore", error); }
            await new Promise(resolve => setTimeout(resolve, this.cleanup.timeoutBetweenDailyCleanupsSeconds * 1000));
        }
        if (this.cleanup.conversationAfterInactiveDays && this.cleanup.conversationAfterInactiveDays > 0) {
            const handler = getHandler(this.ctx.handlers, "deleteConversationsWithMessagesReactionsInvitesAndActivitiesBefore");
            const startedAt = Date.now();
            try {
                const { deletedConversations } = await handler(new Date(now - this.cleanup.conversationAfterInactiveDays * ONE_DAY_MS));
                logInfo("daily conversationAfterInactiveDays cleanup", { deletedConversations: deletedConversations.length, durationMs: Date.now() - startedAt });
                for (const c of deletedConversations) {
                    // Handler already deleted the rows, just emit the side-effects and invalidate the conversation + activity caches
                    for (const pid of c.formerParticipantIds) this.ctx.activityCache.invalidate(`${c.conversationId}|${pid}`);
                    this.ctx.conversationCache.invalidate(c.conversationId);
                    // Signal activity removal for onParticipantActivity event
                    this.ctx.subscriptions.emit(...c.formerParticipantIds.map(pid => this.ctx.subscriptions.prepareParticipantActivityDeleted(pid, c.conversationId)));
                    const hooks = emitConversationDeleted(this.ctx, c.conversationId, c.formerParticipantIds, c.deletedInvites);
                    for (const hook of hooks) await hook();
                }
            } catch (error) { logError("deleteConversationsWithMessagesReactionsInvitesAndActivitiesBefore", error); }
            await new Promise(resolve => setTimeout(resolve, this.cleanup.timeoutBetweenDailyCleanupsSeconds * 1000));
        }
        if (this.cleanup.inviteAfterDays && this.cleanup.inviteAfterDays > 0) {
            const handler = getHandler(this.ctx.handlers, "deleteInvitesBefore");
            const startedAt = Date.now();
            try {
                const { deletedInvites } = await handler(new Date(now - this.cleanup.inviteAfterDays * ONE_DAY_MS));
                logInfo("daily inviteAfterDays cleanup", { deletedInvites: deletedInvites.length, durationMs: Date.now() - startedAt });
                // Bundle all invite deletions so subscribers see them in one batch
                this.ctx.subscriptions.emit(...deletedInvites.map(invite => this.ctx.subscriptions.prepareInviteDeleted(invite.conversationId, invite.fromParticipantId, invite.toParticipantId)));
                for (const invite of deletedInvites) {
                    fireHook(this.ctx.handlers, "afterInviteDeleted", invite.conversationId, invite.fromParticipantId, invite.toParticipantId);
                }
            } catch (error) { logError("deleteInvitesBefore", error); }
        }
    }
}
