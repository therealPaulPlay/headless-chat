import type { ResolvedRateLimits } from "./server-types.js";

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_SECOND_MS = 1000;

class ParticipantRateState {
    invites: number[] = [];
    messages: number[] = [];

    isEmpty(): boolean {
        // Whether any data is stored in the participant (typically used after pruning)
        return this.invites.length === 0 && this.messages.length === 0;
    }

    prune(now: number): void {
        const inviteCutoff = now - ONE_HOUR_MS;
        const messageCutoff = now - ONE_SECOND_MS;

        // If there are invite rate limit entries and the oldest one is older than the cutoff, clean up all expired ones
        if (this.invites.length > 0 && (this.invites[0] as number) <= inviteCutoff) {
            this.invites = this.invites.filter(t => t > inviteCutoff);
        }

        // If there are message rate limit entries and the oldest one is older than the cutoff, clean up all expired ones
        if (this.messages.length > 0 && (this.messages[0] as number) <= messageCutoff) {
            this.messages = this.messages.filter(t => t > messageCutoff);
        }
    }
}

export class RateLimiter {
    private states = new Map<string, ParticipantRateState>();

    constructor(private limits: ResolvedRateLimits) { }

    private get(participantId: string): ParticipantRateState {
        let state = this.states.get(participantId);
        if (!state) { state = new ParticipantRateState(); this.states.set(participantId, state); }
        return state;
    }

    trackInvite(participantId: string): void {
        const state = this.get(participantId); // Get state instance
        const now = Date.now();
        state.prune(now); // Prune it
        if (state.invites.length >= this.limits.inviteLimitPerParticipantPerHour) throw new Error("Invite hourly rate limit exceeded");
        state.invites.push(now); // Track entry
    }

    trackMessage(participantId: string): void {
        const state = this.get(participantId); // Get state instance
        const now = Date.now();
        state.prune(now); // Prune it
        if (state.messages.length >= this.limits.messageLimitPerParticipantPerSecond) throw new Error("Message rate limit exceeded");
        state.messages.push(now); // Track entry
    }

    sweep(): void {
        // Prune all states and delete instances that are fully empty on a schedule
        const now = Date.now();
        for (const [id, state] of this.states) {
            state.prune(now);
            if (state.isEmpty()) this.states.delete(id);
        }
    }
}
