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

    delete(conversationId: string, participantId: string): void {
        const inner = this.byConversation.get(conversationId);
        if (!inner) return;
        inner.delete(participantId);
        if (inner.size === 0) this.byConversation.delete(conversationId);
    }

    list(conversationId: string): Indicator[] {
        const inner = this.byConversation.get(conversationId);
        if (!inner) return [];
        return [...inner].map(([participantId, ts]) => ({ conversationId, participantId, createdAt: new Date(ts) }));
    }

    sweep(thresholdMs: number): void {
        for (const [conversationId, inner] of this.byConversation) {
            for (const [participantId, ts] of inner) {
                if (ts < thresholdMs) inner.delete(participantId);
            }
            if (inner.size === 0) this.byConversation.delete(conversationId);
        }
    }
}
