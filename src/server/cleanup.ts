import { type ResolvedCleanup, getHandler } from "./server-types.js";
import { type ServerContext, fireHook } from "./context.js";
import { emitConversationDeleted } from "./services/conversations.js";
import { internalSendMessage } from "./services/messages.js";
import { logError } from "../shared/log.js";

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

        this.rateLimitSweepTimer = setInterval(() => this.ctx.rateLimiter.sweep(), this.sweepIntervalSeconds * 1000);
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
        const affected = this.ctx.indicators.sweep(Date.now() - this.cleanup.indicatorTtlSeconds * 1000);
        for (const conversationId of affected) this.ctx.subscriptions.emit(this.ctx.subscriptions.prepareIndicators(conversationId));
    }

    private runCaches(): void {
        const threshold = Date.now() - this.cleanup.cacheEntryTtlMinutes * 60 * 1000;
        this.ctx.activityCache.sweep(threshold);
        this.ctx.conversationCache.sweep(threshold);
    }

    private async runDaily(): Promise<void> {
        const now = Date.now();
        if (this.cleanup.messageAfterDays && this.cleanup.messageAfterDays > 0) {
            const handler = getHandler(this.ctx.handlers, "deleteMessagesBefore");
            const threshold = new Date(now - this.cleanup.messageAfterDays * ONE_DAY_MS);
            try {
                const { affectedConversationIds } = await handler(threshold);
                // Invalidate cache for conversations whose last message was deleted (now stale)
                this.ctx.conversationCache.invalidateMatching(c => c.lastMessage !== null && c.lastMessage.createdAt < threshold);

                // Post a "messagesRemoved" marker per affected conversation so the UI can show that older messages used to exist
                // createdAt = threshold - 1ms guarantees the marker sorts strictly before any surviving message (which all have createdAt >= threshold) and never bumps lastActivityAt
                // Persisted but not broadcast, a live client viewing the conversation already has the older messages loaded in memory and the marker only matters on the next page refresh
                const markerCreatedAt = new Date(threshold.getTime() - 1);
                for (const conversationId of affectedConversationIds) {
                    try {
                        // Dedup, an earlier run's marker would have createdAt < this run's threshold and thus already got deleted above, so the only stacking risk is within the same run when nothing else survived
                        const newest = await getHandler(this.ctx.handlers, "readMessages")(conversationId, null, false, 1);
                        if (newest.messages.length === 1 && newest.messages[0]?.systemEvent?.type === "messagesRemoved") continue;
                        const sysMsg = await internalSendMessage(this.ctx, conversationId, "server", "", { referenceMessageId: null, isForwarded: false }, { type: "messagesRemoved" }, markerCreatedAt);
                        for (const hook of sysMsg.hooks) await hook();
                    } catch (error) { logError("messagesRemoved system message", error); }
                }
            } catch (error) { logError("deleteMessagesBefore", error); }
        }
        if (this.cleanup.conversationAfterInactiveDays && this.cleanup.conversationAfterInactiveDays > 0) {
            const handler = getHandler(this.ctx.handlers, "deleteConversationsWithMessagesReactionsInvitesAndActivitiesBefore");
            try {
                const { deletedConversations } = await handler(new Date(now - this.cleanup.conversationAfterInactiveDays * ONE_DAY_MS));
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
        }
        if (this.cleanup.inviteAfterDays && this.cleanup.inviteAfterDays > 0) {
            const handler = getHandler(this.ctx.handlers, "deleteInvitesBefore");
            try {
                const { deletedInvites } = await handler(new Date(now - this.cleanup.inviteAfterDays * ONE_DAY_MS));
                // Bundle all invite deletions so subscribers see them in one batch
                this.ctx.subscriptions.emit(...deletedInvites.map(invite => this.ctx.subscriptions.prepareInviteDeleted(invite.conversationId, invite.fromParticipantId, invite.toParticipantId)));
                for (const invite of deletedInvites) {
                    fireHook(this.ctx.handlers, "afterInviteDeleted", invite.conversationId, invite.fromParticipantId, invite.toParticipantId);
                }
            } catch (error) { logError("deleteInvitesBefore", error); }
        }
    }
}
