type RateLimitOptions = {
    inviteLimit1d?: number,
    inviteLimit1h?: number,
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