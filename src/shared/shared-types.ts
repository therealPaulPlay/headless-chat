export type Conversation = {
    conversationId: string,
    participants: string[],
    createdAt: Date,
    lastActivityAt: Date,
    lastMessage: Message | null,
    participantActivity: ParticipantActivity,
}

export type Message = {
    messageId: string,
    conversationId: string,
    message: string,
    messageOptions: MessageOptions,
    participantId: string,
    reactions: Reaction[],
    deleted: boolean,
    createdAt: Date,
    modifiedAt: Date | null,
}

export type MessageOptions = {
    referenceMessageId: string | null,
}

export type Indicator = {
    indicatorId: string,
    participantId: string,
    conversationId: string,
    createdAt: Date,
}

export type Reaction = {
    reactionId: string,
    messageId: string,
    participantId: string,
    content: string,
    createdAt: Date,
}

export type Invite = {
    inviteId: string,
    fromParticipantId: string,
    toParticipantId: string,
    conversation: Conversation,
    createdAt: Date,
}

export type ParticipantActivity = {
    conversationId: string,
    participantId: string,
    lastReadMessageId: string | null,
    lastReadMessageCreatedAt: Date | null,
}

export type Alias = {
    participantId: string,
    alias: string,
}