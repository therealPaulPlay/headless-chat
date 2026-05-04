import type { Indicator } from "../shared/shared-types.js";

// Typing indicators are ephemeral and live entirely in memory, no DB roundtrips
export class IndicatorStore {
    // conversationId -> participantId -> createdAt (ms since epoch)
    private byConversation = new Map<string, Map<string, number>>();

    set(conversationId: string, participantId: string, createdAt: Date): void {
        let inner = this.byConversation.get(conversationId);
        if (!inner) { inner = new Map(); this.byConversation.set(conversationId, inner); }
        inner.set(participantId, createdAt.getTime());
    }

    // Returns whether an entry was actually removed
    delete(conversationId: string, participantId: string): boolean {
        const inner = this.byConversation.get(conversationId);
        if (!inner?.has(participantId)) return false;
        inner.delete(participantId);
        if (inner.size === 0) this.byConversation.delete(conversationId);
        return true;
    }

    list(conversationId: string): Indicator[] {
        const inner = this.byConversation.get(conversationId);
        if (!inner) return [];
        return [...inner].map(([participantId, ts]) => ({ conversationId, participantId, createdAt: new Date(ts) }));
    }

    // Returns the conversationIds that had at least one entry removed so the caller can re-broadcast their indicators
    sweep(thresholdMs: number): string[] {
        const affected: string[] = [];
        for (const [conversationId, inner] of this.byConversation) {
            let removed = false;
            for (const [participantId, ts] of inner) {
                if (ts < thresholdMs) { inner.delete(participantId); removed = true; }
            }
            if (removed) affected.push(conversationId);
            if (inner.size === 0) this.byConversation.delete(conversationId);
        }
        return affected;
    }
}
