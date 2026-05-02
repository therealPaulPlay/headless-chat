# headless-chat

Slightly opinionated core chat logic. No database implementation, no transport implementation, and no UI – you are responsible for wiring it up. Use this if you need...

- A simple to integrate API
- Robust chat logic with reactions, replies, typing indicators & more
- Something that works with your own DB
- Freedom to choose your protocol (WS & SSE recommended)

#### Limitations

- Assumes sane conversation and invite amounts (they are not paginated)
- No message search, bring your own if needed
- No transport-level rate limiting, bring your own
- No string sanitization built-in

## Install

```bash
npm install headless-chat
```

## Client API

Constructor: `new Client(dispatch: ClientDispatch, participantId: string, getAuthData: GetAuthData)`

#### ClientDispatch

A function that takes `data: unknown` (a plain object) and sends it to the server, where it is passed to the server's `receive()` method. Encoding is the consumer's choice (JSON, MessagePack etc., as you choose). Can use a realtime protocol, but also works with HTTP requests.

#### GetAuthData

A function that takes no parameters and returns `authData: unknown` that is sent to the server and used inside `onParticipantAuth` to verify that this participant is authorized as the provided participant ID.

### Methods

**Transport:**
| Method | Returns | Description |
| ------ | ----------- | ----------- |
| receive(data: unknown) | - | Call with the decoded object received from the server. |
| dispose() | - | Reject all in-flight RPC promises and clear local handler state. Call when discarding the instance (e.g. on account switch) so awaiting code doesn't hang. |

**Conversations:**
| Method | Returns | Description |
| ------ | ----------- | ----------- |
| async createConversation(maxSize?: number) | conversationId: string | Create a conversation optionally with a maximum size (automatically enforced). |
| async createInvite(conversationId: string, participantId: string) | - | Invite a participant to a conversation. Deduplication is automatically handled by the server. |
| async revokeInvite(conversationId: string, toParticipantId: string) | - | Revoke an invitation. |
| async acceptInvite(conversationId: string) | - | Join a conversation from an invite. Deletes all invites for that conversation for this participant. |
| async declineInvite(conversationId: string) | - | Decline and delete all invites for a conversation. |
| async leaveConversation(conversationId: string) | - | Leave a conversation. The conversation will be deleted when all participants have left. |
| async setIndicator(conversationId: string) | - | Set the typing indicator. Has a TTL of `indicatorTtlSeconds` (default 3s), set every X-1 seconds to avoid gaps/flicker. |
| async removeIndicator(conversationId: string) | - | Remove the typing indicator. Automatically, synchronously called when sending a message. |

**Messages:**
| Method | Returns | Description |
| ------ | ----------- | ----------- |
| async sendMessage(conversationId: string, message: string, options?: MessageOptions) | messageId: string | Send a message. |
| async editMessage(messageId: string, message: string) | - | Edit a message's text. |
| async deleteMessage(messageId: string) | - | Delete a message. |
| async addReaction(messageId: string, reaction: string) | reactionId: string | Add a reaction (valid unicode emoji) to a message. Deduplication is automatically handled by the server, participants can only add one. |
| async removeReaction(reactionId: string) | - | Remove a reaction from a message. |

**Getters:**
| Method | Returns | Description |
| ------ | ----------- | ----------- |
| async getConversations(participantId: string) | conversations: Conversation[] | Get all conversations the participant is in. |
| async getMessages(conversationId: string, cursorMessageId: string \| null, after: boolean, amount: number) | { messages: Message[], remainingInDirection: number } | Get up to `amount` messages strictly newer (`after: true`) or strictly older (`after: false`) than the cursor. The cursor message itself is never included. A null cursor returns the newest page. |
| async getInvites(participantId: string) | invites: Invite[]| Get all invites, both for you and by you. |
| async getAliases([participantId: string, participantId...]) | aliases: Alias[] | Get server-defined aliases for participants. This serves as a simple lookup for your server-defined username system. |
| async getParticipantActivities() | activities: ParticipantActivity[] | Get the calling participant's read state across all their conversations. Used to derive unread counts client-side. |

Event methods are async because subscribing and unsubscribing roundtrip to the server, so events may take a brief moment to start or stop arriving. Calling the same `on*` method twice for the same scope is allowed (e.g. to listen in two different places).

> [!IMPORTANT]
> When the underlying transport disconnects and reconnects, you should re-subscribe to all relevant events and re-fetch state via the appropriate getters (e.g. `getConversations`, `getMessages`). Subscribe before fetching to avoid missing events that arrive between the two calls. Also call `cleanupParticipant` on the server side for participants whose transport has dropped, so the server stops attempting to push to them.

**Events:**
| Method | Calls with | Description |
| ------ | ----------- | ----------- |
| async onMessage(conversationId: string, handler: function) | message: Message | Subscribe to messages from a conversation. Note that this also fires for already existing messages when they are updated (e.g. with new reactions) or marked as deleted. |
| async offMessage(handler: function) | - | Unsubscribe a handler. |
| async onIndicators(conversationId: string, handler: function) | indicators: Indicator[] | Subscribe to typing indicators for a conversation. |
| async offIndicators(handler: function) | - | Unsubscribe a handler. |
| async onConversation(handler: function) | event: { conversationId: string, data: Conversation \| null } | Subscribe to per-conversation updates. `data: null` means the conversation was deleted. |
| async offConversation(handler: function) | - | Unsubscribe a handler. |
| async onInvite(handler: function) | event: { conversationId: string, toParticipantId: string, data: Invite \| null } | Subscribe to per-invite updates. `data: null` means the invite was deleted. |
| async offInvite(handler: function) | - | Unsubscribe a handler. |

## Server API

Constructor: `new Server(dispatch: ServerDispatch, rateLimits?: RateLimitOptions, cleanup?: CleanupOptions)`

#### ServerDispatch

A function that takes `data: unknown` (a plain object) and pushes it to the client, where it is passed to the client's `receive()` method. Encoding is the consumer's choice. Recommended to be used with SSE or WS, but is protocol agnostic.

#### RateLimitOptions

An object that configures the rate limiting of key actions the library handles.

```ts
{
    inviteLimitPerHour?: number, // Defaults to 10
    messageLimitPerSecond?: number, // Defaults to 5
    conversationParticipantLimit?: number, // Defaults to 100, acts as the hard global limit that takes precedence over maxSize
    sweepIntervalSeconds?: number, // Defaults to 30, sweep that prunes per-participant rate limit state
}
```

#### CleanupOptions

An object that configures the automated cleanup. Cleanup measured in days runs once per day. Treats values <= 0 as invalid.

```ts
{
    indicatorTtlSeconds?: number, // Defaults to 3, indicators older than this get swept
    indicatorCleanupIntervalSeconds?: number, // Defaults to 5, how often the sweep runs
    messageAfterDays?: number, // Defaults to null = disabled
    conversationAfterInactiveDays?: number, // Defaults to null = disabled, inactive means no new messages have been sent
    inviteAfterDays?: number, // Defaults to 7, can be set to null = disabled
    activityCacheLifetimeMinutes?: number, // Period after which the participant-activity in-memory cache is (fully) cleared
}
```

### Methods

> [!TIP]
> Handlers can, and should, throw an error if something goes wrong. The error will reject the corresponding RPC promise on the client.

**Transport:**
| Method | Returns | Description |
| ------ | ----------- | ----------- |
| receive(data: unknown) | - | Call with the decoded object received from the client. |

**Admin:**
| Method | Returns | Description |
| ------ | ----------- | ----------- |
| deleteParticipant(participantId: string) | - | When a user is deleted in your backend, call this method after removing the user from your own table. Removes the participant from all conversations and deletes their invites while messages are kept around. |
| cleanupParticipant(participantId: string) | - | Drops all server-side subscriptions for the participant. Call this when your transport solution detects a disconnect (e.g. via its own ping/pong or close event) so the server stops attempting to dispatch to them. The participant can resubscribe normally on reconnect. |
| acceptInvite(conversationId: string, participantId: string) | - | Can be used for auto-accepting invites on behalf of participants, e.g. for participants that are already connected in your own system. |
| revokeInvite(conversationId: string, fromParticipantId: string, toParticipantId: string) | - | Server-side revoke that bypasses the ownership check the client-facing path applies. |
| joinConversation(conversationId: string, participantId: string) | - | Add a participant directly without an invite flow. |
| leaveConversation(conversationId: string, participantId: string) | - | Remove a participant from a conversation. |
| sendMessage(conversationId: string, participantId: string, message: string, options?: MessageOptions, systemEvent?: SystemEvent) | messageId: string | Send a message on behalf of a participant or post a system message. Bypasses validation. |
| stop() | - | Stop all internal timers (indicator cleanup, daily cleanup, rate-limit sweep). |

> [!IMPORTANT]
> Every handler listed below except the ones marked optional must be registered. The library calls them as required and will throw at runtime if any are missing.

**Create handlers:**
| Method | Calls with | Description |
| ------ | ---------- | ------------|
| onCreateConversation(handler: function) | conversation: ConversationRecord, creatorParticipantId: string | Should atomically (in a single transaction) insert the conversation row and add `creatorParticipantId` as the first participant. |
| onCreateMessage(handler: function) | message: Message | Should create the provided message in the database. Guard the insert with a participation check so a participant who concurrently left cannot post, except when `participantId === "server"`, which is the reserved sentinel for library-authored system messages and must always be allowed. |
| onCreateReaction(handler: function) | reaction: Reaction | Should create the provided reaction in the database. Guard the insert with a participation check. After the handler completes, the library re-reads the message and fires `onMessage` to subscribers. |
| onCreateInvite(handler: function) | invite: Invite | Atomically insert the invite, deduplicating on `(conversationId, toParticipantId)` (no-op on conflict). If the recipient is already a participant of the conversation, throw. The insert must verify that both `fromParticipantId` and `toParticipantId` exist in your users table (or wherever the referenced account is stored). |
| onCreateConversationParticipantActivity(handler: function) | participantActivity: ParticipantActivity | Should create a participant activity entry in the database. Guard the insert with a participation check so activity is not created for participants who concurrently left the conversation. |

**Read handlers:**
| Method | Calls with | Expected return value | Description |
| ------ | ---------- | --------------------- | ------------|
| onReadConversations(handler: function) | participantId: string | conversations: Conversation[] | Should return all conversations from the database that a given participant takes part in, with `lastMessage` populated via a join, ordered by `lastActivityAt` descending. |
| onReadConversation(handler: function) | conversationId: string | conversation: Conversation \| null | Should return the conversation by ID with `lastMessage` populated, or `null` if it does not exist. |
| onReadMessages(handler: function) | conversationId: string, cursorMessageId: string, after: boolean, amount: number | { messages: Message[], remainingInDirection: number } | Should return an array of messages ordered by `createdAt` ascending, each with its `reactions` array populated. The cursor message is never included. With `after: true` return strictly newer, with `after: false` strictly older. The library creates or updates the participant activity if a message newer than the one specified in `lastReadMessageCreatedAt` (cached at runtime) is fetched.
| onReadMessage(handler: function) | messageId: string | message: Message \| null | Should return the message by ID with reactions populated, or null. |
| onReadReaction(handler: function) | reactionId: string | reaction: Reaction \| null | Should return the reaction by ID, or null. |
| onReadInvites(handler: function) | participantId: string | invites: Invite[] | Should return all invites created by or created for the provided participant, ordered by `createdAt` descending. |
| onReadInvite(handler: function) | conversationId: string, toParticipantId: string | invite: Invite \| null | Should return the invite for the pair, or null. |
| onReadAliases(handler: function) | participants: string[] | aliases: Alias[] | Should return all aliases for the provided participant IDs. In a simple implementation, this can look up the usernames from an existing users table. |
| onReadConversationParticipantActivity(handler: function) | conversationId: string, participantId: string | participantActivity: ParticipantActivity \| null | Should return the participant activity from the database or `null` if it does not exist. |
| onReadParticipantActivities(handler: function) | participantId: string | activities: ParticipantActivity[] | Should return all participant activity rows for the given participant. |

**Update handlers:**
| Method | Calls with | Description |
| ------ | ---------- | ------------|
| onAddConversationParticipant(handler: function) | conversationId: string, participantId: string, maxParticipants: number | Should atomically add the participant only if the current count is below `maxParticipants` and the participant is not already in the conversation. Throw if either condition fails, use a transaction. |
| onRemoveConversationParticipant(handler: function) | conversationId: string, participantId: string | Should atomically remove the participant. |
| onUpdateMessage(handler: function) | message: Message | Should update the provided message in the database. The `modifiedAt` field is automatically adjusted by the library if the update is an edit. Existing reactions are preserved across edits. |
| onUpdateConversationParticipantActivity(handler: function) | participantActivity: ParticipantActivity | Should update the provided participant activity in the database. Guard the update with a participation check so activity is not written back for participants who concurrently left the conversation. |

**Delete handlers:**
| Method | Calls with | Description |
| ------ | ---------- | ------------|
| onDeleteReaction(handler: function) | reactionId: string | Should delete the specified reaction in the database. After the handler completes, the library re-reads the message and fires `onMessage` to subscribers. |
| onDeleteConversationWithMessagesAndReactions(handler: function) | conversationId: string | Should delete the conversation, all its messages, and all reactions to those messages. Recommended to wrap in a single transaction with three statements: delete reactions joined to messages by `messageId` filtered by `conversationId`, then delete messages by `conversationId`, then delete the conversation by `conversationId`. |
| onDeleteInvites(handler: function) | invites: { conversationId: string, toParticipantId: string }[] | Should delete the provided invites in the database. |
| onDeleteConversationParticipantActivities(handler: function) |  conversationIds: string[], participantIds: string[] | Should delete all matching activities. Multiple participants are provided when a conversation gets deleted, multiple conversations are provided when a participant leaves (potentially through propagation of `deleteParticipant`). |
| onDeleteMessagesBefore(handler: function) | thresholdDate: Date | Should delete all messages whose `createdAt` is before `thresholdDate`, plus their reactions. |
| onDeleteInactiveConversationsBefore(handler: function) | thresholdDate: Date | Should delete all conversations whose `lastActivityAt` is before `thresholdDate`, plus their messages and reactions. |
| onDeleteInvitesBefore(handler: function) | thresholdDate: Date | Should delete all invites whose `createdAt` is before `thresholdDate`. |

**Validation handlers:**
| Method | Calls with | Expected return value | Description |
| ------ | ---------- | --------------------- | ------------|
| onParticipantAuth(handler: function) | participantId: string, authData: unknown | allow: boolean | Integrate a simple auth check. |
| onInviteAuth(handler: function) (optional) | fromParticipantId: string, toParticipantId: string | allow: boolean | Gate `createInvite` calls e.g. for blocked participants. Returning false rejects the invite. |
| onProfanityCheckCensor(handler: function) (optional) | message: string | censoredMessage: string | Normal profanity check where profane words are censored. Must return the (possibly censored) string and must not throw. |
| onProfanityCheckBlock(handler: function) (optional) | message: string | allow: boolean | Strict profanity check where messages that contain profanity are rejected. Must return a boolean and must not throw. |

**Hooks (all optional):**

Hooks fire after the underlying RPC response has been sent to the client (or after the admin call's awaited promise has resolved). Errors thrown inside them are caught by the library.

| Method | Calls with | Description |
| ------ | ---------- | ------------|
| onAfterMessageCreated(handler: function) | message: Message | Fires for both user-sent messages and server-authored system messages. |
| onAfterMessageDeleted(handler: function) | message: Message | Fires after a soft-delete; `message.deleted` is true. |
| onAfterParticipantJoined(handler: function) | conversationId: string, participantId: string | Fires after a participant is added (accept-invite or admin join). |
| onAfterParticipantLeft(handler: function) | conversationId: string, participantId: string | Fires after a participant is removed (leave or admin leave). Also fires when the last participant leaves and the conversation is then deleted. |
| onAfterInviteCreated(handler: function) | invite: Invite | Fires after a new invite is persisted. |
| onAfterInviteDeleted(handler: function) | conversationId: string, fromParticipantId: string, toParticipantId: string | Fires after an invite is deleted (revoke, accept, decline, or participant deletion cascade). |
| onAfterConversationCreated(handler: function) | conversation: Conversation | Fires after a conversation is persisted. |
| onAfterConversationDeleted(handler: function) | conversationId: string | Fires after the last participant leaves and the conversation is deleted. |

### Suggested database tables

The `hc` prefix stands for headless-chat. It's suggested to use the following tables:
`hc_conversations`, `hc_conversation_participants`, `hc_participant_activities`, `hc_messages`, `hc_reactions`, `hc_invites` and, if aliases are configurable, `hc_aliases`. Ensure proper indexing.

Participant IDs are strings and stringified numbers over UUIDs work fine.

## Shared types

#### ConversationRecord

The shape your DB stores and what `onCreateConversation` receives.

```ts
{
    conversationId: string,
    createdAt: Date,
    lastActivityAt: Date, // Conversations are usually ordered by this; not participant specific
    maxSize: number | null, // null = unbounded, but the global upper cap from rateLimits still applies
}
```

#### Conversation

The surfaced shape the client receives. `participants` is sourced from your junction table.

```ts
ConversationRecord & {
    participants: string[], // Participant IDs
    lastMessage: Message | null, // Can be null if the conversation has no messages yet
}
```

#### Message

```ts
{
    messageId: string,
    conversationId: string,
    message: string,
    messageOptions: MessageOptions,
    participantId: string, // The participant that sent this message, "server" for system messages
    reactions: Reaction[],
    deleted: boolean,
    systemEvent: SystemEvent | null,
    createdAt: Date,
    modifiedAt: Date | null,
}
```

#### SystemEvent

```ts
{
    type: "participantJoined" | "participantLeft",
    participantId: string,
}
```

#### MessageOptions

```ts
{
    referenceMessageId: string | null // Reply to a message referenced by a message ID
    isForwarded: boolean // Whether to display a message as 'forwarded'
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
    lastReadMessageId: string,
    lastReadMessageCreatedAt: Date, // Creation date of the message (not read date)
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