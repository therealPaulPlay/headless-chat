# headless-chat

Slightly opinionated core chat logic. No database implementation, no transport implementation, and no UI – you are responsible for wiring it up. Use this if you need...

- A simple API
- Chat logic that works like you'd expect
- Something that works with your DB
- Freedom to choose your protocol (WS & SSE recommended)
- Sanitization handled for you

#### Limitations

- No read by / latest read message implementation, bring your own if needed
- Assumes sane conversation and invite amounts (since they are not paginated)
- No message search

## Client API

Constructor: `new Client(participantId: string, writeFn: ClientWriteFunction, authFn: ClientAuthFunction)`

#### ClientWriteFunction

A function that takes `data: Uint8Array` and sends it to the server, where it is passed to the server's `receive()` method. Can use a realtime protocol, but also works with HTTP requests. Uses `MessagePack` under the hood.

#### ClientAuthFunction

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
| async getMessages(conversationId: string, cursorMessageId: string | null, after: boolean, amount: number) | { messages: Message[], remainingInDirection: number } | Get messages in a paginated way where one message serves as the cursor and you can get `amount` messages from before or after it. If the cursor is null, the newest messages will be returned. |
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

### Client types

#### MessageOptions

```ts
{
    reference: string | null // Reply to a message referenced by a message ID
    isForwarded: boolean // Whether to display a message as 'forwarded'
}
```

## Server API

Constructor: `new Server(writeFn: ServerWriteFunction, indicatorCleanupInterval: number)`

#### ServerWriteFunction

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
| onCreateIndicator(handler: function) | indicator: Indicator | - | Should create or re-create (if already existent) a typing indicator. |

**Read handlers:**
| Method | Calls with | Expected return value | Description |
| ------ | ---------- | --------------------- | ------------|
| onReadConversations(handler: function) | participantId: string | conversations: Conversation[] | Should return all conversations from the database that a given participant takes part in. |
| onReadMessages(handler: function) | conversationId: string, cursorMessageId: string, after: boolean, amount: number | { messages: Message[], remainingInDirection: number } | Should return an array of messages from the database matching the pagination parameters. With after set to true, `cursorMessageId` should be excluded, whereas with after set to false, it should be included. This is so that there's a way to look up just one message (in case it changed).
| onReadInvites(handler: function) | participantId: string | invites: Invite[] | Should return all invites created by or created for the provided participant. |
| onReadAliases(handler: function) | participants: string[] | aliases: Alias[] | Should return all aliases for the provided participant IDs. In a simple implementation, this can look up the usernames from an existing users table. |
| onReadIndicators(handler: function) | conversationId: string | indicators: Indicator[] | Should return all typing indicators for a conversation. |

**Update handlers:**
| Method | Calls with | Expected return value | Description |
| ------ | ---------- | --------------------- | ------------|
| onUpdateConversation(handler: function) | conversation: Conversation | - | Should update the provided conversation in the database. |
| onUpdateMessage(handler: function) | message: Message | - | Should update the provided message in the database. The `modifiedAt` field is automatically adjusted by the library if the update is an edit. |

**Delete handlers:**
| Method | Calls with | Expected return value | Description |
| ------ | ---------- | --------------------- | ------------|
| onDeleteConversation(handler: function) | conversationId: string | - | Should delete the specified conversation in the database. |
| onDeleteMessage(handler: function) | messageId: string | - | Should delete the specified message in the database. |
| onDeleteReaction(handler: function) | reactionId: string | - | Should delete the specified reaction in the database. After the handler completes, the library re-reads the message and fires `onMessage` to subscribers. |
| onDeleteInvites(handler: function) | invites: Invite[] | - | Should delete the provided invites in the database. |
| onDeleteExpiredIndicators(handler: function) | - | - | Should delete all entries older than 3s, measured by the `createdAt` field. The library calls this every `indicatorCleanupInterval` seconds. |
| onDeleteIndicator(handler: function) | indicatorId: string | - | Should delete the specific indicator. |

**Validation handlers:**
| Method | Calls with | Expected return value | Description |
| ------ | ---------- | --------------------- | ------------|
| onParticipantAuth(handler: function) | participantId: string, customAuthData: any | allow: boolean | Integrate a simple auth check. |
| onProfanityCheckCensor(handler: function) (optional) | message: string | censoredMessage: string | Normal profanity check where profane words are censored. |
| onProfanityCheckBlock(handler: function) (optional) | message: string | allow: boolean | Strict profanity check where messages that contain profanity are rejected. |

### Suggested database tables

The `hc` prefix stands for headless-chat. It's suggested to use the following tables:
`hc_conversations` `hc_messages`, `hc_indicators`, `hc_reactions`, `hc_invites` and, if aliases are configurable, `hc_aliases`. Ensure proper indexing.

It's suggested that messages have a foreign key to the referenced conversations entry with deletion propagation, and that reactions have a foreign key to the referenced messages entry with deletion propagation.

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
    lastActivityAt: Date, // Conversations are usually ordered by this
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
    forParticipantId: string, // The participant who is invited
    conversation: Conversation,
    createdAt: Date,
}
```

#### Alias

Since different participants might have different aliases for participants, clients should get the corresponding alias once for each new participant. This avoids looking up the alias for each participant for every participant a message is fanned-out to, which would put heavy load on a database.

```ts
{
    participantId: string,
    alias: string,
}
```