type RateLimitOptions = {
    inviteLimitPerDay?: number,
    inviteLimitPerHour?: number,
    messageLimitPerSecond?: number,
    conversationParticipantLimit?: number,
}

type CleanupOptions = {
    indicatorCleanupIntervalSeconds?: number,
    messageAfterDays?: number,
    conversationAfterInactiveDays?: number,
    inviteAfterDays?: number,
}

export class Server {
    constructor(dispatch: (data: Uint8Array) => void, rateLimit?: RateLimitOptions, cleanup?: CleanupOptions) {
        // WIP
    }

}