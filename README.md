# headless-chat

Slightly opinionated core chat logic. No database implementation, no transport implementation, and no UI – you are responsible for wiring it up. Use this if you need...

- A simple API
- Chat logic that works like you'd expect
- Something that works with your DB
- Freedom to choose your protocol (WS & SSE recommended)
- Sanitization handled for you

#### Limitations

- Assumes sane conversation and invite amounts (since they are not paginated)
- No message search
- No rate limiting, bring your own

## Client API

Constructor: `new Client(dispatch: ClientDispatch, participantId: string, getAuthData: GetAuthData)`

#### ClientDispatch

A function that takes `data: Uint8Array` and sends it to the server, where it is passed to the server's `receive()` method. Can use a realtime protocol, but also works with HTTP requests. Uses `MessagePack` under the hood.

#### GetAuthData

A function that takes no parameters and returns `customAuthData: any` that is sent to the server and used inside `onParticipantAuth` to verify that this participant is authorized as the provided participant ID.

### Methods

**Transport:**
| Method | Returns | Description |
| ------ | ----------- | ----------- |
| receive(data: Uint8Array) | - | Call with data received by the server. |

**Conversations:**
| Method | Returns | Description |
| ------ | ----------- | ----------- |
| async createConversation(maxSize?: number) | conversationId: string | Create a conversation optionally with a maximum size (automatically enforced). |
| async createInvite(conversationId: string, participantId: string) | inviteId: string | Invite a participant to a conversation. Dedup is automatically handled by the server. |
| async revokeInvite(inviteId: string) | - | Revoke an invitation. |
| async acceptInvite(conversationId: string) | - | Join a conversation from an invite. Deletes all invites for that conversation for this participant. |
| async declineInvite(conversationId: string) | - | Decline and delete all invites for a conversation. |
| async leaveConversation(conversationId: string) | - | Leave a conversation. The conversation will be deleted when all participants have left. |
| async setIndicator(conversationId: string) | indicatorId: string | Set the typing indicator. Has a TTL of 3 seconds, setting every two seconds to avoid gaps/flicker is suggested. |
| async removeIndicator(conversationId: string) | - | Remove the typing indicator. Automatically, synchronously called when sending a message. |

**Messages:**
| Method | Returns | Description |
| ------ | ----------- | ----------- |
| async sendMessage(conversationId: string, message: string, options: MessageOptions) | messageId: string | Send a message. |
| async editMessage(conversationId: string, messageId: string, message: string, options: MessageOptions) | - | Edit a message. |
| async deleteMessage(messageId: string) | - | Delete a message. |
| async addReaction(messageId: string, reaction: string) | reactionId: string | Add a reaction (valid unicode emoji) to a message. Dedup is automatically handled by the server. |
| async removeReaction(reactionId: string) | - | Remove a reaction from a message. |

**Getters:**
| Method | Returns | Description |
| ------ | ----------- | ----------- |
| async getConversations(participantId: string) | conversations: Conversation[] | Get all conversations the participant is in. |
| async getMessages(conversationId: string, cursorMessageId: `string | null`, after: boolean, amount: number) | { messages: Message[], remainingInDirection: number } | Get messages in a paginated way where one message serves as the cursor and you can get `amount` messages from before or after it. If the cursor is null, the newest messages will be returned. |
| async getInvites(participantId: string) | invites: Invite[]| Get all invites, both for you and by you. |
| async getAliases([participantId: string, participantId...]) | aliases: Alias[] | Get server-defined aliases for participants. This serves as a simple lookup for your server-defined username system. |

> [!NOTE]
> Errors thrown by handlers will be suppressed.

**Events:**
| Method | Calls with | Description |
| ------ | ----------- | ----------- |
| onMessage(conversationId: string, handler: function) | message: Message | Subscribe to messages from a conversation. Note that this also fires for already existing messages when they are updated (e.g. with new reactions) or marked as deleted. |
| offMessage(handler: function) | - | Unsubscribe a handler. |
| onIndicators(conversationId: string, handler: function) | indicators: Indicator[] | Subscribe to typing indicators for a conversation. |
| offIndicators(handler: function) | - | Unsubscribe a handler. |
| onConversations(handler: function) | conversations: Conversation[] | Subscribe to receive updates when conversations are created, modified or deleted. |
| offConversations(handler: function) | - | Unsubscribe a handler. |
| onInvites(handler: function) | invites: Invite[] | Subscribe to receive new invites and updates or deletions of existing ones. |
| offInvites(handler: function) | - | Unsubscribe a handler. |
| onError(handler: function) | error: string | Subscribe to server-originated errors (e.g. failed to send message). |
| offError(handler: function) | - | Unsubscribe a handler. |

## Server API

Constructor: `new Server(dispatch: ServerDispatch, indicatorCleanupInterval: number)`

#### ServerDispatch

A function that takes `data: Uint8Array` and pushes it to the client, where it is passed to the client's `receive()` method. Recommended to be used with SSE or WS, but is protocol agnostic. Uses `MessagePack` under the hood.

### Methods

> [!TIP]
> Handlers can, and should, throw an error if something goes wrong. The error will be sent to the client and can be displayed via `onError`.

**Transport:**
| Method | Returns | Description |
| ------ | ----------- | ----------- |
| receive(data: Uint8Array) | - | Call with data received by the client. |

**Admin:**
| Method | Returns | Description |
| ------ | ----------- | ----------- |
| deleteParticipant(participantId: string) | - | When a user is deleted in your backend, call this method. It will remove the participant from all conversations. Note that messages will continue to exist which is intended. You can show them as "from deleted user" or whatever you return for the alias. |

**Create handlers:**
| Method | Calls with | Expected return value | Description |
| ------ | ---------- | --------------------- | ------------|
| onCreateConversation(handler: function) | conversation: Conversation | - | Should create the provided conversation in the database. |
| onCreateMessage(handler: function) | message: Message | - | Should create the provided message in the database. |
| onCreateReaction(handler: function) | reaction: Reaction | - | Should create the provided reaction in the database. After the handler completes, the library re-reads the message and fires `onMessage` to subscribers. |
| onCreateInvite(handler: function) | invite: Invite | - | Should create the provided invite in the database. |
| onCreateIndicator(handler: function) | indicator: Indicator | - | Should create or re-create (if one already exists) a typing indicator. |
| onCreateConversationParticipantActivity(handler: function) | participantActivity: ParticipantActivity | - | Should create a participant activity entry in the database. |

**Read handlers:**
| Method | Calls with | Expected return value | Description |
| ------ | ---------- | --------------------- | ------------|
| onReadConversations(handler: function) | participantId: string | conversations: Conversation[] | Should return all conversations from the database that a given participant takes part in and include both the participant activity as well as the last message using a three-way database join. |
| onReadMessages(handler: function) | conversationId: string, cursorMessageId: string, after: boolean, amount: number | { messages: Message[], remainingInDirection: number } | Should return an array of messages from the database matching the pagination parameters. With `after` set to true, `cursorMessageId` should be excluded, whereas with after set to false, it should be included. The library creates or updates the participant activity if a message newer than the one specified in `lastReadMessageCreatedAt` (cached at runtime) is fetched.
| onReadInvites(handler: function) | participantId: string | invites: Invite[] | Should return all invites created by or created for the provided participant. |
| onReadAliases(handler: function) | participants: string[] | aliases: Alias[] | Should return all aliases for the provided participant IDs. In a simple implementation, this can look up the usernames from an existing users table. |
| onReadIndicators(handler: function) | conversationId: string | indicators: Indicator[] | Should return all typing indicators for a conversation. |
| onReadConversationParticipantActivity(handler: function) | conversationId: string, participantId: string | `participantActivity: ParticipantActivity | null` | Should return the participant activity from the database or `null` if it does not exist. |

**Update handlers:**
| Method | Calls with | Expected return value | Description |
| ------ | ---------- | --------------------- | ------------|
| onUpdateConversation(handler: function) | conversation: Conversation | - | Should update the provided conversation in the database. |
| onUpdateMessage(handler: function) | message: Message | - | Should update the provided message in the database. The `modifiedAt` field is automatically adjusted by the library if the update is an edit. Existing reactions are preserved across edits. |
| onUpdateConversationParticipantActivity(handler: function) | participantActivity: ParticipantActivity | - | Should update the provided participant activity in the database. |

**Delete handlers:**
| Method | Calls with | Expected return value | Description |
| ------ | ---------- | --------------------- | ------------|
| onDeleteMessageWithReactions(handler: function) | messageId: string | - | Should delete the specified message and all its reactions. Recommended to wrap in a single transaction: delete reactions by `messageId`, then delete the message by `messageId`. |
| onDeleteReaction(handler: function) | reactionId: string | - | Should delete the specified reaction in the database. After the handler completes, the library re-reads the message and fires `onMessage` to subscribers. |
| onDeleteConversationWithMessagesAndReactions(handler: function) | conversationId: string | - | Should delete the conversation, all its messages, and all reactions to those messages. Recommended to wrap in a single transaction with three statements: delete reactions joined to messages by `messageId` filtered by `conversationId`, then delete messages by `conversationId`, then delete the conversation by `conversationId`. |
| onDeleteInvites(handler: function) | inviteIds: string[] | - | Should delete the provided invites in the database. |
| onDeleteExpiredIndicators(handler: function) | - | - | Should delete all entries older than 3s, measured by the `createdAt` field. The library calls this every `indicatorCleanupInterval` seconds. |
| onDeleteIndicator(handler: function) | indicatorId: string | - | Should delete the specific indicator. |
| onDeleteConversationParticipantActivities(handler: function) |  conversationIds: string[], participantIds: string[] | - | Should delete all matching activities. Multiple participants are provided when a conversation gets deleted, multiple conversations are provided when a participant leaves (potentially through propagation of `deleteParticipant`). |

**Validation handlers:**
| Method | Calls with | Expected return value | Description |
| ------ | ---------- | --------------------- | ------------|
| onParticipantAuth(handler: function) | participantId: string, customAuthData: any | allow: boolean | Integrate a simple auth check. |
| onProfanityCheckCensor(handler: function) (optional) | message: string | censoredMessage: string | Normal profanity check where profane words are censored. |
| onProfanityCheckBlock(handler: function) (optional) | message: string | allow: boolean | Strict profanity check where messages that contain profanity are rejected. |

### Suggested database tables

The `hc` prefix stands for headless-chat. It's suggested to use the following tables:
`hc_conversations`, `hc_participant_activities`, `hc_messages`, `hc_indicators`, `hc_reactions`, `hc_invites` and, if aliases are configurable, `hc_aliases`. Ensure proper indexing.

> [!NOTE]
> `onReadMessages` is expected to return messages with their `reactions` array already populated. A single join query against `hc_messages` and `hc_reactions` per page is the recommended approach – avoid per-message lookups.

The server API does not provide any scaffolding for cleaning up or otherwise modifying conversations, invites and messages without user-intent. However, such functions can be added manually since the database is a concern of the library's consumer.

All IDs are defined as strings so that you can integrate it in any existing schema. The library will pass UUIDs to the handlers, but your participant ID can also be a stringified incrementing number - it's defined as a string to ensure UUIDs work too.

## Shared types

#### Conversation

```ts
{
    conversationId: string,
    participants: string[], // Participant IDs
    createdAt: Date,
    lastActivityAt: Date, // Conversations are usually ordered by this; not participant specific
    lastMessage: Message | null, // Can be null if the conversation has no messages yet
    participantActivity: ParticipantActivity, // Participant-specific
}
```

#### Message

```ts
{
    messageId: string,
    conversationId: string,
    message: string,
    messageOptions: MessageOptions,
    participantId: string, // The participant that sent this message
    reactions: Reaction[],
    deleted: boolean,
    createdAt: Date,
    modifiedAt: Date | null,
}
```

#### MessageOptions

```ts
{
    referenceMessageId: string | null // Reply to a message referenced by a message ID
    isForwarded: boolean // Whether to display a message as 'forwarded'
}
```

#### Indicator

```ts
{
    indicatorId: string,
    participantId: string,
    conversationId: string,
    createdAt: Date,
}
```

#### Reaction

```ts
{
    reactionId: string,
    messageId: string,
    participantId: string, // The participant who reacted
    content: string, // Valid unicode emoji
    createdAt: Date,
}
```

#### Invite

```ts
{
    inviteId: string,
    fromParticipantId: string, // The participant who sent the invitation
    toParticipantId: string, // The participant who is invited
    conversation: Conversation,
    createdAt: Date,
}
```

#### ParticipantActivity

```ts
{
    conversationId: string, // The conversationId + participantId should be unique in the database (unique index)
    participantId: string,
    lastReadMessageId: string | null, // Can be null if the participant has not read any messages yet
    lastReadMessageCreatedAt: Date | null, // Creation date of the message (not read date)
}
```

#### Alias

Since different participants might have different aliases for participants, clients should get the corresponding alias once for each new participant. 
This avoids looking up the alias for each participant for every participant a message is fanned-out to, which would put heavy load on a database.

```ts
{
    participantId: string,
    alias: string,
}
```