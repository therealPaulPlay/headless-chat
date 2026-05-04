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
        expect(aliceLast?.data?.participantIds).toEqual(expect.arrayContaining(["alice", "bob"]));
        expect(bobLast?.data?.participantIds).toEqual(expect.arrayContaining(["alice", "bob"]));

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

    test("sendMessage from a non-typing participant does not broadcast an unchanged indicator snapshot", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const conversationId = await alice.createConversation();
        await alice.createInvite(conversationId, "bob");
        await bob.acceptInvite(conversationId);

        const indicatorEvents: Indicator[][] = [];
        await alice.onIndicators(conversationId, indicators => indicatorEvents.push(indicators));

        // Bob never set an indicator, so his sendMessage's implicit removeIndicator should be a no-op
        await bob.sendMessage(conversationId, "no typing first");
        await tick();
        expect(indicatorEvents).toHaveLength(0);

        // For contrast, when bob actually was typing, his sendMessage clears it and the broadcast fires once
        await bob.setIndicator(conversationId);
        await tick();
        const eventsAfterSet = indicatorEvents.length;
        expect(eventsAfterSet).toBeGreaterThan(0);

        await bob.sendMessage(conversationId, "typed then sent");
        await tick();
        const lastSnapshot = indicatorEvents.at(-1);
        expect(indicatorEvents.length).toBe(eventsAfterSet + 1);
        expect(lastSnapshot?.find(i => i.participantId === "bob")).toBeUndefined();
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
        expect(bobLast?.data?.participantIds).toEqual(["bob"]);
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

        const bobActivities: { conversationId: string, data: ParticipantActivity | null }[] = [];
        await bob.onParticipantActivity(event => bobActivities.push(event));
        await bob.onMessage(conversationId, () => { });

        const messageId = await alice.sendMessage(conversationId, "live");
        await tick();

        const synthetic = bobActivities.find(e => e.conversationId === conversationId && e.data?.lastReadMessageId === messageId);
        expect(synthetic).toBeTruthy();
        expect(synthetic?.data?.participantId).toBe("bob");
    });

    test("onParticipantActivity fires when getMessages persists a new read pointer", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const conversationId = await alice.createConversation();
        await alice.createInvite(conversationId, "bob");
        await bob.acceptInvite(conversationId);

        // Bob subscribes to activity but NOT to messages, so the only update path is the getMessages persist
        const bobActivities: { conversationId: string, data: ParticipantActivity | null }[] = [];
        await bob.onParticipantActivity(event => bobActivities.push(event));

        await alice.sendMessage(conversationId, "msg");
        await bob.getMessages(conversationId, null, false, 10);
        await tick();

        expect(bobActivities.some(e => e.conversationId === conversationId && e.data !== null)).toBe(true);
    });

    test("onParticipantActivity fires with data: null when the participant leaves a shared conversation, signalling the activity row was removed", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const conversationId = await alice.createConversation();
        await alice.createInvite(conversationId, "bob");
        await bob.acceptInvite(conversationId);

        // Bob reads to materialize an activity row, then subscribes
        await alice.sendMessage(conversationId, "hi");
        await bob.getMessages(conversationId, null, false, 10);
        const bobActivities: { conversationId: string, data: ParticipantActivity | null }[] = [];
        await bob.onParticipantActivity(event => bobActivities.push(event));

        await bob.leaveConversation(conversationId);
        await tick();

        // Bob receives the deletion signal for this conversation's activity, mirroring the data: null pattern of onConversation / onInvite
        const deletion = bobActivities.find(e => e.conversationId === conversationId && e.data === null);
        expect(deletion).toBeTruthy();
    });

    test("onParticipantActivity fires with data: null for the last leaver when the conversation auto-deletes", async () => {
        const alice = transport.addClient("alice");
        const conversationId = await alice.createConversation();
        await alice.sendMessage(conversationId, "solo note");
        await alice.getMessages(conversationId, null, false, 10);
        const aliceActivities: { conversationId: string, data: ParticipantActivity | null }[] = [];
        await alice.onParticipantActivity(event => aliceActivities.push(event));

        await alice.leaveConversation(conversationId);
        await tick();

        const deletion = aliceActivities.find(e => e.conversationId === conversationId && e.data === null);
        expect(deletion).toBeTruthy();
    });

    test("onParticipantActivity fires with data: null for the deleted participant across every conversation they were in (admin deleteParticipant)", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const charlie = transport.addClient("charlie");

        // Bob is in two conversations and has read in both, so two activity rows exist
        const sharedId = await alice.createConversation();
        await alice.createInvite(sharedId, "bob");
        await bob.acceptInvite(sharedId);
        await alice.sendMessage(sharedId, "in shared");
        await bob.getMessages(sharedId, null, false, 10);

        const soloId = await charlie.createConversation();
        await charlie.createInvite(soloId, "bob");
        await bob.acceptInvite(soloId);
        await charlie.sendMessage(soloId, "in other");
        await bob.getMessages(soloId, null, false, 10);

        const bobActivities: { conversationId: string, data: ParticipantActivity | null }[] = [];
        await bob.onParticipantActivity(event => bobActivities.push(event));

        await transport.server.deleteParticipant("bob");
        await tick();

        // Both conversations bob was in surface a data: null event for bob
        expect(bobActivities.some(e => e.conversationId === sharedId && e.data === null)).toBe(true);
        expect(bobActivities.some(e => e.conversationId === soloId && e.data === null)).toBe(true);
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
        expect(convs.find(c => c.conversationId === conversationId)?.participantIds).toEqual(expect.arrayContaining(["alice", "bob", "charlie", "dave"]));
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

    test("addReaction broadcasts the updated message without re-reading it from the DB", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const conversationId = await alice.createConversation();
        await alice.createInvite(conversationId, "bob");
        await bob.acceptInvite(conversationId);
        const messageId = await alice.sendMessage(conversationId, "react to me");

        // Bob subscribes so the addReaction broadcast is exercised end-to-end
        const received: Message[] = [];
        await bob.onMessage(conversationId, m => received.push(m));

        transport.store.resetCounts();
        await bob.addReaction(messageId, "👍");
        await tick();

        // The pre-write existence check still reads the message once, but the post-write broadcast must use the locally-constructed updated message
        expect(transport.store.countOf("readMessage")).toBe(1);
        // The locally-constructed message that subscribers received must match what the DB now holds
        const broadcast = received.filter(m => m.messageId === messageId).at(-1);
        expect(broadcast).toEqual(transport.store.messages.get(messageId));
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

    test("removeReaction from the cached lastMessage patches and broadcasts locally without re-reading the message", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const conversationId = await alice.createConversation();
        await alice.createInvite(conversationId, "bob");
        await bob.acceptInvite(conversationId);
        const messageId = await alice.sendMessage(conversationId, "react then unreact");
        await bob.addReaction(messageId, "👍");
        const cachedAfterAdd = transport.conversationCache.get(conversationId);
        const reactionId = cachedAfterAdd!.lastMessage!.reactions[0]!.reactionId;

        const received: Message[] = [];
        await alice.onMessage(conversationId, m => received.push(m));

        transport.store.resetCounts();
        await bob.removeReaction(reactionId);
        await tick();

        // Cached lastMessage path skips readMessage entirely, the patched snapshot is broadcast as-is
        expect(transport.store.countOf("readMessage")).toBe(0);
        const cached = transport.conversationCache.get(conversationId);
        expect(cached?.lastMessage?.reactions).toHaveLength(0);
        expect(transport.store.cachedConversationMatchesDb(conversationId, cached)).toBe(true);
        // The broadcast subscribers received matches the persisted state
        const broadcast = received.filter(m => m.messageId === messageId).at(-1);
        expect(broadcast).toEqual(transport.store.messages.get(messageId));
    });

    test("removeReaction from a non-cached message falls back to a single readMessage to broadcast the post-removal state", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const conversationId = await alice.createConversation();
        await alice.createInvite(conversationId, "bob");
        await bob.acceptInvite(conversationId);

        // React to an older message, then send a newer one so the reacted message is no longer the conversation's lastMessage
        const olderMessageId = await alice.sendMessage(conversationId, "older");
        await bob.addReaction(olderMessageId, "👍");
        await alice.sendMessage(conversationId, "newer");
        const reactionId = transport.store.messages.get(olderMessageId)!.reactions[0]!.reactionId;

        const received: Message[] = [];
        await alice.onMessage(conversationId, m => received.push(m));

        transport.store.resetCounts();
        await bob.removeReaction(reactionId);
        await tick();

        // Fallback path needs exactly one readMessage to broadcast the post-removal state
        expect(transport.store.countOf("readMessage")).toBe(1);
        // The cache is untouched because the reacted message wasn't the lastMessage
        const cached = transport.conversationCache.get(conversationId);
        expect(cached?.lastMessage?.messageId).not.toBe(olderMessageId);
        // The broadcast carries the DB's current state for that message
        const broadcast = received.filter(m => m.messageId === olderMessageId).at(-1);
        expect(broadcast).toEqual(transport.store.messages.get(olderMessageId));
        expect(broadcast?.reactions).toHaveLength(0);
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

    test("acceptInvite patches the cached participants in place so the next read stays in cache", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const conversationId = await alice.createConversation();
        await alice.createInvite(conversationId, "bob");

        // Pre-condition: cache holds alice-only
        const beforeJoin = transport.conversationCache.get(conversationId);
        expect(beforeJoin?.participantIds).toEqual(["alice"]);

        transport.store.resetCounts();
        await bob.acceptInvite(conversationId);

        // The cache was patched in place rather than invalidated, no readConversation was needed for the join system message broadcast
        expect(transport.store.countOf("readConversation")).toBe(0);

        // Cached snapshot now reflects bob and matches the DB
        const cached = transport.conversationCache.get(conversationId);
        expect(cached?.participantIds).toEqual(expect.arrayContaining(["alice", "bob"]));
        expect(transport.store.cachedConversationMatchesDb(conversationId, cached)).toBe(true);
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
        expect(fresh?.participantIds).toEqual(["alice"]);
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

    test("admin joinConversation patches the cached participants in place so the next read stays in cache", async () => {
        const alice = transport.addClient("alice");
        transport.addClient("bob");
        const conversationId = await alice.createConversation();

        // Pre-condition: cache holds alice-only
        expect(transport.conversationCache.get(conversationId)?.participantIds).toEqual(["alice"]);

        transport.store.resetCounts();
        // Admin path - bypass invite flow
        await transport.server.joinConversation(conversationId, "bob");

        // Same in-place patching as acceptInvite
        expect(transport.store.countOf("readConversation")).toBe(0);
        const cached = transport.conversationCache.get(conversationId);
        expect(cached?.participantIds).toEqual(expect.arrayContaining(["alice", "bob"]));
        expect(transport.store.cachedConversationMatchesDb(conversationId, cached)).toBe(true);
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
        expect(transport.conversationCache.get(conversationId)?.participantIds).toEqual(expect.arrayContaining(["alice", "bob"]));

        await transport.server.deleteParticipant("bob");

        const cached = transport.conversationCache.get(conversationId);
        if (cached) expect(transport.store.cachedConversationMatchesDb(conversationId, cached)).toBe(true);
        const fresh = (await alice.getConversations("alice")).find(c => c.conversationId === conversationId);
        expect(fresh?.participantIds).toEqual(["alice"]);
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
        expect(cachedUnrelated?.participantIds).toEqual(expect.arrayContaining(["alice", "charlie"]));
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

describe("cache TTL eviction", () => {
    let transport: FakeTransport;

    beforeEach(() => { transport = new FakeTransport(); });
    afterEach(() => { transport.stop(); });

    test("conversation cache entries past the TTL are evicted on sweep", async () => {
        const alice = transport.addClient("alice");
        const conversationId = await alice.createConversation();
        expect(transport.conversationCache.get(conversationId)).toBeTruthy();

        // Sweep with a threshold in the future evicts everything (every entry's lastTouchedMs is now older than the threshold)
        transport.conversationCache.sweep(Date.now() + 1000);
        expect(transport.conversationCache.get(conversationId)).toBeUndefined();
    });

    test("activity cache entries past the TTL are evicted on sweep", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const conversationId = await alice.createConversation();
        await alice.createInvite(conversationId, "bob");
        await bob.acceptInvite(conversationId);
        await alice.sendMessage(conversationId, "msg");
        await bob.getMessages(conversationId, null, false, 10);

        const key = `${conversationId}|bob`;
        expect(transport.activityCache.get(key)).toBeDefined();

        transport.activityCache.sweep(Date.now() + 1000);
        expect(transport.activityCache.get(key)).toBeUndefined();
    });

    test("a fresh write to an entry resets its lifetime, while a stale entry next to it gets evicted", async () => {
        const alice = transport.addClient("alice");
        const staleId = await alice.createConversation();
        const freshId = await alice.createConversation();

        // Tiny wait (5ms) so the threshold lands strictly between the create timestamps and the upcoming refresh
        await new Promise(resolve => setTimeout(resolve, 5));
        const thresholdBetween = Date.now();
        await alice.sendMessage(freshId, "fresh write");

        transport.conversationCache.sweep(thresholdBetween);
        // staleId was last touched before the threshold, gets evicted
        expect(transport.conversationCache.get(staleId)).toBeUndefined();
        // freshId was re-touched by sendMessage after the threshold, survives
        expect(transport.conversationCache.get(freshId)).toBeTruthy();
    });

    test("the periodic cache sweep wired in CleanupScheduler evicts past-TTL entries automatically", async () => {
        const tight = new FakeTransport(undefined, {
            cacheEntryTtlMinutes: 1 / 60, // 1 second TTL
            cacheCleanupIntervalSeconds: 1, // sweep every second
        });
        try {
            const alice = tight.addClient("alice");
            const conversationId = await alice.createConversation();
            expect(tight.conversationCache.get(conversationId)).toBeTruthy();

            // Wait past TTL + at least one sweep tick
            await new Promise(resolve => setTimeout(resolve, 2200));
            expect(tight.conversationCache.get(conversationId)).toBeUndefined();
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
        const activities: { conversationId: string, data: ParticipantActivity | null }[] = [];
        const messageHandler = (m: Message) => messages.push(m);
        const indicatorHandler = (i: Indicator[]) => indicators.push(i);
        const conversationHandler = (e: { conversationId: string, data: Conversation | null }) => conversations.push(e);
        const inviteHandler = (e: { conversationId: string, toParticipantId: string, data: Invite | null }) => invites.push(e);
        const activityHandler = (e: { conversationId: string, data: ParticipantActivity | null }) => activities.push(e);

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

    test("daily messageAfterDays cleanup deletes old messages, posts a messagesRemoved marker, and keeps cache in sync with DB", async () => {
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
            const lastActivityBefore = transport.store.conversations.get(conversationId)!.lastActivityAt.getTime();

            await runDaily(transport);

            expect(transport.store.messages.has(oldMessageId)).toBe(false);

            // The conversation now contains exactly one message: the messagesRemoved marker authored by "server"
            const remaining = [...transport.store.messages.values()].filter(m => m.conversationId === conversationId);
            expect(remaining).toHaveLength(1);
            expect(remaining[0]?.systemEvent?.type).toBe("messagesRemoved");
            expect(remaining[0]?.participantId).toBe("server");

            // lastActivityAt must not have been pulled forward by the backdated marker
            const lastActivityAfter = transport.store.conversations.get(conversationId)!.lastActivityAt.getTime();
            expect(lastActivityAfter).toBe(lastActivityBefore);

            // Cache and DB still agree after the cleanup + marker post
            expect(transport.store.cachedConversationMatchesDb(conversationId, transport.conversationCache.get(conversationId))).toBe(true);
        } finally {
            transport.stop();
        }
    });

    test("daily messageAfterDays cleanup does not stack markers on consecutive runs", async () => {
        const transport = new FakeTransport(undefined, { messageAfterDays: 1 });
        try {
            const alice = transport.addClient("alice");
            const conversationId = await alice.createConversation();
            const oldMessageId = await alice.sendMessage(conversationId, "old");

            // Age the message so the first cleanup run will delete it and post a marker
            const backdated = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
            transport.store.messages.get(oldMessageId)!.createdAt = backdated;

            await runDaily(transport);
            const afterFirstRun = [...transport.store.messages.values()].filter(m => m.conversationId === conversationId).length;
            expect(afterFirstRun).toBe(1);

            // Second run with no new activity, the existing marker is still recent enough not to be deleted, and the dedup check should skip posting another one
            await runDaily(transport);
            const afterSecondRun = [...transport.store.messages.values()].filter(m => m.conversationId === conversationId).length;
            expect(afterSecondRun).toBe(1);
        } finally {
            transport.stop();
        }
    });

    test("daily messageAfterDays cleanup with mixed message ages: only the expired ones get deleted, surviving messages stay, marker is the oldest, cache's lastMessage stays anchored to the newest real message, and the marker is persisted but not broadcast", async () => {
        const transport = new FakeTransport(undefined, { messageAfterDays: 1 });
        try {
            const alice = transport.addClient("alice");
            const bob = transport.addClient("bob");
            const conversationId = await alice.createConversation();
            await alice.createInvite(conversationId, "bob");
            await bob.acceptInvite(conversationId);

            // Two old messages that should age out + two recent ones that survive
            const oldA = await alice.sendMessage(conversationId, "old A");
            const oldB = await bob.sendMessage(conversationId, "old B");
            const recentA = await alice.sendMessage(conversationId, "recent A");
            const recentB = await bob.sendMessage(conversationId, "recent B");

            const backdated = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
            transport.store.messages.get(oldA)!.createdAt = backdated;
            transport.store.messages.get(oldB)!.createdAt = backdated;

            // Bob subscribes so we can verify the marker is NOT pushed to live subscribers (the older messages are already in the client's view, the marker only matters on next refresh)
            const liveMessages: Message[] = [];
            const liveConversations: { conversationId: string, data: Conversation | null }[] = [];
            await bob.onMessage(conversationId, m => liveMessages.push(m));
            await bob.onConversation(e => liveConversations.push(e));

            await runDaily(transport);
            await tick();

            // Old ones gone, recent ones survive, plus exactly one marker
            expect(transport.store.messages.has(oldA)).toBe(false);
            expect(transport.store.messages.has(oldB)).toBe(false);
            expect(transport.store.messages.has(recentA)).toBe(true);
            expect(transport.store.messages.has(recentB)).toBe(true);

            const conversationMessages = [...transport.store.messages.values()].filter(m => m.conversationId === conversationId);
            const markers = conversationMessages.filter(m => m.systemEvent?.type === "messagesRemoved");
            expect(markers).toHaveLength(1);
            // recentA + recentB + the participantJoined system message from bob's accept + the new marker
            expect(conversationMessages).toHaveLength(4);

            // The marker sorts as the oldest message, so it shows up at the top of message history
            const sortedAsc = [...conversationMessages].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
            expect(sortedAsc[0]?.messageId).toBe(markers[0]?.messageId);

            // The cache's lastMessage is still recentB (the newest real message), not the backdated marker
            const cached = transport.conversationCache.get(conversationId);
            expect(cached?.lastMessage?.messageId).toBe(recentB);
            expect(transport.store.cachedConversationMatchesDb(conversationId, cached)).toBe(true);

            // No message-scope or conversation-scope event was fired for the marker
            expect(liveMessages.find(m => m.messageId === markers[0]?.messageId)).toBeUndefined();
            expect(liveConversations.find(e => e.data?.lastMessage?.messageId === markers[0]?.messageId)).toBeUndefined();

            // But the marker IS reachable via getMessages (next refresh path)
            const fetched = await bob.getMessages(conversationId, null, false, 10);
            expect(fetched.messages.some(m => m.messageId === markers[0]?.messageId)).toBe(true);
        } finally {
            transport.stop();
        }
    });

    test("daily messageAfterDays cleanup rolls the marker forward: an old marker that itself ages out gets deleted and a fresh one takes its place", async () => {
        const transport = new FakeTransport(undefined, { messageAfterDays: 1 });
        try {
            const alice = transport.addClient("alice");
            const conversationId = await alice.createConversation();

            // First-run setup: an old user message + an existing marker that itself is older than the threshold (e.g. left over from many days ago)
            const oldUserMsgId = await alice.sendMessage(conversationId, "older user message");
            const veryOld = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
            transport.store.messages.get(oldUserMsgId)!.createdAt = veryOld;

            // Pre-existing stale marker, also expired
            const staleMarkerId = "stale-marker";
            transport.store.messages.set(staleMarkerId, {
                messageId: staleMarkerId,
                conversationId,
                message: "",
                messageOptions: { referenceMessageId: null, isForwarded: false },
                participantId: "server",
                reactions: [],
                deleted: false,
                systemEvent: { type: "messagesRemoved" },
                createdAt: veryOld,
                modifiedAt: null,
            });

            // Add a fresh message that should survive
            const freshId = await alice.sendMessage(conversationId, "fresh");

            await runDaily(transport);

            // Old user message and stale marker both got deleted, fresh message survives
            expect(transport.store.messages.has(oldUserMsgId)).toBe(false);
            expect(transport.store.messages.has(staleMarkerId)).toBe(false);
            expect(transport.store.messages.has(freshId)).toBe(true);

            // Exactly one fresh marker now exists in the conversation
            const markers = [...transport.store.messages.values()].filter(m => m.conversationId === conversationId && m.systemEvent?.type === "messagesRemoved");
            expect(markers).toHaveLength(1);
            expect(markers[0]?.messageId).not.toBe(staleMarkerId);
        } finally {
            transport.stop();
        }
    });

    test("daily messageAfterDays cleanup keeps cache consistent with DB when handler-side dedup skips the marker insert", async () => {
        const transport = new FakeTransport(undefined, { messageAfterDays: 1 });
        try {
            const alice = transport.addClient("alice");
            const conversationId = await alice.createConversation();

            // A pre-existing marker that survives this run (createdAt within the retention window)
            const survivingMarkerId = "surviving-marker";
            const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
            transport.store.messages.set(survivingMarkerId, {
                messageId: survivingMarkerId,
                conversationId,
                message: "",
                messageOptions: { referenceMessageId: null, isForwarded: false },
                participantId: "server",
                reactions: [],
                deleted: false,
                systemEvent: { type: "messagesRemoved" },
                createdAt: oneHourAgo,
                modifiedAt: null,
            });

            // A user message that the cache holds as lastMessage, then backdate it past the threshold so it expires
            const oldUserMsgId = await alice.sendMessage(conversationId, "old user message");
            const backdated = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
            transport.store.messages.get(oldUserMsgId)!.createdAt = backdated;
            const cached = transport.conversationCache.get(conversationId)!;
            cached.lastMessage!.createdAt = backdated;
            transport.conversationCache.set(conversationId, cached);

            await runDaily(transport);

            // The expired user message is gone, the surviving marker is still the only message in the conversation, and no new marker was inserted (handler-side dedup)
            expect(transport.store.messages.has(oldUserMsgId)).toBe(false);
            const remaining = [...transport.store.messages.values()].filter(m => m.conversationId === conversationId);
            expect(remaining).toHaveLength(1);
            expect(remaining[0]?.messageId).toBe(survivingMarkerId);

            // The cached lastMessage must point at a row that actually exists in the DB, not a phantom system message that the handler dedup-skipped
            const cachedAfter = transport.conversationCache.get(conversationId);
            if (cachedAfter?.lastMessage) {
                expect(transport.store.messages.has(cachedAfter.lastMessage.messageId)).toBe(true);
            }
            expect(transport.store.cachedConversationMatchesDb(conversationId, cachedAfter)).toBe(true);
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

    test("dispose unsubscribes the server from all active scopes so events stop being pushed even when the transport stays open", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const conversationId = await alice.createConversation();
        await alice.createInvite(conversationId, "bob");
        await bob.acceptInvite(conversationId);

        // Bob subscribes broadly so dispose has multiple scopes to unsubscribe from
        const messages: Message[] = [];
        const conversations: { conversationId: string, data: Conversation | null }[] = [];
        const indicators: Indicator[][] = [];
        await bob.onMessage(conversationId, m => messages.push(m));
        await bob.onConversation(e => conversations.push(e));
        await bob.onIndicators(conversationId, i => indicators.push(i));

        // Sanity: the subscriptions are live, alice typing reaches bob
        await alice.setIndicator(conversationId);
        await tick();
        expect(indicators.length).toBeGreaterThan(0);

        const beforeDisposeCounts = { messages: messages.length, conversations: conversations.length, indicators: indicators.length };

        bob.dispose();
        await tick();

        // After dispose, alice's actions still fire on the server but bob's transport receives nothing for those scopes
        await alice.sendMessage(conversationId, "should not reach disposed bob");
        await alice.setIndicator(conversationId);
        await tick();

        expect(messages.length).toBe(beforeDisposeCounts.messages);
        expect(conversations.length).toBe(beforeDisposeCounts.conversations);
        expect(indicators.length).toBe(beforeDisposeCounts.indicators);
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

describe("database call counts sanity checks", () => {
    let transport: FakeTransport;

    beforeEach(() => { transport = new FakeTransport(); });
    afterEach(() => { transport.stop(); });

    test("deleting a user with 10 conversations: solo conversations get auto-deleted, shared ones survive without the user, activities + invites cleared, and DB calls stay bounded regardless of conversation count", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const charlie = transport.addClient("charlie");

        // 5 conversations where bob is the sole participant - should auto-delete
        const soloIds: string[] = [];
        for (let i = 0; i < 5; i++) soloIds.push(await bob.createConversation());

        // 5 conversations where bob shares with alice or charlie - should survive without bob
        const sharedIds: string[] = [];
        for (let i = 0; i < 5; i++) {
            const id = await alice.createConversation();
            await alice.createInvite(id, "bob");
            await bob.acceptInvite(id);
            sharedIds.push(id);
        }

        // Each shared conversation has a message + bob has an activity row
        for (const id of sharedIds) {
            await alice.sendMessage(id, "hi bob");
            await bob.getMessages(id, null, false, 10);
        }

        // Outstanding invites to bob from two different senders - both should be cleaned up
        const pendingInviteFromAlice = await alice.createConversation();
        await alice.createInvite(pendingInviteFromAlice, "bob");
        const pendingInviteFromCharlie = await charlie.createConversation();
        await charlie.createInvite(pendingInviteFromCharlie, "bob");

        // Pre-conditions
        expect(transport.store.conversationParticipants.get(soloIds[0]!)?.has("bob")).toBe(true);
        expect(transport.store.conversationParticipants.get(sharedIds[0]!)?.has("bob")).toBe(true);
        expect(transport.store.activities.size).toBeGreaterThan(0);
        expect(transport.store.invites.filter(i => i.toParticipantId === "bob")).toHaveLength(2);

        // Reset call counters so we measure only the deleteParticipant work
        transport.store.resetCounts();
        await transport.server.deleteParticipant("bob");

        // Correctness: all 5 solo conversations gone (auto-deleted)
        for (const id of soloIds) {
            expect(transport.store.conversations.has(id)).toBe(false);
        }

        // Correctness: all 5 shared conversations survive but without bob
        for (const id of sharedIds) {
            expect(transport.store.conversations.has(id)).toBe(true);
            expect(transport.store.conversationParticipants.get(id)?.has("bob")).toBe(false);
            // Bob's activity for this conversation is gone
            expect(transport.store.activities.has(`${id}|bob`)).toBe(false);
        }

        // Correctness: no invites for or by bob remain
        expect(transport.store.invites.filter(i => i.toParticipantId === "bob" || i.fromParticipantId === "bob")).toHaveLength(0);

        // Cost: bulk handler keeps total DB calls bounded, not scaling with conversation count
        // 1 call for the bulk leave-all + 2 for invites (read involving + bulk delete) = 3 total
        const totalDbCalls = [...transport.store.callCounts.values()].reduce((a, b) => a + b, 0);
        expect(totalDbCalls).toBeLessThanOrEqual(3);
    });

    test("a typical activity scenario stays well-cached: create + invite + accept + messages + reactions + edits + indicators + reads should not flood the DB", async () => {
        const alice = transport.addClient("alice");
        const bob = transport.addClient("bob");
        const charlie = transport.addClient("charlie");

        // Subscribe everyone so realtime fan-out is exercised, not just request/response
        await alice.onConversation(() => {});
        await bob.onConversation(() => {});
        await charlie.onConversation(() => {});
        await alice.onInvite(() => {});
        await bob.onInvite(() => {});
        await charlie.onInvite(() => {});

        transport.store.resetCounts();

        // Alice opens a 3-person conversation, invites bob and charlie, both accept
        const conversationId = await alice.createConversation(3);
        await alice.createInvite(conversationId, "bob");
        await alice.createInvite(conversationId, "charlie");
        await bob.acceptInvite(conversationId);
        await charlie.acceptInvite(conversationId);

        // All three subscribe to messages and indicators on the conversation
        await alice.onMessage(conversationId, () => {});
        await bob.onMessage(conversationId, () => {});
        await charlie.onMessage(conversationId, () => {});
        await alice.onIndicators(conversationId, () => {});
        await bob.onIndicators(conversationId, () => {});
        await charlie.onIndicators(conversationId, () => {});

        // A back-and-forth chat: 6 messages, a reaction, an edit, typing indicators
        const m1 = await alice.sendMessage(conversationId, "hey folks");
        await bob.setIndicator(conversationId);
        const m2 = await bob.sendMessage(conversationId, "hi alice");
        await charlie.setIndicator(conversationId);
        const m3 = await charlie.sendMessage(conversationId, "hello!");
        await alice.sendMessage(conversationId, "how's it going");
        await bob.addReaction(m1, "👍");
        await alice.editMessage(m1, "hey folks!");
        await bob.sendMessage(conversationId, "good here");
        await charlie.sendMessage(conversationId, "same");

        // Each participant catches up: list conversations + read the message page + mark activity
        for (const client of [alice, bob, charlie]) {
            await client.getConversations(client === alice ? "alice" : client === bob ? "bob" : "charlie");
            await client.getMessages(conversationId, null, false, 20);
        }

        // A second 1-1 conversation between alice and charlie with a couple of messages
        const dmId = await alice.createConversation(2);
        await alice.createInvite(dmId, "charlie");
        await charlie.acceptInvite(dmId);
        await alice.sendMessage(dmId, "quick question");
        await charlie.sendMessage(dmId, "shoot");

        await tick();

        // Sanity: state landed correctly
        expect(transport.store.conversationParticipants.get(conversationId)?.size).toBe(3);
        expect(transport.store.conversationParticipants.get(dmId)?.size).toBe(2);
        expect(transport.store.messages.get(m1)?.message).toBe("hey folks!");
        expect(transport.store.messages.get(m1)?.reactions.some(r => r.content === "👍")).toBe(true);
        void m2; void m3;

        const totalDbCalls = [...transport.store.callCounts.values()].reduce((a, b) => a + b, 0);
        expect(totalDbCalls).toBeLessThanOrEqual(41);
    });

    test("daily messageAfterDays cleanup makes a constant number of DB calls regardless of how many conversations have expiring messages", async () => {
        const tight = new FakeTransport({ messageLimitPerSecond: 1000 }, { messageAfterDays: 1 });
        try {
            // Build up many conversations (just over the threshold of "many") and put one expiring message in each so they all qualify for the marker post
            const N = 50;
            const owner = tight.addClient("owner");
            const ids: string[] = [];
            for (let i = 0; i < N; i++) {
                const id = await owner.createConversation();
                const messageId = await owner.sendMessage(id, `m${i}`);
                tight.store.messages.get(messageId)!.createdAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
                ids.push(id);
            }

            // Reset counts so we measure only the cleanup work
            tight.store.resetCounts();
            await (tight.server as unknown as { scheduler: { runDaily: () => Promise<void> } }).scheduler.runDaily();
            await tick();

            // Sanity: every conversation has its old message gone and exactly one marker
            for (const id of ids) {
                const remaining = [...tight.store.messages.values()].filter(m => m.conversationId === id);
                expect(remaining).toHaveLength(1);
                expect(remaining[0]?.systemEvent?.type).toBe("messagesRemoved");
            }

            // Cost guardrail: total DB calls must NOT scale with N, exactly 2 (deleteMessagesBefore + bulk-insert system messages with dedup baked in)
            const totalDbCalls = [...tight.store.callCounts.values()].reduce((a, b) => a + b, 0);
            expect(totalDbCalls).toBe(2);
        } finally {
            tight.stop();
        }
    });

    test("daily conversationAfterInactiveDays cleanup makes a constant number of DB calls regardless of how many conversations are deleted", async () => {
        const tight = new FakeTransport(undefined, { conversationAfterInactiveDays: 1 });
        try {
            const N = 50;
            const owner = tight.addClient("owner");
            const ids: string[] = [];
            for (let i = 0; i < N; i++) {
                const id = await owner.createConversation();
                tight.store.conversations.get(id)!.lastActivityAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
                ids.push(id);
            }

            tight.store.resetCounts();
            await (tight.server as unknown as { scheduler: { runDaily: () => Promise<void> } }).scheduler.runDaily();
            await tick();

            // Sanity: all of them are gone
            for (const id of ids) expect(tight.store.conversations.has(id)).toBe(false);

            // Cost guardrail: one bulk handler call covers all of them
            const totalDbCalls = [...tight.store.callCounts.values()].reduce((a, b) => a + b, 0);
            expect(totalDbCalls).toBeLessThanOrEqual(2);
        } finally {
            tight.stop();
        }
    });

    test("daily inviteAfterDays cleanup makes a constant number of DB calls regardless of how many invites expire", async () => {
        const tight = new FakeTransport({ inviteLimitPerHour: 10000 }, { inviteAfterDays: 1 });
        try {
            const N = 50;
            const sender = tight.addClient("sender");
            // Create N conversations so each can hold one outgoing invite
            for (let i = 0; i < N; i++) {
                tight.addClient(`recipient${i}`);
                const id = await sender.createConversation();
                await sender.createInvite(id, `recipient${i}`);
            }
            // Backdate every invite so they all expire
            const expired = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
            for (const invite of tight.store.invites) invite.createdAt = expired;

            tight.store.resetCounts();
            await (tight.server as unknown as { scheduler: { runDaily: () => Promise<void> } }).scheduler.runDaily();
            await tick();

            // Sanity: all invites gone
            expect(tight.store.invites).toHaveLength(0);

            // Cost guardrail: one bulk handler call covers all of them
            const totalDbCalls = [...tight.store.callCounts.values()].reduce((a, b) => a + b, 0);
            expect(totalDbCalls).toBeLessThanOrEqual(2);
        } finally {
            tight.stop();
        }
    });
});