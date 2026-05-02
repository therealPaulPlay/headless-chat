import { type Handlers, type ResolvedCleanup, getHandler } from "./server-types.js";
import type { RateLimiter } from "./rate-limits.js";
import type { IndicatorStore } from "./indicators-store.js";
import type { Subscriptions } from "./subscriptions.js";
import { logError } from "../shared/log.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export class CleanupScheduler {
    private indicatorTimer: ReturnType<typeof setInterval> | null = null;
    private dailyTimer: ReturnType<typeof setInterval> | null = null;
    private sweepTimer: ReturnType<typeof setInterval> | null = null;
    private activityCacheTimer: ReturnType<typeof setInterval> | null = null;

    constructor(
        private handlers: Handlers,
        private cleanup: ResolvedCleanup,
        private rateLimiter: RateLimiter,
        private sweepIntervalSeconds: number,
        private activityCache: Map<string, number>,
        private indicators: IndicatorStore,
        private subscriptions: Subscriptions,
    ) { }

    start(): void {
        this.indicatorTimer = setInterval(() => this.runIndicators(), this.cleanup.indicatorCleanupIntervalSeconds * 1000);
        this.indicatorTimer.unref?.(); // Unref to let the node process exit naturally

        this.dailyTimer = setInterval(() => void this.runDaily(), ONE_DAY_MS);
        this.dailyTimer.unref?.();

        this.sweepTimer = setInterval(() => this.rateLimiter.sweep(), this.sweepIntervalSeconds * 1000);
        this.sweepTimer.unref?.();

        this.activityCacheTimer = setInterval(() => this.activityCache.clear(), this.cleanup.activityCacheLifetimeMinutes * 60 * 1000);
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
        const affected = this.indicators.sweep(Date.now() - this.cleanup.indicatorTtlSeconds * 1000);
        for (const conversationId of affected) this.subscriptions.broadcastIndicators(conversationId);
    }

    private async runDaily(): Promise<void> {
        const now = Date.now();
        if (this.cleanup.messageAfterDays && this.cleanup.messageAfterDays > 0) {
            const handler = getHandler(this.handlers, "deleteMessagesBefore");
            try { await handler(new Date(now - this.cleanup.messageAfterDays * ONE_DAY_MS)); }
            catch (error) { logError("deleteMessagesBefore", error); }
        }
        if (this.cleanup.conversationAfterInactiveDays && this.cleanup.conversationAfterInactiveDays > 0) {
            const handler = getHandler(this.handlers, "deleteInactiveConversationsBefore");
            try { await handler(new Date(now - this.cleanup.conversationAfterInactiveDays * ONE_DAY_MS)); }
            catch (error) { logError("deleteInactiveConversationsBefore", error); }
        }
        if (this.cleanup.inviteAfterDays && this.cleanup.inviteAfterDays > 0) {
            const handler = getHandler(this.handlers, "deleteInvitesBefore");
            try { await handler(new Date(now - this.cleanup.inviteAfterDays * ONE_DAY_MS)); }
            catch (error) { logError("deleteInvitesBefore", error); }
        }
    }
}