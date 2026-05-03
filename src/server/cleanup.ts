import { type ResolvedCleanup, getHandler } from "./server-types.js";
import { type ServerContext, fireHook } from "./context.js";
import { emitConversationDeleted } from "./services/conversations.js";
import { logError } from "../shared/log.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export class CleanupScheduler {
    private indicatorTimer: ReturnType<typeof setInterval> | null = null;
    private dailyTimer: ReturnType<typeof setInterval> | null = null;
    private sweepTimer: ReturnType<typeof setInterval> | null = null;
    private activityCacheTimer: ReturnType<typeof setInterval> | null = null;

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

        this.sweepTimer = setInterval(() => this.ctx.rateLimiter.sweep(), this.sweepIntervalSeconds * 1000);
        this.sweepTimer.unref?.();

        this.activityCacheTimer = setInterval(() => this.ctx.activityCache.clear(), this.cleanup.activityCacheLifetimeMinutes * 60 * 1000);
        this.activityCacheTimer.unref?.();
    }

    stop(): void {
        if (this.indicatorTimer) clearInterval(this.indicatorTimer);
        if (this.dailyTimer) clearInterval(this.dailyTimer);
        if (this.sweepTimer) clearInterval(this.sweepTimer);
        if (this.activityCacheTimer) clearInterval(this.activityCacheTimer);
        this.indicatorTimer = null;
        this.dailyTimer = null;
        this.sweepTimer = null;
        this.activityCacheTimer = null;
    }

    private runIndicators(): void {
        // Broadcast affected conversations so subscribers see the post-sweep indicator state
        const affected = this.ctx.indicators.sweep(Date.now() - this.cleanup.indicatorTtlSeconds * 1000);
        for (const conversationId of affected) this.ctx.subscriptions.broadcastIndicators(conversationId);
    }

    private async runDaily(): Promise<void> {
        const now = Date.now();
        if (this.cleanup.messageAfterDays && this.cleanup.messageAfterDays > 0) {
            const handler = getHandler(this.ctx.handlers, "deleteMessagesBefore");
            try { await handler(new Date(now - this.cleanup.messageAfterDays * ONE_DAY_MS)); }
            catch (error) { logError("deleteMessagesBefore", error); }
        }
        if (this.cleanup.conversationAfterInactiveDays && this.cleanup.conversationAfterInactiveDays > 0) {
            const handler = getHandler(this.ctx.handlers, "deleteConversationsWithMessagesReactionsInvitesAndActivitiesBefore");
            try {
                const { deletedConversations } = await handler(new Date(now - this.cleanup.conversationAfterInactiveDays * ONE_DAY_MS));
                for (const c of deletedConversations) {
                    // Handler already deleted the rows, just emit the side-effects
                    const hooks = emitConversationDeleted(this.ctx, c.conversationId, c.formerParticipants, c.deletedInvites);
                    for (const hook of hooks) await hook();
                }
            } catch (error) { logError("deleteConversationsWithMessagesReactionsInvitesAndActivitiesBefore", error); }
        }
        if (this.cleanup.inviteAfterDays && this.cleanup.inviteAfterDays > 0) {
            const handler = getHandler(this.ctx.handlers, "deleteInvitesBefore");
            try {
                const { deletedInvites } = await handler(new Date(now - this.cleanup.inviteAfterDays * ONE_DAY_MS));
                for (const invite of deletedInvites) {
                    this.ctx.subscriptions.broadcastInviteDeleted(invite.conversationId, invite.fromParticipantId, invite.toParticipantId);
                    fireHook(this.ctx.handlers, "afterInviteDeleted", invite.conversationId, invite.fromParticipantId, invite.toParticipantId);
                }
            } catch (error) { logError("deleteInvitesBefore", error); }
        }
    }
}
