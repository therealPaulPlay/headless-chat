export type ConversationRecord = {
    conversationId: string,
    participants: string[],
    createdAt: Date,
    lastActivityAt: Date,
    maxSize: number | null,
}

export type Conversation = ConversationRecord & {
    lastMessage: Message | null,
}

export type Message = {
    messageId: string,
    conversationId: string,
    message: string,
    messageOptions: MessageOptions,
    participantId: string,
    reactions: Reaction[],
    deleted: boolean,
    systemEvent: SystemEvent | null,
    createdAt: Date,
    modifiedAt: Date | null,
}

export type MessageOptions = {
    referenceMessageId: string | null,
    isForwarded: boolean,
}

export type SystemEvent = {
    type: "participantJoined" | "participantLeft",
    participantId: string,
}

export type Indicator = {
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
