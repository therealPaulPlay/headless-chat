import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type { Conversation, Indicator, Invite, Message } from "../src/shared/shared-types.js";
import { FakeTransport, tick } from "./helpers/wire.js";

describe("e2e", () => {
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