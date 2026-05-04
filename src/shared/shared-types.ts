export type ConversationRecord = {
    conversationId: string,
    createdAt: Date,
    lastActivityAt: Date,
    maxSize: number | null,
}

export type Conversation = ConversationRecord & {
    participantIds: string[],
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
    type: "participantJoined" | "participantLeft" | "messagesRemoved",
    participantId?: string, // The participant the event is about (only present if it is about one, e.g. who joined / left)
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
    lastReadMessageId: string,
    lastReadMessageCreatedAt: Date,
}

export type Alias = {
    participantId: string,
    alias: string,
}
