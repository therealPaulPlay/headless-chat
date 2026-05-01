import type {
    Conversation,
    ConversationRecord,
    Message,
    Indicator,
    Reaction,
    Invite,
    ParticipantActivity,
    Alias,
} from "../shared/shared-types.js";

export type ServerDispatch = (participantId: string, data: unknown) => void;

export type RateLimitOptions = {
    inviteLimitPerHour?: number,
    messageLimitPerSecond?: number,
    conversationParticipantLimit?: number,
    sweepIntervalSeconds?: number,
}

export type CleanupOptions = {
    indicatorCleanupIntervalSeconds?: number,
    messageAfterDays?: number | null,
    conversationAfterInactiveDays?: number | null,
    inviteAfterDays?: number | null,
    activityCacheLifetimeMinutes?: number,
}

export type ResolvedRateLimits = {
    inviteLimitPerHour: number,
    messageLimitPerSecond: number,
    conversationParticipantLimit: number,
    sweepIntervalSeconds: number,
}

export type ResolvedCleanup = {
    indicatorCleanupIntervalSeconds: number,
    messageAfterDays: number | null,
    conversationAfterInactiveDays: number | null,
    inviteAfterDays: number | null,
    activityCacheLifetimeMinutes: number,
}

export type Handler<Args extends unknown[], R> = (...args: Args) => R | Promise<R>;

export type Handlers = {
    createConversation?: Handler<[ConversationRecord, string], void>,
    createMessage?: Handler<[Message], void>,
    createReaction?: Handler<[Reaction], void>,
    createInvite?: Handler<[Invite], void>,
    createIndicator?: Handler<[Indicator], void>,
    createConversationParticipantActivity?: Handler<[ParticipantActivity], void>,

    readConversations?: Handler<[string], Conversation[]>,
    readMessages?: Handler<[string, string | null, boolean, number], { messages: Message[], remainingInDirection: number }>,
    readInvites?: Handler<[string], Invite[]>,
    readAliases?: Handler<[string[]], Alias[]>,
    readIndicators?: Handler<[string], Indicator[]>,
    readConversationParticipantActivity?: Handler<[string, string], ParticipantActivity | null>,
    readParticipantActivities?: Handler<[string], ParticipantActivity[]>,
    readMessage?: Handler<[string], Message | null>,
    readConversation?: Handler<[string], Conversation | null>,
    readInvite?: Handler<[string, string], Invite | null>,
    readReaction?: Handler<[string], Reaction | null>,

    addConversationParticipant?: Handler<[string, string, number], void>,
    removeConversationParticipant?: Handler<[string, string], void>,
    updateMessage?: Handler<[Message], void>,
    updateConversationParticipantActivity?: Handler<[ParticipantActivity], void>,

    deleteReaction?: Handler<[string], void>,
    deleteConversationWithMessagesAndReactions?: Handler<[string], void>,
    deleteInvites?: Handler<[{ conversationId: string, toParticipantId: string }[]], void>,
    deleteIndicatorsBefore?: Handler<[Date], void>,
    deleteIndicator?: Handler<[string, string], void>,
    deleteConversationParticipantActivities?: Handler<[string[], string[]], void>,
    deleteMessagesBefore?: Handler<[Date], void>,
    deleteInactiveConversationsBefore?: Handler<[Date], void>,
    deleteInvitesBefore?: Handler<[Date], void>,

    participantAuth?: Handler<[string, unknown], boolean>,
    inviteAuth?: Handler<[string, string], boolean>,
    profanityCheckCensor?: Handler<[string], string>,
    profanityCheckBlock?: Handler<[string], boolean>,

    // After hooks (run after the RPC's response is sent off as the last step)
    afterMessageCreated?: Handler<[Message], void>,
    afterMessageDeleted?: Handler<[Message], void>,
    afterParticipantJoined?: Handler<[string, string], void>,
    afterParticipantLeft?: Handler<[string, string], void>,
    afterInviteCreated?: Handler<[Invite], void>,
    afterInviteDeleted?: Handler<[string, string, string], void>,
    afterConversationCreated?: Handler<[Conversation], void>,
    afterConversationDeleted?: Handler<[string], void>,
}

export function getHandler<K extends keyof Handlers>(handlers: Handlers, name: K): NonNullable<Handlers[K]> {
    const fn = handlers[name];
    if (!fn) throw new Error(`Handler not registered: ${String(name)}`);
    return fn as NonNullable<Handlers[K]>;
}
