import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type { Conversation, Indicator, Invite, Message, ParticipantActivity } from "../src/shared/shared-types.js";
import { FakeTransport, tick } from "./helpers/wire.js";

describe("mixed real-world scenarios", () => {
    let transport: FakeTransport;

    beforeEach(() => { transport = new FakeTransport(); });
    afterEach(() => { transport.stop(); });

    test("invite -> accept -> send message -> receive via onMessage & ensure hooks work", async () => {
        // Wire up after-hooks before any work happens
        const conversationsCreated: Conversation[] = [];
        const messagesCreated: Message[] = [];
        transport.server.onAfterConversationCreated(c => { conversationsCreated.push(c); });
        transport.server.onAfterMessageCreated(m => { messagesCreated.push(m); });

        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const conversationId = await alice.createConversation();
        await alice.createInvite(conversationId, "bob");
        await bob.acceptInvite(conversationId);

        const received: Message[] = [];
        await bob.onMessage(conversationId, m => received.push(m));

        const messageId = await alice.sendMessage(conversationId, "hello bob");
        await tick();

        const real = received.filter(m => !m.systemEvent);
        expect(real).toHaveLength(1);
        expect(real[0]?.messageId).toBe(messageId);
        expect(real[0]?.message).toBe("hello bob");
        expect(real[0]?.participantId).toBe("alice");

        // afterConversationCreated fired exactly once for the new conversation
        expect(conversationsCreated.map(c => c.conversationId)).toEqual([conversationId]);
        // afterMessageCreated fired for the participantJoined system message and the user message
        expect(messagesCreated.some(m => m.messageId === messageId)).toBe(true);
        expect(messagesCreated.some(m => m.systemEvent?.type === "participantJoined")).toBe(true);
    });

    test("onConversation fires for both participants on create + join", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");

        const aliceEvents: { conversationId: string, data: Conversation | null }[] = [];
        const bobEvents: { conversationId: string, data: Conversation | null }[] = [];
        await alice.onConversation(e => aliceEvents.push(e));
        await bob.onConversation(e => bobEvents.push(e));

        const conversationId = await alice.createConversation();
        await tick();

        // Alice receives the create event, Bob is not yet a participant
        expect(aliceEvents.find(e => e.conversationId === conversationId && e.data !== null)).toBeTruthy();
        expect(bobEvents.find(e => e.conversationId === conversationId)).toBeUndefined();

        // Alice subscribes to messages so we can capture the participantJoined system message
        const aliceMessages: Message[] = [];
        await alice.onMessage(conversationId, m => aliceMessages.push(m));

        await alice.createInvite(conversationId, "bob");
        await bob.acceptInvite(conversationId);
        await tick();

        // After accept, both see the updated conversation with both participants
        const aliceLast = [...aliceEvents].reverse().find(e => e.conversationId === conversationId);
        const bobLast = [...bobEvents].reverse().find(e => e.conversationId === conversationId);
        expect(aliceLast?.data?.participants).toEqual(expect.arrayContaining(["alice", "bob"]));
        expect(bobLast?.data?.participants).toEqual(expect.arrayContaining(["alice", "bob"]));

        // A participantJoined system message was posted for Bob
        expect(aliceMessages.some(m => m.systemEvent?.type === "participantJoined" && m.systemEvent.participantId === "bob")).toBe(true);
    });

    test("edit + delete a message broadcasts updates", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const conversationId = await alice.createConversation();
        await alice.createInvite(conversationId, "bob");
        await bob.acceptInvite(conversationId);

        const received: Message[] = [];
        await bob.onMessage(conversationId, m => received.push(m));

        const messageId = await alice.sendMessage(conversationId, "first");
        await alice.editMessage(messageId, "edited");
        await alice.deleteMessage(messageId);
        await tick();

        const forMessage = received.filter(m => m.messageId === messageId);
        expect(forMessage.at(-1)?.deleted).toBe(true);
        expect(forMessage.some(m => m.message === "edited" && m.modifiedAt !== null)).toBe(true);
    });

    test("addReaction + removeReaction re-broadcasts the message", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const conversationId = await alice.createConversation();
        await alice.createInvite(conversationId, "bob");
        await bob.acceptInvite(conversationId);

        const messageId = await alice.sendMessage(conversationId, "reactable");
        const received: Message[] = [];
        await alice.onMessage(conversationId, m => received.push(m));

        await bob.addReaction(messageId, "👍");
        await tick();
        const afterAdd = received.filter(m => m.messageId === messageId).at(-1);
        expect(afterAdd?.reactions).toHaveLength(1);
        expect(afterAdd?.reactions[0]?.content).toBe("👍");
        const reactionId = afterAdd?.reactions[0]?.reactionId;
        expect(reactionId).toBeTruthy();

        await bob.removeReaction(reactionId!);
        await tick();
        const afterRemove = received.filter(m => m.messageId === messageId).at(-1);
        expect(afterRemove?.reactions).toHaveLength(0);
    });

    test("setIndicator broadcasts to subscribers and TTL evicts after expiry", async () => {
        // Tight TTL + sweep so the test can advance real time and observe eviction quickly
        const tight = new FakeTransport(undefined, { indicatorTtlSeconds: 1, indicatorCleanupIntervalSeconds: 1 });
        try {
            const alice = tight.addClient("alice");
            const bob = tight.addClient("bob");
            const charlie = tight.addClient("charlie");
            const conversationId = await alice.createConversation();
            await alice.createInvite(conversationId, "bob");
            await alice.createInvite(conversationId, "charlie");
            await bob.acceptInvite(conversationId);
            await charlie.acceptInvite(conversationId);

            const seen: Indicator[][] = [];
            await charlie.onIndicators(conversationId, indicators => seen.push(indicators));

            await alice.setIndicator(conversationId);
            await bob.setIndicator(conversationId);
            await tick();

            // Both indicators visible
            const afterSet = seen.at(-1);
            expect(afterSet?.length).toBe(2);

            // Wait past TTL + at least one sweep tick - alice's and bob's stale indicators should be evicted
            await new Promise(resolve => setTimeout(resolve, 2500));

            // The sweep itself broadcasts an empty snapshot, no extra action needed
            const afterSweep = seen.at(-1);
            expect(afterSweep?.length).toBe(0);

            // A fresh setIndicator emits a snapshot containing only the just-set entry
            await alice.setIndicator(conversationId);
            await tick();
            const afterRefresh = seen.at(-1);
            expect(afterRefresh?.length).toBe(1);
            expect(afterRefresh?.[0]?.participantId).toBe("alice");
        } finally {
            tight.stop();
        }
    });

    test("auth rejection rejects the RPC", async () => {
        const alice = transport.addClient("alice");
        // Force bad auth on next request
        (alice as unknown as { getAuthData: () => unknown }).getAuthData = () => "wrong-token";
        await expect(alice.createConversation()).rejects.toThrow(/Unauthorized/);
    });

    test("leaveConversation posts a system message, cleans up activity, and deletes empty conversations", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const conversationId = await alice.createConversation();
        await alice.createInvite(conversationId, "bob");
        await bob.acceptInvite(conversationId);

        // Send a message and let Alice fetch it so her participant activity row gets created
        await bob.sendMessage(conversationId, "hi alice");
        await alice.getMessages(conversationId, null, false, 50);
        await tick();
        expect((await alice.getParticipantActivities()).some(a => a.conversationId === conversationId)).toBe(true);

        const messages: Message[] = [];
        const conversationEvents: { conversationId: string, data: Conversation | null }[] = [];
        await bob.onMessage(conversationId, m => messages.push(m));
        await bob.onConversation(e => conversationEvents.push(e));
        const aliceConvEvents: { conversationId: string, data: Conversation | null }[] = [];
        await alice.onConversation(e => aliceConvEvents.push(e));

        await alice.leaveConversation(conversationId);
        await tick();

        // Bob saw a participantLeft system message
        expect(messages.some(m => m.systemEvent?.type === "participantLeft" && m.systemEvent.participantId === "alice")).toBe(true);
        // Bob's conversation list shows alice is gone
        const bobLast = [...conversationEvents].reverse().find(e => e.conversationId === conversationId && e.data !== null);
        expect(bobLast?.data?.participants).toEqual(["bob"]);
        // Alice received a deleted-event for the conversation (data: null)
        expect(aliceConvEvents.some(e => e.conversationId === conversationId && e.data === null)).toBe(true);
        // Alice's participant activity for this conversation is cleaned up
        expect((await alice.getParticipantActivities()).some(a => a.conversationId === conversationId)).toBe(false);

        // Bob leaves alone, conversation is fully deleted
        await bob.leaveConversation(conversationId);
        await tick();
        expect(conversationEvents.some(e => e.conversationId === conversationId && e.data === null)).toBe(true);
    });

    test("leave that auto-deletes the conversation also removes invites, messages, reactions and activities and notifies their subscribers", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const charlie = transport.addClient("charlie");

        const conversationId = await alice.createConversation();
        // Outstanding invite for an absent participant that should be cleaned up when alice leaves
        await alice.createInvite(conversationId, "bob");

        // Alice sends a message and reacts to it so we have messages + reactions + activities to clean up
        const messageId = await alice.sendMessage(conversationId, "hello");
        await alice.addReaction(messageId, "👍");
        await alice.getMessages(conversationId, null, false, 10);
        await tick();
        expect(transport.store.messages.size).toBeGreaterThan(0);
        expect([...transport.store.messages.values()].some(m => m.reactions.length > 0)).toBe(true);
        expect((await alice.getParticipantActivities()).some(a => a.conversationId === conversationId)).toBe(true);

        // Subscribers wired BEFORE the leave so we capture the deletion events
        const aliceInviteEvents: { conversationId: string, toParticipantId: string, data: Invite | null }[] = [];
        const bobInviteEvents: { conversationId: string, toParticipantId: string, data: Invite | null }[] = [];
        const charlieInviteEvents: { conversationId: string, toParticipantId: string, data: Invite | null }[] = [];
        await alice.onInvite(e => aliceInviteEvents.push(e));
        await bob.onInvite(e => bobInviteEvents.push(e));
        await charlie.onInvite(e => charlieInviteEvents.push(e));

        const aliceConvEvents: { conversationId: string, data: Conversation | null }[] = [];
        await alice.onConversation(e => aliceConvEvents.push(e));

        const inviteDeletedHooks: { conversationId: string, fromParticipantId: string, toParticipantId: string }[] = [];
        const conversationDeletedHooks: string[] = [];
        transport.server.onAfterInviteDeleted((conversationId, fromParticipantId, toParticipantId) => {
            inviteDeletedHooks.push({ conversationId, fromParticipantId, toParticipantId });
        });
        transport.server.onAfterConversationDeleted(conversationId => {
            conversationDeletedHooks.push(conversationId);
        });

        await alice.leaveConversation(conversationId);
        await tick();

        // Conversation gone for the leaver
        expect(aliceConvEvents.some(e => e.conversationId === conversationId && e.data === null)).toBe(true);
        // Invite-deleted broadcast reached inviter (alice) and invitee (bob), but not unrelated charlie
        expect(aliceInviteEvents.some(e => e.conversationId === conversationId && e.toParticipantId === "bob" && e.data === null)).toBe(true);
        expect(bobInviteEvents.some(e => e.conversationId === conversationId && e.toParticipantId === "bob" && e.data === null)).toBe(true);
        expect(charlieInviteEvents.some(e => e.conversationId === conversationId)).toBe(false);

        // Hooks fired for both deletions
        expect(conversationDeletedHooks).toContain(conversationId);
        expect(inviteDeletedHooks.some(h => h.conversationId === conversationId && h.fromParticipantId === "alice" && h.toParticipantId === "bob")).toBe(true);

        // Underlying store no longer has the conversation, its messages, reactions, invites, or activities
        expect(transport.store.conversations.has(conversationId)).toBe(false);
        expect([...transport.store.messages.values()].some(m => m.conversationId === conversationId)).toBe(false);
        expect([...transport.store.messages.values()].some(m => m.reactions.length > 0)).toBe(false);
        expect(transport.store.invites.some(i => i.conversation.conversationId === conversationId)).toBe(false);
        expect((await alice.getParticipantActivities()).some(a => a.conversationId === conversationId)).toBe(false);
    });

    test("offMessage marks the conversation's latest message as read", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const conversationId = await alice.createConversation();
        await alice.createInvite(conversationId, "bob");
        await bob.acceptInvite(conversationId);

        // Bob subscribes and receives a message live, with NO call to getMessages
        const handler = (_message: Message) => { };
        await bob.onMessage(conversationId, handler);
        const messageId = await alice.sendMessage(conversationId, "live message");
        await tick();

        // Pre-condition: no activity row yet because bob never called getMessages
        expect((await bob.getParticipantActivities()).some(a => a.conversationId === conversationId)).toBe(false);

        // Unsubscribing should persist the latest seen message as read
        await bob.offMessage(handler);
        await tick();

        const activities = await bob.getParticipantActivities();
        const bobActivity = activities.find(a => a.conversationId === conversationId);
        expect(bobActivity?.lastReadMessageId).toBe(messageId);
    });

    test("cleanupParticipant marks message-subscribed conversations as read", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const conversationId = await alice.createConversation();
        await alice.createInvite(conversationId, "bob");
        await bob.acceptInvite(conversationId);

        await bob.onMessage(conversationId, () => { });
        const messageId = await alice.sendMessage(conversationId, "via subscription");
        await tick();

        // Simulate a transport drop - server-side cleanup should still flush the read marker
        transport.server.cleanupParticipant("bob");
        await tick();

        const bobActivity = (await bob.getParticipantActivities()).find(a => a.conversationId === conversationId);
        expect(bobActivity?.lastReadMessageId).toBe(messageId);
    });

    test("onParticipantActivity fires synthetically for a subscribed message viewer when a new message arrives", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const conversationId = await alice.createConversation();
        await alice.createInvite(conversationId, "bob");
        await bob.acceptInvite(conversationId);

        const bobActivities: ParticipantActivity[] = [];
        await bob.onParticipantActivity(activity => bobActivities.push(activity));
        await bob.onMessage(conversationId, () => { });

        const messageId = await alice.sendMessage(conversationId, "live");
        await tick();

        const synthetic = bobActivities.find(a => a.conversationId === conversationId && a.lastReadMessageId === messageId);
        expect(synthetic).toBeTruthy();
        expect(synthetic?.participantId).toBe("bob");
    });

    test("onParticipantActivity fires when getMessages persists a new read pointer", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const conversationId = await alice.createConversation();
        await alice.createInvite(conversationId, "bob");
        await bob.acceptInvite(conversationId);

        // Bob subscribes to activity but NOT to messages, so the only update path is the getMessages persist
        const bobActivities: ParticipantActivity[] = [];
        await bob.onParticipantActivity(activity => bobActivities.push(activity));

        await alice.sendMessage(conversationId, "msg");
        await bob.getMessages(conversationId, null, false, 10);
        await tick();

        expect(bobActivities.some(a => a.conversationId === conversationId)).toBe(true);
    });

    test("multiple senders inviting the same recipient, accept removes all of them but unrelated invites are preserved", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const charlie = transport.addClient("charlie");
        const dave = transport.addClient("dave");
        // simon and eve only need to exist as users for invite recipient validation
        transport.addClient("simon");
        transport.addClient("eve");

        // Alice creates the conversation, bob and charlie join
        const conversationId = await alice.createConversation();
        await alice.createInvite(conversationId, "bob");
        await bob.acceptInvite(conversationId);
        await alice.createInvite(conversationId, "charlie");
        await charlie.acceptInvite(conversationId);

        // Both bob and charlie invite dave to the same conversation
        await bob.createInvite(conversationId, "dave");
        await charlie.createInvite(conversationId, "dave");

        // Unrelated invites that must be preserved across dave's accept
        // Bob's invite to simon for the same conversation - different recipient, must stay
        await bob.createInvite(conversationId, "simon");
        // Dave invites eve to a different conversation - different conversation, must stay
        const otherConversationId = await dave.createConversation();
        await dave.createInvite(otherConversationId, "eve");

        // Pre-condition: dave has two distinct invites for the target conversation
        const davesInvitesBeforeAccept = await dave.getInvites("dave");
        const forConversation = davesInvitesBeforeAccept.filter(i => i.conversation.conversationId === conversationId);
        expect(forConversation).toHaveLength(2);
        expect(forConversation.map(i => i.fromParticipantId).sort()).toEqual(["bob", "charlie"]);

        // Both inviters subscribe to onInvite to verify they receive deletion events
        const bobInviteEvents: { conversationId: string, toParticipantId: string, data: Invite | null }[] = [];
        const charlieInviteEvents: { conversationId: string, toParticipantId: string, data: Invite | null }[] = [];
        await bob.onInvite(e => bobInviteEvents.push(e));
        await charlie.onInvite(e => charlieInviteEvents.push(e));

        await dave.acceptInvite(conversationId);
        await tick();

        // Both dave-invites are gone from the store
        expect(transport.store.invites.filter(i => i.conversation.conversationId === conversationId && i.toParticipantId === "dave")).toHaveLength(0);

        // Bob's invite to simon for the same conversation is preserved
        expect(transport.store.invites.find(i => i.conversation.conversationId === conversationId && i.toParticipantId === "simon" && i.fromParticipantId === "bob")).toBeTruthy();
        // Dave's invite to eve in a different conversation is preserved
        expect(transport.store.invites.find(i => i.conversation.conversationId === otherConversationId && i.toParticipantId === "eve" && i.fromParticipantId === "dave")).toBeTruthy();

        // Bob and charlie each see THEIR invite to dave deleted
        expect(bobInviteEvents.some(e => e.conversationId === conversationId && e.toParticipantId === "dave" && e.data === null)).toBe(true);
        expect(charlieInviteEvents.some(e => e.conversationId === conversationId && e.toParticipantId === "dave" && e.data === null)).toBe(true);

        // Dave is now a participant
        const convs = await dave.getConversations("dave");
        expect(convs.find(c => c.conversationId === conversationId)?.participants).toEqual(expect.arrayContaining(["alice", "bob", "charlie", "dave"]));
    });

    test("rate limits message sends", async () => {
        const tight = new FakeTransport({ messageLimitPerSecond: 2 });
        try {
            const alice = tight.addClient("alice");
            const bob = tight.addClient("bob");
            const conversationId = await alice.createConversation();
            await alice.createInvite(conversationId, "bob");
            await bob.acceptInvite(conversationId);

            await alice.sendMessage(conversationId, "1");
            await alice.sendMessage(conversationId, "2");
            await expect(alice.sendMessage(conversationId, "3")).rejects.toThrow(/rate limit/i);
        } finally {
            tight.stop();
        }
    });
});

describe("cache invalidation", () => {
    let transport: FakeTransport;

    beforeEach(() => { transport = new FakeTransport(); });
    afterEach(() => { transport.stop(); });

    test("createConversation populates the cache and matches DB", async () => {
        const alice = transport.addClient("alice");
        const conversationId = await alice.createConversation();

        const cached = transport.conversationCache.get(conversationId);
        expect(cached).toBeTruthy();
        expect(transport.store.cachedConversationMatchesDb(conversationId, cached)).toBe(true);
    });

    test("getConversations warms the cache for each returned row", async () => {
        const alice = transport.addClient("alice");
        const conversationId = await alice.createConversation();

        // Drop the cache so we observe the warming effect of getConversations
        transport.conversationCache.invalidate(conversationId);
        await alice.getConversations("alice");

        const cached = transport.conversationCache.get(conversationId);
        expect(transport.store.cachedConversationMatchesDb(conversationId, cached)).toBe(true);
    });

    test("sendMessage patches lastMessage and lastActivityAt without re-reading the conversation", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const conversationId = await alice.createConversation();
        await alice.createInvite(conversationId, "bob");
        await bob.acceptInvite(conversationId);

        // Baseline: cache is warm from createConversation + accept flow
        transport.store.resetCounts();
        const messageId = await alice.sendMessage(conversationId, "hello");

        // The cached snapshot reflects the new lastMessage and matches what the DB would surface
        const cached = transport.conversationCache.get(conversationId);
        expect(cached?.lastMessage?.messageId).toBe(messageId);
        expect(transport.store.cachedConversationMatchesDb(conversationId, cached)).toBe(true);
        // No extra readConversation hit during sendMessage, the patch path avoided it
        expect(transport.store.countOf("readConversation")).toBe(0);
    });

    test("editMessage patches the cached lastMessage when editing the conversation's last message", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const conversationId = await alice.createConversation();
        await alice.createInvite(conversationId, "bob");
        await bob.acceptInvite(conversationId);
        const messageId = await alice.sendMessage(conversationId, "original");

        await alice.editMessage(messageId, "edited");

        const cached = transport.conversationCache.get(conversationId);
        expect(cached?.lastMessage?.message).toBe("edited");
        expect(transport.store.cachedConversationMatchesDb(conversationId, cached)).toBe(true);
    });

    test("editMessage does not touch the cache when editing a non-last message", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const conversationId = await alice.createConversation();
        await alice.createInvite(conversationId, "bob");
        await bob.acceptInvite(conversationId);
        const oldMessageId = await alice.sendMessage(conversationId, "old");
        await alice.sendMessage(conversationId, "newer");

        const beforeEdit = transport.conversationCache.get(conversationId);
        await alice.editMessage(oldMessageId, "old edited");
        const afterEdit = transport.conversationCache.get(conversationId);

        // Cache lastMessage unchanged (still points to "newer") and still matches DB
        expect(afterEdit?.lastMessage?.message).toBe(beforeEdit?.lastMessage?.message);
        expect(transport.store.cachedConversationMatchesDb(conversationId, afterEdit)).toBe(true);
    });

    test("deleteMessage tombstones in cache when deleting the conversation's last message", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const conversationId = await alice.createConversation();
        await alice.createInvite(conversationId, "bob");
        await bob.acceptInvite(conversationId);
        const messageId = await alice.sendMessage(conversationId, "soon to be tombstoned");

        await alice.deleteMessage(messageId);

        const cached = transport.conversationCache.get(conversationId);
        expect(cached?.lastMessage?.deleted).toBe(true);
        expect(transport.store.cachedConversationMatchesDb(conversationId, cached)).toBe(true);
    });

    test("addReaction to lastMessage patches the cached snapshot", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const conversationId = await alice.createConversation();
        await alice.createInvite(conversationId, "bob");
        await bob.acceptInvite(conversationId);
        const messageId = await alice.sendMessage(conversationId, "react to me");

        await bob.addReaction(messageId, "👍");

        const cached = transport.conversationCache.get(conversationId);
        expect(cached?.lastMessage?.reactions.find(r => r.participantId === "bob")?.content).toBe("👍");
        expect(transport.store.cachedConversationMatchesDb(conversationId, cached)).toBe(true);
    });

    test("addReaction by the same participant replaces their prior reaction (one-per-(message, participant))", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const conversationId = await alice.createConversation();
        await alice.createInvite(conversationId, "bob");
        await bob.acceptInvite(conversationId);
        const messageId = await alice.sendMessage(conversationId, "react");

        await bob.addReaction(messageId, "👍");
        await bob.addReaction(messageId, "❤️");

        const cached = transport.conversationCache.get(conversationId);
        const bobReactions = cached?.lastMessage?.reactions.filter(r => r.participantId === "bob") ?? [];
        expect(bobReactions).toHaveLength(1);
        expect(bobReactions[0]?.content).toBe("❤️");
        expect(transport.store.cachedConversationMatchesDb(conversationId, cached)).toBe(true);
    });

    test("removeReaction patches the cached snapshot when removing from the lastMessage", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const conversationId = await alice.createConversation();
        await alice.createInvite(conversationId, "bob");
        await bob.acceptInvite(conversationId);
        const messageId = await alice.sendMessage(conversationId, "react then unreact");
        await bob.addReaction(messageId, "👍");
        const cachedAfterAdd = transport.conversationCache.get(conversationId);
        const reactionId = cachedAfterAdd!.lastMessage!.reactions[0]!.reactionId;

        await bob.removeReaction(reactionId);

        const cached = transport.conversationCache.get(conversationId);
        expect(cached?.lastMessage?.reactions).toHaveLength(0);
        expect(transport.store.cachedConversationMatchesDb(conversationId, cached)).toBe(true);
    });

    test("addReaction on a non-last message does not touch the conversation cache", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const conversationId = await alice.createConversation();
        await alice.createInvite(conversationId, "bob");
        await bob.acceptInvite(conversationId);
        const oldMessageId = await alice.sendMessage(conversationId, "old");
        await alice.sendMessage(conversationId, "newer");

        const before = transport.conversationCache.get(conversationId);
        await bob.addReaction(oldMessageId, "👍");
        const after = transport.conversationCache.get(conversationId);

        expect(after?.lastMessage?.messageId).toBe(before?.lastMessage?.messageId);
        expect(after?.lastMessage?.reactions).toHaveLength(0);
        expect(transport.store.cachedConversationMatchesDb(conversationId, after)).toBe(true);
    });

    test("acceptInvite invalidates so participants list is fresh on next read", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const conversationId = await alice.createConversation();
        await alice.createInvite(conversationId, "bob");

        // Pre-condition: cache holds alice-only
        const beforeJoin = transport.conversationCache.get(conversationId);
        expect(beforeJoin?.participants).toEqual(["alice"]);

        await bob.acceptInvite(conversationId);

        // After acceptance, the cache must have been invalidated (or refreshed) to reflect bob
        const cached = transport.conversationCache.get(conversationId);
        // If still cached, it must match the fresh DB state with bob included
        if (cached) expect(transport.store.cachedConversationMatchesDb(conversationId, cached)).toBe(true);
        // Force a read to confirm the surfaced state has bob, regardless of whether the cache hit or refilled
        const fresh = (await alice.getConversations("alice")).find(c => c.conversationId === conversationId);
        expect(fresh?.participants).toEqual(expect.arrayContaining(["alice", "bob"]));
    });

    test("leaveConversation (non-auto-delete) invalidates the cache", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const conversationId = await alice.createConversation();
        await alice.createInvite(conversationId, "bob");
        await bob.acceptInvite(conversationId);

        await bob.leaveConversation(conversationId);

        const cached = transport.conversationCache.get(conversationId);
        if (cached) expect(transport.store.cachedConversationMatchesDb(conversationId, cached)).toBe(true);
        // The DB must reflect bob's removal
        const fresh = (await alice.getConversations("alice")).find(c => c.conversationId === conversationId);
        expect(fresh?.participants).toEqual(["alice"]);
    });

    test("leaveConversation (auto-delete) invalidates the cache so subsequent reads return null", async () => {
        const alice = transport.addClient("alice");
        const conversationId = await alice.createConversation();

        await alice.leaveConversation(conversationId);

        // Cache entry gone, DB row gone, both agree on undefined / no record
        const cached = transport.conversationCache.get(conversationId);
        expect(cached).toBeUndefined();
        expect(transport.store.cachedConversationMatchesDb(conversationId, cached)).toBe(true);
    });

    test("readConversation cache hit avoids the DB join across repeated operations", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const conversationId = await alice.createConversation();
        await alice.createInvite(conversationId, "bob");
        await bob.acceptInvite(conversationId);

        // Reset counts after the join flow has settled
        transport.store.resetCounts();

        await alice.sendMessage(conversationId, "first");
        await alice.sendMessage(conversationId, "second");
        await alice.sendMessage(conversationId, "third");

        // Three sends, zero readConversation calls thanks to the patch path
        expect(transport.store.countOf("readConversation")).toBe(0);
    });

    test("getMessages warms the activity cache so the next read-state write skips readConversationParticipantActivity", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const conversationId = await alice.createConversation();
        await alice.createInvite(conversationId, "bob");
        await bob.acceptInvite(conversationId);
        await alice.sendMessage(conversationId, "first");

        transport.store.resetCounts();
        // First getMessages triggers the activity creation, populates the cache
        await bob.getMessages(conversationId, null, false, 10);
        const firstReadCount = transport.store.countOf("readConversationParticipantActivity");

        // Second getMessages with a newer message - cache hit means no extra activity row read
        await alice.sendMessage(conversationId, "second");
        await bob.getMessages(conversationId, null, false, 10);
        const secondReadCount = transport.store.countOf("readConversationParticipantActivity");

        expect(secondReadCount).toBe(firstReadCount); // No additional activity DB read
    });

    test("getParticipantActivities warms the activity cache", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const conversationId = await alice.createConversation();
        await alice.createInvite(conversationId, "bob");
        await bob.acceptInvite(conversationId);
        await alice.sendMessage(conversationId, "first");
        await bob.getMessages(conversationId, null, false, 10);

        // Drop the cache to observe the warming effect
        transport.activityCache.invalidate(`${conversationId}|bob`);
        await bob.getParticipantActivities();

        const cached = transport.activityCache.get(`${conversationId}|bob`);
        expect(transport.store.cachedActivityMatchesDb(conversationId, "bob", cached)).toBe(true);
    });

    test("leaveConversation invalidates the activity cache for the leaver", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const conversationId = await alice.createConversation();
        await alice.createInvite(conversationId, "bob");
        await bob.acceptInvite(conversationId);
        await alice.sendMessage(conversationId, "msg");
        await bob.getMessages(conversationId, null, false, 10);

        // Pre-condition: activity exists in cache and DB
        const before = transport.activityCache.get(`${conversationId}|bob`);
        expect(before).toBeDefined();

        await bob.leaveConversation(conversationId);

        const cached = transport.activityCache.get(`${conversationId}|bob`);
        expect(cached).toBeUndefined();
        expect(transport.store.cachedActivityMatchesDb(conversationId, "bob", cached)).toBe(true);
    });

    test("admin joinConversation invalidates the cache so participants list is fresh on next read", async () => {
        const alice = transport.addClient("alice");
        transport.addClient("bob");
        const conversationId = await alice.createConversation();

        // Pre-condition: cache holds alice-only
        expect(transport.conversationCache.get(conversationId)?.participants).toEqual(["alice"]);

        // Admin path - bypass invite flow
        await transport.server.joinConversation(conversationId, "bob");

        const cached = transport.conversationCache.get(conversationId);
        if (cached) expect(transport.store.cachedConversationMatchesDb(conversationId, cached)).toBe(true);
        const fresh = (await alice.getConversations("alice")).find(c => c.conversationId === conversationId);
        expect(fresh?.participants).toEqual(expect.arrayContaining(["alice", "bob"]));
    });

    test("admin sendMessage with a systemEvent patches the cached lastMessage", async () => {
        const alice = transport.addClient("alice");
        transport.addClient("bob");
        const conversationId = await alice.createConversation();
        await transport.server.joinConversation(conversationId, "bob");

        // Admin path posts a custom system message
        const messageId = await transport.server.sendMessage(
            conversationId,
            "server",
            "",
            { referenceMessageId: null, isForwarded: false },
            { type: "participantJoined", participantId: "bob" },
        );

        const cached = transport.conversationCache.get(conversationId);
        expect(cached?.lastMessage?.messageId).toBe(messageId);
        expect(cached?.lastMessage?.systemEvent?.type).toBe("participantJoined");
        expect(transport.store.cachedConversationMatchesDb(conversationId, cached)).toBe(true);
    });

    test("admin deleteParticipant invalidates the cache for a conversation that survives the participant's removal", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const conversationId = await alice.createConversation();
        await alice.createInvite(conversationId, "bob");
        await bob.acceptInvite(conversationId);

        // Pre-condition: cache holds both participants
        expect(transport.conversationCache.get(conversationId)?.participants).toEqual(expect.arrayContaining(["alice", "bob"]));

        await transport.server.deleteParticipant("bob");

        const cached = transport.conversationCache.get(conversationId);
        if (cached) expect(transport.store.cachedConversationMatchesDb(conversationId, cached)).toBe(true);
        const fresh = (await alice.getConversations("alice")).find(c => c.conversationId === conversationId);
        expect(fresh?.participants).toEqual(["alice"]);
    });

    test("admin deleteParticipant does not affect unrelated cached conversations", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const charlie = transport.addClient("charlie");

        const involvingBob = await alice.createConversation();
        await alice.createInvite(involvingBob, "bob");
        await bob.acceptInvite(involvingBob);

        const unrelated = await alice.createConversation();
        await alice.createInvite(unrelated, "charlie");
        await charlie.acceptInvite(unrelated);

        await transport.server.deleteParticipant("bob");

        const cachedUnrelated = transport.conversationCache.get(unrelated);
        expect(cachedUnrelated?.participants).toEqual(expect.arrayContaining(["alice", "charlie"]));
        expect(transport.store.cachedConversationMatchesDb(unrelated, cachedUnrelated)).toBe(true);
    });

    test("daily cleanup of inactive conversations invalidates their cache entries", async () => {
        const tight = new FakeTransport(undefined, { conversationAfterInactiveDays: 1 });
        try {
            const alice = tight.addClient("alice");
            const bob = tight.addClient("bob");
            const conversationId = await alice.createConversation();
            await alice.createInvite(conversationId, "bob");
            await bob.acceptInvite(conversationId);
            await alice.sendMessage(conversationId, "old message");

            // Backdate the conversation in the store so the cleanup picks it up
            const record = tight.store.conversations.get(conversationId)!;
            record.lastActivityAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

            // Pre-condition: cache holds the conversation
            expect(tight.conversationCache.get(conversationId)).toBeTruthy();

            // Trigger the daily run directly (the timer-based one runs once per day)
            await (tight.server as unknown as { scheduler: { runDaily: () => Promise<void> } }).scheduler.runDaily();
            await tick();

            // Cache and DB both reflect the deletion
            expect(tight.conversationCache.get(conversationId)).toBeUndefined();
            expect(tight.store.conversations.has(conversationId)).toBe(false);
            // Activity cache for the conversation also invalidated
            expect(tight.activityCache.get(`${conversationId}|alice`)).toBeUndefined();
            expect(tight.activityCache.get(`${conversationId}|bob`)).toBeUndefined();
        } finally {
            tight.stop();
        }
    });
});