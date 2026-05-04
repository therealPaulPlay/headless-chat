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

    test("the per-conversation maxSize set on createConversation rejects further accepts once full", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const charlie = transport.addClient("charlie");
        // maxSize 2 means alice + one other
        const conversationId = await alice.createConversation(2);
        await alice.createInvite(conversationId, "bob");
        await alice.createInvite(conversationId, "charlie");
        await bob.acceptInvite(conversationId);

        await expect(charlie.acceptInvite(conversationId)).rejects.toThrow(/full/i);
    });

    test("the global conversationParticipantLimit takes precedence over a higher maxSize", async () => {
        const tight = new FakeTransport({ conversationParticipantLimit: 2 });
        try {
            const alice = tight.addClient("alice");
            const bob = tight.addClient("bob");
            const charlie = tight.addClient("charlie");
            // maxSize 100 but the global cap is 2
            const conversationId = await alice.createConversation(100);
            await alice.createInvite(conversationId, "bob");
            await alice.createInvite(conversationId, "charlie");
            await bob.acceptInvite(conversationId);

            await expect(charlie.acceptInvite(conversationId)).rejects.toThrow(/full/i);
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

describe("admin functions", () => {
    let transport: FakeTransport;

    beforeEach(() => {
        transport = new FakeTransport();
        // A reject-everything auth handler ensures the bypass tests prove the admin path actually skips it
        transport.server.onParticipantAuth(() => false);
    });
    afterEach(() => { transport.stop(); });

    test("createConversation bypasses participantAuth (which rejects all)", async () => {
        transport.store.users.add("alice");
        const conversationId = await transport.server.createConversation("alice");
        expect(transport.store.conversations.has(conversationId)).toBe(true);
        expect(transport.store.conversationParticipants.get(conversationId)?.has("alice")).toBe(true);
    });

    test("createInvite bypasses participantAuth but inviteAuth still runs", async () => {
        transport.store.users.add("alice");
        transport.store.users.add("bob");
        const conversationId = await transport.server.createConversation("alice");

        // inviteAuth blocks, admin must respect this
        transport.server.onInviteAuth(() => false);
        await expect(transport.server.createInvite(conversationId, "alice", "bob")).rejects.toThrow(/Not authorized/);

        // With inviteAuth allowing, admin invite goes through (participantAuth is still rejecting all, proving the bypass)
        transport.server.onInviteAuth(() => true);
        await transport.server.createInvite(conversationId, "alice", "bob");
        expect(transport.store.invites.find(i => i.conversation.conversationId === conversationId && i.toParticipantId === "bob")).toBeTruthy();
    });

    test("createInvite admin bypasses inviteLimitPerHour rate limit", async () => {
        const tight = new FakeTransport({ inviteLimitPerHour: 1 });
        try {
            tight.server.onParticipantAuth(() => false); // Block client-side auth
            tight.store.users.add("alice");
            tight.store.users.add("bob");
            tight.store.users.add("charlie");
            const conversationId = await tight.server.createConversation("alice");

            // Admin path can issue more than the per-hour limit
            await tight.server.createInvite(conversationId, "alice", "bob");
            await expect(tight.server.createInvite(conversationId, "alice", "charlie")).resolves.toBeUndefined();
            expect(tight.store.invites.filter(i => i.conversation.conversationId === conversationId)).toHaveLength(2);
        } finally {
            tight.stop();
        }
    });

    test("acceptInvite bypasses participantAuth", async () => {
        transport.store.users.add("alice");
        transport.store.users.add("bob");
        const conversationId = await transport.server.createConversation("alice");
        await transport.server.createInvite(conversationId, "alice", "bob");

        await transport.server.acceptInvite(conversationId, "bob");
        expect(transport.store.conversationParticipants.get(conversationId)?.has("bob")).toBe(true);
    });

    test("revokeInvite bypasses participantAuth and ownership check", async () => {
        transport.store.users.add("alice");
        transport.store.users.add("bob");
        const conversationId = await transport.server.createConversation("alice");
        await transport.server.createInvite(conversationId, "alice", "bob");

        // Admin caller is not alice (not the inviter), but the ownership check is skipped
        await transport.server.revokeInvite(conversationId, "alice", "bob");
        expect(transport.store.invites.find(i => i.conversation.conversationId === conversationId && i.toParticipantId === "bob")).toBeUndefined();
    });

    test("joinConversation bypasses participantAuth and the invite requirement", async () => {
        transport.store.users.add("alice");
        transport.store.users.add("bob");
        const conversationId = await transport.server.createConversation("alice");

        // No invite created, admin direct-add still works
        await transport.server.joinConversation(conversationId, "bob");
        expect(transport.store.conversationParticipants.get(conversationId)?.has("bob")).toBe(true);
    });

    test("leaveConversation bypasses participantAuth", async () => {
        transport.store.users.add("alice");
        transport.store.users.add("bob");
        const conversationId = await transport.server.createConversation("alice");
        await transport.server.joinConversation(conversationId, "bob");

        await transport.server.leaveConversation(conversationId, "bob");
        expect(transport.store.conversationParticipants.get(conversationId)?.has("bob")).toBe(false);
    });

    test("sendMessage admin bypasses participantAuth, rate limit, and profanity check", async () => {
        const tight = new FakeTransport({ messageLimitPerSecond: 1 });
        try {
            tight.server.onParticipantAuth(() => false); // Block client-side auth
            tight.server.onProfanityCheckBlock(() => false); // Reject everything

            tight.store.users.add("alice");
            const conversationId = await tight.server.createConversation("alice");

            const id1 = await tight.server.sendMessage(conversationId, "alice", "msg1");
            const id2 = await tight.server.sendMessage(conversationId, "alice", "msg2");
            const id3 = await tight.server.sendMessage(conversationId, "alice", "msg3");
            expect(tight.store.messages.has(id1)).toBe(true);
            expect(tight.store.messages.has(id2)).toBe(true);
            expect(tight.store.messages.has(id3)).toBe(true);
        } finally {
            tight.stop();
        }
    });

    test("sendMessage admin can post system messages with the reserved 'server' participantId", async () => {
        transport.store.users.add("alice");
        const conversationId = await transport.server.createConversation("alice");

        const messageId = await transport.server.sendMessage(
            conversationId,
            "server",
            "",
            { referenceMessageId: null, isForwarded: false },
            { type: "participantJoined", participantId: "alice" },
        );
        expect(transport.store.messages.get(messageId)?.systemEvent?.type).toBe("participantJoined");
        expect(transport.store.messages.get(messageId)?.participantId).toBe("server");
    });
});

describe("server reserved participantId", () => {
    let transport: FakeTransport;

    beforeEach(() => { transport = new FakeTransport(); });
    afterEach(() => { transport.stop(); });

    test("a client claiming participantId='server' is rejected as Unauthorized", async () => {
        // Build a client that lies about its participantId
        const malicious = transport.addClient("server");
        // The auth handler returns true for matching tokens, but the lib should still reject "server" before auth runs
        await expect(malicious.createConversation()).rejects.toThrow(/Unauthorized/);
    });
});

describe("subscription handling", () => {
    let transport: FakeTransport;

    beforeEach(() => { transport = new FakeTransport(); });
    afterEach(() => { transport.stop(); });

    test("after off* resolves, no further events of that scope arrive", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        // Used as a fresh invite recipient that must exist as a user
        transport.addClient("charlie");
        const conversationId = await alice.createConversation();
        await alice.createInvite(conversationId, "bob");
        await bob.acceptInvite(conversationId);

        // Subscribe to all five event types
        const messages: Message[] = [];
        const indicators: Indicator[][] = [];
        const conversations: { conversationId: string, data: Conversation | null }[] = [];
        const invites: { conversationId: string, toParticipantId: string, data: Invite | null }[] = [];
        const activities: ParticipantActivity[] = [];
        const messageHandler = (m: Message) => messages.push(m);
        const indicatorHandler = (i: Indicator[]) => indicators.push(i);
        const conversationHandler = (e: { conversationId: string, data: Conversation | null }) => conversations.push(e);
        const inviteHandler = (e: { conversationId: string, toParticipantId: string, data: Invite | null }) => invites.push(e);
        const activityHandler = (a: ParticipantActivity) => activities.push(a);

        await bob.onMessage(conversationId, messageHandler);
        await bob.onIndicators(conversationId, indicatorHandler);
        await alice.onConversation(conversationHandler);
        await alice.onInvite(inviteHandler);
        await bob.onParticipantActivity(activityHandler);

        // Trigger one of each while subscribed
        await alice.sendMessage(conversationId, "while subscribed");
        await alice.setIndicator(conversationId);
        await alice.createInvite(conversationId, "charlie"); // Fresh invite, will broadcast
        await tick();

        // All five should have received at least one event
        expect(messages.length).toBeGreaterThan(0);
        expect(indicators.length).toBeGreaterThan(0);
        expect(conversations.length).toBeGreaterThan(0);
        expect(invites.length).toBeGreaterThan(0);
        expect(activities.length).toBeGreaterThan(0);

        // Unsubscribe everything, then let any side-effect chains (e.g. read-marker activity from offMessage) settle before snapshotting baseline
        await bob.offMessage(messageHandler);
        await bob.offIndicators(indicatorHandler);
        await alice.offConversation(conversationHandler);
        await alice.offInvite(inviteHandler);
        await bob.offParticipantActivity(activityHandler);
        await tick();

        const preMessages = messages.length;
        const preIndicators = indicators.length;
        const preConversations = conversations.length;
        const preInvites = invites.length;
        const preActivities = activities.length;

        // Trigger every type of update again
        const dave = transport.addClient("dave");
        await alice.sendMessage(conversationId, "after off"); // message + activity (synthetic) + conversation broadcasts
        await alice.setIndicator(conversationId); // indicators broadcast
        await alice.createInvite(conversationId, "dave"); // invite broadcast
        await dave.acceptInvite(conversationId); // conversation broadcast (refresh) + activity (for new participant)
        await tick();

        expect(messages.length).toBe(preMessages);
        expect(indicators.length).toBe(preIndicators);
        expect(conversations.length).toBe(preConversations);
        expect(invites.length).toBe(preInvites);
        expect(activities.length).toBe(preActivities);
    });
});

describe("error handling", () => {
    test("safeDispatch swallows consumer dispatch errors so other recipients still receive their events", async () => {
        // Custom transport that throws when dispatching to bob, succeeds for alice
        const aliceReceived: unknown[] = [];
        const server = new (await import("../src/server/server.js")).Server((participantId, data) => {
            if (participantId === "bob") throw new Error("bob's dispatch is broken");
            if (participantId === "alice") aliceReceived.push(data);
        });
        try {
            const store = new (await import("./helpers/store.js")).InMemoryStore();
            store.register(server);
            store.users.add("alice");
            store.users.add("bob");
            server.onParticipantAuth(() => true);

            // Both subscribe to the conversation scope
            await server.receive({ type: "subscribe", participantId: "alice", authData: null, scope: "conversation" });
            await server.receive({ type: "subscribe", participantId: "bob", authData: null, scope: "conversation" });

            // Admin createConversation triggers broadcastConversation to both, bob's dispatch throws but the loop must continue to alice
            await expect(server.createConversation("alice")).resolves.toBeTruthy();

            // Alice still got the broadcast despite bob's dispatch throwing
            expect(aliceReceived.length).toBeGreaterThan(0);
        } finally {
            server.stop();
        }
    });

    test("after-hook errors are swallowed, subsequent operations still work", async () => {
        const transport = new FakeTransport();
        try {
            const alice = transport.addClient("alice");
            const conversationId = await alice.createConversation();

            transport.server.onAfterMessageCreated(() => { throw new Error("hook is broken"); });

            await alice.sendMessage(conversationId, "first");
            await tick();
            // The thrown hook didn't propagate or break the server state - second send still works
            await expect(alice.sendMessage(conversationId, "second")).resolves.toBeTruthy();
        } finally {
            transport.stop();
        }
    });

    test("emitMessageById swallows readMessage errors after the underlying mutation has already happened", async () => {
        const transport = new FakeTransport();
        try {
            const alice = transport.addClient("alice");
            const bob = transport.addClient("bob");
            const conversationId = await alice.createConversation();
            await alice.createInvite(conversationId, "bob");
            await bob.acceptInvite(conversationId);
            const messageId = await alice.sendMessage(conversationId, "react this");
            await bob.addReaction(messageId, "👍");
            const reactionId = transport.store.messages.get(messageId)!.reactions[0]!.reactionId;

            // RemoveReaction flows readReaction -> deleteReaction -> emitMessageById, the broadcast step fails internally
            transport.server.onReadMessage(() => { throw new Error("read is broken"); });

            // The reaction should still be removed - the broken broadcast is swallowed, not propagated
            await expect(bob.removeReaction(reactionId)).resolves.toBeUndefined();
            expect(transport.store.messages.get(messageId)?.reactions.length).toBe(0);
        } finally {
            transport.stop();
        }
    });

    test("participantAuth handler that throws rejects the RPC just like returning false", async () => {
        const transport = new FakeTransport();
        try {
            const alice = transport.addClient("alice");
            transport.server.onParticipantAuth(() => { throw new Error("auth blew up"); });

            await expect(alice.createConversation()).rejects.toThrow(/Unauthorized/);
        } finally {
            transport.stop();
        }
    });

    test("participantAuth returning false rejects the RPC", async () => {
        const transport = new FakeTransport();
        try {
            const alice = transport.addClient("alice");
            // Force bad auth on the next request
            (alice as unknown as { getAuthData: () => unknown }).getAuthData = () => "wrong-token";
            await expect(alice.createConversation()).rejects.toThrow(/Unauthorized/);
        } finally {
            transport.stop();
        }
    });
});

describe("cleanup broadcasts", () => {
    async function runDaily(transport: FakeTransport): Promise<void> {
        await (transport.server as unknown as { scheduler: { runDaily: () => Promise<void> } }).scheduler.runDaily();
        await tick();
    }

    test("daily inactive cleanup broadcasts conversationDeleted to former participants, fires the hook, and cascades to messages and reactions", async () => {
        const transport = new FakeTransport(undefined, { conversationAfterInactiveDays: 1 });
        try {
            const alice = transport.addClient("alice");
            const bob = transport.addClient("bob");
            const conversationId = await alice.createConversation();
            await alice.createInvite(conversationId, "bob");
            await bob.acceptInvite(conversationId);
            const messageId = await alice.sendMessage(conversationId, "hello");
            await bob.addReaction(messageId, "👍");

            const aliceConvEvents: { conversationId: string, data: Conversation | null }[] = [];
            await alice.onConversation(e => aliceConvEvents.push(e));

            const conversationDeletedHooks: string[] = [];
            transport.server.onAfterConversationDeleted(id => { conversationDeletedHooks.push(id); });

            // Pre-condition: messages and reactions exist for the conversation
            expect([...transport.store.messages.values()].some(m => m.conversationId === conversationId)).toBe(true);
            expect([...transport.store.messages.values()].some(m => m.reactions.length > 0)).toBe(true);

            transport.store.conversations.get(conversationId)!.lastActivityAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
            await runDaily(transport);

            expect(aliceConvEvents.some(e => e.conversationId === conversationId && e.data === null)).toBe(true);
            expect(conversationDeletedHooks).toContain(conversationId);
            // The cascade removed the conversation's messages and reactions
            expect([...transport.store.messages.values()].some(m => m.conversationId === conversationId)).toBe(false);
            expect([...transport.store.messages.values()].some(m => m.reactions.length > 0)).toBe(false);
        } finally {
            transport.stop();
        }
    });

    test("daily conversationAfterInactiveDays cleanup cascades to invites, broadcasting inviteDeleted and firing the hook for every attached invite", async () => {
        const transport = new FakeTransport(undefined, { conversationAfterInactiveDays: 1 });
        try {
            const alice = transport.addClient("alice");
            transport.addClient("bob");
            transport.addClient("charlie");
            const conversationId = await alice.createConversation();
            await alice.createInvite(conversationId, "bob");
            await alice.createInvite(conversationId, "charlie");

            const aliceInviteEvents: { conversationId: string, toParticipantId: string, data: Invite | null }[] = [];
            await alice.onInvite(e => aliceInviteEvents.push(e));

            const inviteDeletedHooks: { conversationId: string, fromParticipantId: string, toParticipantId: string }[] = [];
            transport.server.onAfterInviteDeleted((c, f, t) => { inviteDeletedHooks.push({ conversationId: c, fromParticipantId: f, toParticipantId: t }); });

            transport.store.conversations.get(conversationId)!.lastActivityAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
            await runDaily(transport);

            // Both invites attached to the deleted conversation get broadcast + hook-fired
            for (const recipient of ["bob", "charlie"]) {
                expect(aliceInviteEvents.some(e => e.toParticipantId === recipient && e.data === null)).toBe(true);
                expect(inviteDeletedHooks.some(h => h.fromParticipantId === "alice" && h.toParticipantId === recipient)).toBe(true);
            }
        } finally {
            transport.stop();
        }
    });

    test("daily deleteInvitesBefore broadcasts inviteDeleted to inviter + invitee and fires the hook", async () => {
        const transport = new FakeTransport(undefined, { inviteAfterDays: 1 });
        try {
            const alice = transport.addClient("alice");
            const bob = transport.addClient("bob");
            const conversationId = await alice.createConversation();
            await alice.createInvite(conversationId, "bob");

            const aliceInviteEvents: { conversationId: string, toParticipantId: string, data: Invite | null }[] = [];
            const bobInviteEvents: { conversationId: string, toParticipantId: string, data: Invite | null }[] = [];
            await alice.onInvite(e => aliceInviteEvents.push(e));
            await bob.onInvite(e => bobInviteEvents.push(e));

            const inviteDeletedHooks: { fromParticipantId: string, toParticipantId: string }[] = [];
            transport.server.onAfterInviteDeleted((_c, f, t) => { inviteDeletedHooks.push({ fromParticipantId: f, toParticipantId: t }); });

            transport.store.invites.find(i => i.toParticipantId === "bob")!.createdAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
            await runDaily(transport);

            expect(aliceInviteEvents.some(e => e.toParticipantId === "bob" && e.data === null)).toBe(true);
            expect(bobInviteEvents.some(e => e.toParticipantId === "bob" && e.data === null)).toBe(true);
            expect(inviteDeletedHooks.some(h => h.fromParticipantId === "alice" && h.toParticipantId === "bob")).toBe(true);
        } finally {
            transport.stop();
        }
    });

    test("daily messageAfterDays cleanup deletes old messages and invalidates cached conversations whose lastMessage was deleted", async () => {
        const transport = new FakeTransport(undefined, { messageAfterDays: 1 });
        try {
            const alice = transport.addClient("alice");
            const conversationId = await alice.createConversation();
            const oldMessageId = await alice.sendMessage(conversationId, "old");

            // Backdate the state so the cleanup considers this message stale, in both the store and the cached snapshot
            const backdated = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
            transport.store.messages.get(oldMessageId)!.createdAt = backdated;
            const cached = transport.conversationCache.get(conversationId)!;
            cached.lastMessage!.createdAt = backdated;
            transport.conversationCache.set(conversationId, cached);

            await runDaily(transport);

            expect(transport.store.messages.has(oldMessageId)).toBe(false);
            // Cache entry got invalidated by the cleanup since its lastMessage was older than the threshold
            expect(transport.conversationCache.get(conversationId)).toBeUndefined();
            // After a fresh read, the conversation has no lastMessage and cache + DB agree
            const fresh = (await alice.getConversations("alice")).find(c => c.conversationId === conversationId);
            expect(fresh?.lastMessage).toBeNull();
            expect(transport.store.cachedConversationMatchesDb(conversationId, transport.conversationCache.get(conversationId))).toBe(true);
        } finally {
            transport.stop();
        }
    });
});

describe("client dispose", () => {
    let transport: FakeTransport;

    beforeEach(() => { transport = new FakeTransport(); });
    afterEach(() => { transport.stop(); });

    test("dispose rejects in-flight RPC promises", async () => {
        // Wedge an in-flight request by pointing dispatch at a black hole, the request never gets a response
        const blackHole = new (await import("../src/client/client.js")).Client(() => { }, "alice", () => "token-alice");
        const wedged = blackHole.createConversation();

        // Dispose immediately, the wedged promise should reject
        blackHole.dispose();
        await expect(wedged).rejects.toThrow(/disposed/i);
    });
});

describe("getMessages cursor semantics", () => {
    let transport: FakeTransport;

    beforeEach(() => { transport = new FakeTransport(); });
    afterEach(() => { transport.stop(); });

    test("null cursor returns the newest page in ascending order with remainingInDirection counting older messages", async () => {
        const alice = transport.addClient("alice");
        const conversationId = await alice.createConversation();
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) ids.push(await alice.sendMessage(conversationId, `m${i}`));

        const result = await alice.getMessages(conversationId, null, false, 3);

        // Last 3 messages, ascending
        expect(result.messages.map(m => m.messageId)).toEqual(ids.slice(2));
        // Remaining = 2 older messages not returned
        expect(result.remainingInDirection).toBe(2);
    });

    test("after: true returns strictly newer messages, excluding the cursor", async () => {
        const alice = transport.addClient("alice");
        const conversationId = await alice.createConversation();
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) ids.push(await alice.sendMessage(conversationId, `m${i}`));

        const result = await alice.getMessages(conversationId, ids[1]!, true, 10);

        // Newer than ids[1] = ids[2..4], cursor itself excluded
        expect(result.messages.map(m => m.messageId)).toEqual(ids.slice(2));
        expect(result.messages.find(m => m.messageId === ids[1])).toBeUndefined();
        expect(result.remainingInDirection).toBe(0);
    });

    test("after: false returns strictly older messages, excluding the cursor", async () => {
        const alice = transport.addClient("alice");
        const conversationId = await alice.createConversation();
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) ids.push(await alice.sendMessage(conversationId, `m${i}`));

        const result = await alice.getMessages(conversationId, ids[3]!, false, 2);

        // Older than ids[3], two most-recent older = ids[1..2], cursor excluded
        expect(result.messages.map(m => m.messageId)).toEqual([ids[1], ids[2]]);
        expect(result.messages.find(m => m.messageId === ids[3])).toBeUndefined();
        // Remaining = 1 older (ids[0])
        expect(result.remainingInDirection).toBe(1);
    });
});

describe("rate limits and capacity caps are per-participant", () => {
    test("messageLimitPerSecond is enforced per sender, not globally", async () => {
        const tight = new FakeTransport({ messageLimitPerSecond: 1 });
        try {
            const alice = tight.addClient("alice");
            const bob = tight.addClient("bob");
            const conversationId = await alice.createConversation();
            await alice.createInvite(conversationId, "bob");
            await bob.acceptInvite(conversationId);

            await alice.sendMessage(conversationId, "alice-1");
            // Alice hit her limit
            await expect(alice.sendMessage(conversationId, "alice-2")).rejects.toThrow(/rate limit/i);
            // Bob has his own bucket
            await expect(bob.sendMessage(conversationId, "bob-1")).resolves.toBeTruthy();
        } finally {
            tight.stop();
        }
    });

    test("inviteLimitPerHour is enforced per sender, not globally", async () => {
        const tight = new FakeTransport({ inviteLimitPerHour: 1 });
        try {
            const alice = tight.addClient("alice");
            const bob = tight.addClient("bob");
            tight.addClient("carol");
            tight.addClient("dave");
            const aliceConv = await alice.createConversation();
            const bobConv = await bob.createConversation();

            await alice.createInvite(aliceConv, "carol");
            // Alice hit her invite limit
            await expect(alice.createInvite(aliceConv, "dave")).rejects.toThrow(/rate limit/i);
            // Bob has his own bucket
            await expect(bob.createInvite(bobConv, "carol")).resolves.toBeUndefined();
        } finally {
            tight.stop();
        }
    });

    test("conversationLimitPerParticipant blocks createConversation past the cap", async () => {
        const tight = new FakeTransport({ conversationLimitPerParticipant: 2 });
        try {
            const alice = tight.addClient("alice");
            await alice.createConversation();
            await alice.createConversation();
            // Alice hit her per-participant cap, the third create rejects
            await expect(alice.createConversation()).rejects.toThrow(/conversation limit/i);
        } finally {
            tight.stop();
        }
    });

    test("conversationLimitPerParticipant blocks acceptInvite past the cap", async () => {
        const tight = new FakeTransport({ conversationLimitPerParticipant: 2 });
        try {
            const alice = tight.addClient("alice");
            const bob = tight.addClient("bob");
            // Bob fills his cap with two conversations he creates
            await bob.createConversation();
            await bob.createConversation();
            // Alice invites bob to a third conversation, accept rejects
            const conversationId = await alice.createConversation();
            await alice.createInvite(conversationId, "bob");
            await expect(bob.acceptInvite(conversationId)).rejects.toThrow(/conversation limit/i);
        } finally {
            tight.stop();
        }
    });

    test("admin createConversation also enforces conversationLimitPerParticipant (it's a structural cap and not a throughput limit)", async () => {
        const tight = new FakeTransport({ conversationLimitPerParticipant: 1 });
        try {
            tight.store.users.add("alice");
            await tight.server.createConversation("alice");
            await expect(tight.server.createConversation("alice")).rejects.toThrow(/conversation limit/i);
        } finally {
            tight.stop();
        }
    });

    test("admin joinConversation also enforces conversationLimitPerParticipant", async () => {
        const tight = new FakeTransport({ conversationLimitPerParticipant: 1 });
        try {
            const alice = tight.addClient("alice");
            const bob = tight.addClient("bob");
            // Bob fills his cap
            await bob.createConversation();
            const conversationId = await alice.createConversation();
            await expect(tight.server.joinConversation(conversationId, "bob")).rejects.toThrow(/conversation limit/i);
        } finally {
            tight.stop();
        }
    });
});

describe("profanity censor", () => {
    test("onProfanityCheckCensor mutates the outgoing message text", async () => {
        const transport = new FakeTransport();
        try {
            transport.server.onProfanityCheckCensor((message) => message.replace(/badword/gi, "*******"));

            const alice = transport.addClient("alice");
            const conversationId = await alice.createConversation();
            const messageId = await alice.sendMessage(conversationId, "hello badword world");

            expect(transport.store.messages.get(messageId)?.message).toBe("hello ******* world");
        } finally {
            transport.stop();
        }
    });
});

describe("client invite paths", () => {
    let transport: FakeTransport;

    beforeEach(() => { transport = new FakeTransport(); });
    afterEach(() => { transport.stop(); });

    test("client createInvite is gated by onInviteAuth", async () => {
        transport.server.onInviteAuth(() => false);
        const alice = transport.addClient("alice");
        transport.addClient("bob");
        const conversationId = await alice.createConversation();

        await expect(alice.createInvite(conversationId, "bob")).rejects.toThrow(/Not authorized/);
        expect(transport.store.invites).toHaveLength(0);
    });

    test("client declineInvite removes all matching invites and broadcasts inviteDeleted", async () => {
        const alice = transport.addClient("alice");
        const charlie = transport.addClient("charlie");
        const bob = transport.addClient("bob");
        const conversationId = await alice.createConversation();
        await alice.createInvite(conversationId, "bob");
        await alice.createInvite(conversationId, "charlie");
        await charlie.acceptInvite(conversationId);
        // Charlie can now also invite bob
        await charlie.createInvite(conversationId, "bob");

        const bobInviteEvents: { conversationId: string, toParticipantId: string, data: Invite | null }[] = [];
        await bob.onInvite(e => bobInviteEvents.push(e));

        await bob.declineInvite(conversationId);
        await tick();

        expect(transport.store.invites.filter(i => i.conversation.conversationId === conversationId && i.toParticipantId === "bob")).toHaveLength(0);
        // Both invite-deleted events landed
        expect(bobInviteEvents.filter(e => e.toParticipantId === "bob" && e.data === null)).toHaveLength(2);
    });

    test("client revokeInvite (own invite) removes it but cannot revoke another sender's invite", async () => {
        const alice = transport.addClient("alice");
        transport.addClient("bob");
        const charlie = transport.addClient("charlie");
        const conversationId = await alice.createConversation();
        await alice.createInvite(conversationId, "charlie");
        await charlie.acceptInvite(conversationId);
        // Both alice and charlie invite bob
        await alice.createInvite(conversationId, "bob");
        await charlie.createInvite(conversationId, "bob");

        // Charlie revokes their OWN invite to bob, alice's stays
        await charlie.revokeInvite(conversationId, "bob");
        const remaining = transport.store.invites.filter(i => i.conversation.conversationId === conversationId && i.toParticipantId === "bob");
        expect(remaining).toHaveLength(1);
        expect(remaining[0]?.fromParticipantId).toBe("alice");

        // Charlie tries to revoke alice's invite (doesn't own it) - should reject because the lookup finds nothing
        await expect(charlie.revokeInvite(conversationId, "bob")).rejects.toThrow(/Invite not found/);
    });
});

describe("reconnect", () => {
    test("client deregisters handlers on disconnect, re-registers on reconnect, and resumes receiving events", async () => {
        const transport = new FakeTransport();
        try {
            const alice = transport.addClient("alice");
            const bob = transport.addClient("bob");
            const conversationId = await alice.createConversation();
            await alice.createInvite(conversationId, "bob");
            await bob.acceptInvite(conversationId);

            const received: Message[] = [];
            const handler = (m: Message) => received.push(m);
            await bob.onMessage(conversationId, handler);

            await alice.sendMessage(conversationId, "before disconnect");
            await tick();
            const beforeDisconnect = received.length;
            expect(beforeDisconnect).toBeGreaterThan(0);

            // Simulated disconnect: client deregisters its handler, server cleans up its subscription
            await bob.offMessage(handler);
            transport.server.cleanupParticipant("bob");
            await tick();

            // While disconnected, bob shouldn't receive new messages
            await alice.sendMessage(conversationId, "during disconnect");
            await tick();
            expect(received.length).toBe(beforeDisconnect);

            // Reconnect: bob re-registers the same handler
            await bob.onMessage(conversationId, handler);
            await alice.sendMessage(conversationId, "after reconnect");
            await tick();
            expect(received.some(m => m.message === "after reconnect")).toBe(true);
        } finally {
            transport.stop();
        }
    });
});

describe("after-hooks", () => {
    let transport: FakeTransport;

    beforeEach(() => { transport = new FakeTransport(); });
    afterEach(() => { transport.stop(); });

    test("onAfterParticipantJoined fires when a participant joins via acceptInvite", async () => {
        const joinedHooks: { conversationId: string, participantId: string }[] = [];
        transport.server.onAfterParticipantJoined((c, p) => { joinedHooks.push({ conversationId: c, participantId: p }); });

        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const conversationId = await alice.createConversation();
        await alice.createInvite(conversationId, "bob");
        await bob.acceptInvite(conversationId);

        expect(joinedHooks).toContainEqual({ conversationId, participantId: "bob" });
    });

    test("onAfterParticipantLeft fires on a regular leave from a non-empty conversation", async () => {
        const leftHooks: { conversationId: string, participantId: string }[] = [];
        transport.server.onAfterParticipantLeft((c, p) => { leftHooks.push({ conversationId: c, participantId: p }); });

        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const conversationId = await alice.createConversation();
        await alice.createInvite(conversationId, "bob");
        await bob.acceptInvite(conversationId);
        await bob.leaveConversation(conversationId);

        expect(leftHooks).toContainEqual({ conversationId, participantId: "bob" });
    });

    test("onAfterParticipantLeft also fires when the last participant leaves and the conversation auto-deletes", async () => {
        const leftHooks: { conversationId: string, participantId: string }[] = [];
        transport.server.onAfterParticipantLeft((c, p) => { leftHooks.push({ conversationId: c, participantId: p }); });

        const alice = transport.addClient("alice");
        const conversationId = await alice.createConversation();
        await alice.leaveConversation(conversationId);

        expect(leftHooks).toContainEqual({ conversationId, participantId: "alice" });
    });

    test("onAfterMessageDeleted fires when a message is tombstoned via deleteMessage", async () => {
        const deletedHooks: Message[] = [];
        transport.server.onAfterMessageDeleted(m => { deletedHooks.push(m); });

        const alice = transport.addClient("alice");
        const conversationId = await alice.createConversation();
        const messageId = await alice.sendMessage(conversationId, "to be deleted");
        await alice.deleteMessage(messageId);

        expect(deletedHooks.some(m => m.messageId === messageId && m.deleted)).toBe(true);
    });
});