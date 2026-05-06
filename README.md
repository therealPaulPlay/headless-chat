# headless-chat

Slightly opinionated core chat logic. No database implementation, no transport implementation, and no UI – you are responsible for wiring it up. Use this if you need...

- A simple to integrate API
- Robust chat logic with reactions, replies, typing indicators & more
- Rigorous caching built-in
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

May be sync or return a `Promise<void>`. The library awaits the result, so a thrown error or a rejected promise propagates to the caller of the originating method (e.g. `await client.sendMessage(...)` rejects with the dispatch error).

#### GetAuthData

A function that takes no parameters and returns `authData: unknown` that is sent to the server and used inside `onParticipantAuth` to verify that this participant is authorized as the provided participant ID.

### Methods

**Transport:**
| Method | Returns | Description |
| ------ | ----------- | ----------- |
| receive(data: unknown) | - | Call with the decoded object received from the server. |
| dispose() | - | Reject all in-flight RPC promises, unsubscribe the server from every active scope (if still connected, otherwise cleanupParticipant needs to be called on the server), and clear local handler state. Call when discarding the instance. |

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
| async getConversations() | conversations: Conversation[] | Get all conversations the participant is in. |
| async getMessages(conversationId: string, cursorMessageId: string \| null, after: boolean, amount: number) | { messages: Message[], remainingInDirection: number } | Get up to `amount` messages strictly newer (`after: true`) or strictly older (`after: false`) than the cursor. The cursor message itself is never included. A null cursor returns the newest page. |
| async getMessagesByIds(messageIds: string[]) | messages: Message[] | Bulk-lookup messages by ID. Missing IDs are omitted. |
| async getInvites() | invites: Invite[]| Get all invites, both for the participant and by the participant. |
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
| async onParticipantActivity(handler: function) | event: { conversationId: string, data: ParticipantActivity \| null } | Subscribe to live updates of the calling participant's read state. `data: null` means the activity was deleted. |
| async offParticipantActivity(handler: function) | - | Unsubscribe a handler. |
| async onMany(entries: SubscriptionEntry[]) | - | Subscribe to multiple events, bundled into one network round-trip. |
| async offMany(handlers: function[]) | - | Unsubscribe from multiple handlers in one bundled request, takes handlers directly. |

#### SubscriptionEntry

```ts
| { kind: "message", conversationId: string, handlers: ((message: Message) => void)[] }
| { kind: "indicators", conversationId: string, handlers: ((indicators: Indicator[]) => void)[] }
| { kind: "conversation", handlers: ((event: { conversationId: string, data: Conversation | null }) => void)[] }
| { kind: "invite", handlers: ((event: { conversationId: string, toParticipantId: string, data: Invite | null }) => void)[] }
| { kind: "participantActivity", handlers: ((event: { conversationId: string, data: ParticipantActivity | null }) => void)[] }
```

## Server API

Constructor: `new Server(dispatch: ServerDispatch, rateLimits?: RateLimitOptions, cleanup?: CleanupOptions)`

#### ServerDispatch

A function that takes `data: unknown` (a plain object) and pushes it to the client, where it is passed to the client's `receive()` method. Encoding is the consumer's choice. Recommended to be used with SSE or WS, but is protocol agnostic.

May be sync or return a `Promise<void>`. The library never propagates dispatch errors, sync throws and async rejections are caught and logged so a single broken transport cannot block fan-out to other recipients.

#### RateLimitOptions

An object that configures the rate limiting of key actions the library handles.

```ts
{
    inviteLimitPerParticipantPerHour?: number, // Defaults to 10
    inviteLimitPerParticipant?: number, // Defaults to 50, hard cap on a participant's pending outgoing invites
    messageLimitPerParticipantPerSecond?: number, // Defaults to 5
    messageMaxLength?: number, // Defaults to 5000
    conversationParticipantLimit?: number, // Defaults to 100, acts as the hard global limit that takes precedence over maxSize
    conversationLimitPerParticipant?: number, // Defaults to 100
    sweepIntervalSeconds?: number, // Defaults to 30, sweep that prunes per-participant rate limit state
}
```

#### CleanupOptions

An object that configures the automated cleanup. Cleanup measured in days runs once per day. Treats values <= 0 as invalid.

```ts
{
    indicatorTtlSeconds?: number, // Defaults to 3, indicators older than this get swept
    indicatorCleanupIntervalSeconds?: number, // Defaults to 5, how often the sweep runs
    cacheEntryTtlMinutes?: number, // Defaults to 10, in-memory cache entries get evicted this long after their last write
    cacheCleanupIntervalSeconds?: number, // Defaults to 30, how often the cache sweep runs
    messageAfterDays?: number, // Defaults to null = disabled
    conversationAfterInactiveDays?: number, // Defaults to null = disabled, inactive means no new messages have been sent
    inviteAfterDays?: number, // Defaults to null = disabled
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
| createConversation(creatorParticipantId: string, maxSize?: number) | conversationId: string | Create a conversation on behalf of a participant. |
| createInvite(conversationId: string, fromParticipantId: string, toParticipantId: string) | - | Send an invite on behalf of a participant. Still runs `onInviteAuth` if registered and rate-limits against `fromParticipantId`. |
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
| Method | Calls with | Should return | Description |
| ------ | ---------- | --------------------- | ------------|
| onCreateConversation(handler: function) | conversation: ConversationRecord, creatorParticipantId: string, conversationLimitPerParticipant: number | - | Should atomically insert the conversation row and add `creatorParticipantId` as the first participant. Throw if the creator is already in `conversationLimitPerParticipant` conversations. |
| onCreateMessage(handler: function) | message: Message | - | Atomically create the message and bump the conversation's `lastActivityAt` to `message.createdAt` only if it's newer (e.g. `GREATEST(last_activity_at, ?)` in SQL). Guard the insert with a participation check so a participant who concurrently left cannot post, except when `participantId === "server"`, which is the reserved sentinel for system messages and must always be allowed. |
| onCreateMessagesSystemRemoved(handler: function) | messages: Message[] | { oldestMessagesByConversationId: Map<string, Message> } | Bulk-insert "messagesRemoved" system messages, one per input message. Skip per-conversation if the conversation's current oldest message is already a "messagesRemoved" system message. For every input conversationId, return its resulting oldest message: the just-inserted one or the pre-existing system message that caused the skip. No participation check and no `lastActivityAt` bump. |
| onCreateReaction(handler: function) | reaction: Reaction | - | Create the reaction, replacing any prior reaction by the same `(messageId, participantId)` pair. Guard the insert with a participation check. |
| onCreateInvite(handler: function) | invite: Invite, inviteLimitPerParticipant: number | { inserted: boolean } | Atomically insert the invite, deduplicating on the triple `(conversationId, fromParticipantId, toParticipantId)`. Throw if the sender already has `inviteLimitPerParticipant` pending outgoing invites (count atomically with the insert to prevent races). Return `inserted: false` on a dedup no-op so the lib can skip the broadcast and `afterInviteCreated` hook. If the recipient is already a participant of the conversation, throw. The insert must verify that both `fromParticipantId` and `toParticipantId` exist in your users table. |
| onCreateConversationParticipant(handler: function) | conversationId: string, participantId: string, conversationParticipantLimit: number, conversationLimitPerParticipant: number | - | Should atomically add the participant only if the conversation has fewer than `conversationParticipantLimit`, the participant is not already in it, and the participant is in fewer than `conversationLimitPerParticipant` conversations. Throw if any condition fails. |
| onCreateConversationParticipantActivity(handler: function) | participantActivity: ParticipantActivity | - | Should create a participant activity entry in the database. Guard the insert with a participation check so activity is not created for participants who concurrently left the conversation. |

**Read handlers:**
| Method | Calls with | Should return | Description |
| ------ | ---------- | --------------------- | ------------|
| onReadConversations(handler: function) | participantId: string | conversations: Conversation[] | Should return all conversations the participant takes part in, with `lastMessage` populated, ordered by `lastActivityAt` descending. |
| onReadConversation(handler: function) | conversationId: string | conversation: Conversation \| null | Should return the conversation by ID with `lastMessage` populated, or `null` if it does not exist. |
| onReadMessages(handler: function) | conversationId: string, cursorMessageId: string, after: boolean, amount: number | { messages: Message[], remainingInDirection: number } | Should return an array of messages ordered by `createdAt` ascending, each with its `reactions` array populated. The cursor message is never included. With `after: true` return strictly newer, with `after: false` strictly older. |
| onReadMessage(handler: function) | messageId: string | message: Message \| null | Should return the message by ID with reactions populated, or null. |
| onReadMessagesByIds(handler: function) | messageIds: string[] | messages: Message[] | Should return all matching messages with reactions populated, in any order. Missing IDs are omitted from the result. |
| onReadConversationLastMessageMetadata(handler: function) | conversationId: string | { messageId: string, createdAt: Date } \| null | Should return the ID and timestamp of the conversation's most recent message, or null if it has none. |
| onReadReaction(handler: function) | reactionId: string | reaction: Reaction \| null | Should return the reaction by ID, or null. |
| onReadInvitesInvolvingParticipant(handler: function) | participantId: string | invites: Invite[] | Should return all invites where the participant is the sender or recipient, ordered by `createdAt` descending. |
| onReadInvitesForRecipient(handler: function) | conversationId: string, toParticipantId: string | invites: Invite[] | Should return all invites the recipient has for the conversation across all senders. |
| onReadInvite(handler: function) | conversationId: string, fromParticipantId: string, toParticipantId: string | invite: Invite \| null | Should return the invite matching the triple, or null. |
| onReadAliases(handler: function) | participantIds: string[] | aliases: Alias[] | Should return all aliases for the provided participant IDs. In a simple implementation, this can look up the usernames from an existing users table. |
| onReadConversationParticipantActivity(handler: function) | conversationId: string, participantId: string | participantActivity: ParticipantActivity \| null | Should return the participant activity from the database or `null` if it does not exist. |
| onReadParticipantActivities(handler: function) | participantId: string | activities: ParticipantActivity[] | Should return all participant activity rows for the given participant. |

**Update handlers:**
| Method | Calls with | Should return | Description |
| ------ | ---------- | --------------------- | ------------|
| onUpdateMessage(handler: function) | message: Message | - | Should update the provided message in the database. The `modifiedAt` field is automatically adjusted by the library if the update is an edit. Existing reactions are preserved across edits. |
| onUpdateConversationParticipantActivity(handler: function) | participantActivity: ParticipantActivity | - | Should update the provided participant activity in the database. Guard the update with a participation check so activity is not written back for participants who concurrently left the conversation. |

**Delete handlers:**
| Method | Calls with | Should return | Description |
| ------ | ---------- | --------------------- | ------------|
| onDeleteReaction(handler: function) | reactionId: string | - | Should delete the specified reaction in the database. |
| onDeleteConversationParticipantAndParticipantActivity(handler: function) | conversationId: string, participantId: string | - | Should atomically remove the participant from the conversation and delete their participant activity row. |
| onDeleteAllConversationParticipantsAndParticipantActivitiesForParticipant(handler: function) | participantId: string | { deletedConversations: { conversationId: string, formerParticipantIds: string[], deletedInvites: { fromParticipantId: string, toParticipantId: string }[] }[], remainingConversations: { conversationId: string, conversationRecord: ConversationRecord, remainingParticipantIds: string[], lastMessage: Message \| null }[] } | Should atomically remove the participant from every conversation they are in and delete all their participant activity rows. Conversations where the participant was the last member should be deleted along with their messages, reactions, invites, and activities. Other conversations should be kept and the participant should be removed from them. Return both groups. |
| onDeleteConversationWithMessagesReactionsInvitesAndActivities(handler: function) | conversationId: string | { deletedInvites: { fromParticipantId: string, toParticipantId: string }[] } | Should atomically delete the conversation, its messages, reactions, outstanding invites, participant activities, and participants. Capture and return the deleted invite pairs. |
| onDeleteInvites(handler: function) | invites: { conversationId: string, fromParticipantId: string, toParticipantId: string }[] | - | Should delete the provided invites in the database. |
| onDeleteMessagesBefore(handler: function) | thresholdDate: Date | { affectedConversationIds: string[] } | Should delete all messages whose `createdAt` is before `thresholdDate`, plus their reactions. Return the conversationIds that had at least one message deleted (deduplicated). |
| onDeleteConversationsWithMessagesReactionsInvitesAndActivitiesBefore(handler: function) | thresholdDate: Date | { deletedConversations: { conversationId: string, formerParticipantIds: string[], deletedInvites: { fromParticipantId: string, toParticipantId: string }[] }[] } | Bulk variant of the single-conversation handler above. Should atomically delete every conversation whose `lastActivityAt` is before `thresholdDate`, along with its messages, reactions, outstanding invites, participant activities, and participants. Capture and return the participants and invite pairs per deleted conversation. |
| onDeleteInvitesBefore(handler: function) | thresholdDate: Date | { deletedInvites: { conversationId: string, fromParticipantId: string, toParticipantId: string }[] } | Should atomically delete all invites whose `createdAt` is before `thresholdDate`. Capture and return the deleted invite triples. |

**Validation handlers:**
| Method | Calls with | Should return | Description |
| ------ | ---------- | --------------------- | ------------|
| onParticipantAuth(handler: function) | participantId: string, authData: unknown | allow: boolean | Integrate a simple auth check. |
| onInviteAuth(handler: function) (optional) | fromParticipantId: string, toParticipantId: string | allow: boolean | Gate `createInvite` calls e.g. for blocked participants. Returning false rejects the invite. |
| onProfanityCheckCensor(handler: function) (optional) | message: string | censoredMessage: string | Normal profanity check where profane words are censored. Must return the (possibly censored) string and must not throw. |
| onProfanityCheckBlock(handler: function) (optional) | message: string | allow: boolean | Strict profanity check where messages that contain profanity are rejected. Must return a boolean and must not throw. |

**Hooks (all optional):**

Hooks fire after the underlying RPC response has been sent to the client (or after the admin call's awaited promise has resolved). Errors thrown inside them are caught by the library.

| Method | Calls with | Description |
| ------ | ---------- | ------------|
| onAfterMessageCreated(handler: function) | message: Message | Fires after a message was created, including server-authored ones. |
| onAfterMessageDeleted(handler: function) | message: Message | Fires after a message was marked as deleted (not actually deleted in the database). |
| onAfterParticipantJoined(handler: function) | conversationId: string, participantId: string | Fires after a participant is added to a conversation. |
| onAfterParticipantLeft(handler: function) | conversationId: string, participantId: string | Fires after a participant is removed from a conversation. |
| onAfterInviteCreated(handler: function) | invite: Invite | Fires after a new invite is persisted. |
| onAfterInviteDeleted(handler: function) | conversationId: string, fromParticipantId: string, toParticipantId: string | Fires after an invite is deleted. |
| onAfterConversationCreated(handler: function) | conversation: Conversation | Fires after a conversation is persisted. |
| onAfterConversationDeleted(handler: function) | conversationId: string | Fires after the last participant leaves and the conversation is deleted. |

### Suggested database tables

The `hc` prefix stands for headless-chat. It's suggested to use the following tables:
`hc_conversations`, `hc_conversation_participants`, `hc_participant_activities`, `hc_messages`, `hc_reactions`, `hc_invites` and, if aliases are configurable, `hc_aliases`. Ensure proper indexing.

Participant IDs are strings and using stringified numbers over UUIDs work fine.

Timestamp columns must preserve sub-second precision (e.g. MySQL `DATETIME(3)`) since rounding to whole seconds will desync `onParticipantActivity` events from the persisted entries.

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

The surfaced shape the client receives. `participantIds` is sourced from your junction table.

```ts
ConversationRecord & {
    participantIds: string[],
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
    type: "participantJoined" | "participantLeft" | "messagesRemoved",
    participantId?: string, // Who the participant the event is about (e.g. who joined / left), omitted for events not scoped to a single participant (e.g. "messagesRemoved")
}
```

`"messagesRemoved"` is posted by the daily `messageAfterDays` cleanup as a placeholder so conversations don't look empty or truncated when older messages age out.

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