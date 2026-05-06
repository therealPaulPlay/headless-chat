import type { Server } from "../../src/server/server.js";
import type { Conversation, ConversationRecord, Invite, Message, ParticipantActivity, Reaction } from "../../src/shared/shared-types.js";

// Tiny in-memory faux-DB that implements all the handlers the lib expects
// Mirrors what a consumer would do with SQL but using maps and arrays
export class InMemoryStore {
    users = new Set<string>();
    conversations = new Map<string, ConversationRecord>();
    conversationParticipants = new Map<string, Set<string>>(); // conversationId -> set of participantIds
    messages = new Map<string, Message>();
    reactions = new Map<string, Reaction>();
    invites: Invite[] = [];
    activities = new Map<string, ParticipantActivity>(); // key: conversationId|participantId
    aliases = new Map<string, string>(); // participantId -> alias

    // Per-handler call counters, used by tests to assert cache hits / misses
    callCounts = new Map<string, number>();
    private bump(handler: string): void { this.callCounts.set(handler, (this.callCounts.get(handler) ?? 0) + 1); }
    countOf(handler: string): number { return this.callCounts.get(handler) ?? 0; }
    resetCounts(): void { this.callCounts.clear(); }

    // Returns true if the cached snapshot reflects current DB state. Pass undefined to assert "no DB row exists for this conversationId either"
    cachedConversationMatchesDb(conversationId: string, snapshot: Conversation | undefined): boolean {
        const record = this.conversations.get(conversationId);
        if (!record) return snapshot === undefined;
        if (!snapshot) return false;
        return JSON.stringify(snapshot) === JSON.stringify(this.surfaceConversation(record));
    }

    // Returns true if the cached activity timestamp matches the DB. Pass undefined to assert "no DB row exists for (conv, participant) either"
    cachedActivityMatchesDb(conversationId: string, participantId: string, cachedTs: number | undefined): boolean {
        const stored = this.activities.get(this.activityKey(conversationId, participantId));
        if (!stored) return cachedTs === undefined;
        return cachedTs === stored.lastReadMessageCreatedAt.getTime();
    }

    private activityKey(conversationId: string, participantId: string): string {
        return `${conversationId}|${participantId}`;
    }

    private surfaceConversation(record: ConversationRecord): Conversation {
        const messagesIn = [...this.messages.values()].filter(m => m.conversationId === record.conversationId);
        const lastMessage = messagesIn.length === 0 ? null : messagesIn.reduce((a, b) => a.createdAt.getTime() > b.createdAt.getTime() ? a : b);
        const participantIds = [...(this.conversationParticipants.get(record.conversationId) ?? [])];
        return { ...record, participantIds, lastMessage };
    }

    private isParticipant(conversationId: string, participantId: string): boolean {
        return this.conversationParticipants.get(conversationId)?.has(participantId) ?? false;
    }

    private countConversationsForParticipant(participantId: string): number {
        let count = 0;
        for (const set of this.conversationParticipants.values()) if (set.has(participantId)) count++;
        return count;
    }

    // Mirrors the consumer's transaction, used by both single-conversation and bulk delete handlers
    // Returns the invite pairs that were deleted so the library can broadcast and fire hooks
    private deleteConversationAndReturnInvites(conversationId: string): { fromParticipantId: string, toParticipantId: string }[] {
        const invitesForConversation = this.invites.filter(i => i.conversation.conversationId === conversationId);
        const deletedInvites = invitesForConversation.map(i => ({ fromParticipantId: i.fromParticipantId, toParticipantId: i.toParticipantId }));

        for (const [id, message] of this.messages) {
            if (message.conversationId === conversationId) {
                for (const r of message.reactions) this.reactions.delete(r.reactionId);
                this.messages.delete(id);
            }
        }
        this.invites = this.invites.filter(i => i.conversation.conversationId !== conversationId);
        for (const [key, activity] of this.activities) {
            if (activity.conversationId === conversationId) this.activities.delete(key);
        }
        this.conversationParticipants.delete(conversationId);
        this.conversations.delete(conversationId);

        return deletedInvites;
    }

    register(server: Server): void {

        // Create handlers -------------------------------------------------------------------

        server.onCreateConversation((record, creatorParticipantId, conversationLimitPerParticipant) => {
            this.bump("createConversation");
            // Atomic in JS, mirrors the consumer's transaction (per-participant cap check + insert conversation + insert creator seat)
            if (this.countConversationsForParticipant(creatorParticipantId) >= conversationLimitPerParticipant) {
                throw new Error("Per-participant conversation limit exceeded");
            }
            this.conversations.set(record.conversationId, { ...record });
            this.conversationParticipants.set(record.conversationId, new Set([creatorParticipantId]));
        });
        server.onCreateMessage(message => {
            this.bump("createMessage");
            // Participation guard
            if (!message.systemEvent && !this.isParticipant(message.conversationId, message.participantId)) {
                throw new Error("Not a participant of this conversation");
            }
            this.messages.set(message.messageId, { ...message, reactions: [] });
            // Mirror the consumer's transaction, lastActivityAt tracks the latest message but never regresses (backdated system messages must not pull it backwards)
            const conversation = this.conversations.get(message.conversationId);
            if (conversation && message.createdAt.getTime() >= conversation.lastActivityAt.getTime()) conversation.lastActivityAt = message.createdAt;
        });
        server.onCreateMessagesSystemRemoved(messages => {
            this.bump("createMessagesSystemRemoved");
            // Contract: the lib always calls this with at least one message, fail loud on regressions
            if (messages.length === 0) throw new Error("createMessagesSystemRemoved called with empty input");
            // Per-conversation dedup, skip the insert if the current oldest message is already a "messagesRemoved" system message. Either way return the resulting oldest message for that conversation
            const oldestMessagesByConversationId = new Map<string, Message>();
            for (const message of messages) {
                const inConversation = [...this.messages.values()].filter(m => m.conversationId === message.conversationId);
                const oldest = inConversation.reduce<typeof inConversation[number] | null>((acc, m) => !acc || m.createdAt.getTime() < acc.createdAt.getTime() ? m : acc, null);
                if (oldest?.systemEvent?.type === "messagesRemoved") {
                    oldestMessagesByConversationId.set(message.conversationId, { ...oldest });
                    continue;
                }
                this.messages.set(message.messageId, { ...message, reactions: [] });
                oldestMessagesByConversationId.set(message.conversationId, { ...message, reactions: [] });
                // No lastActivityAt bump, the system message is backdated and lastActivityAt should reflect the most recent real activity
            }
            return { oldestMessagesByConversationId };
        });
        server.onCreateReaction(reaction => {
            this.bump("createReaction");
            const message = this.messages.get(reaction.messageId);
            if (!message) throw new Error("Message not found");
            if (!this.isParticipant(message.conversationId, reaction.participantId)) throw new Error("Not a participant");
            // Spec: one reaction per (messageId, participantId) - drop any prior reaction by this participant on this message from both the nested list and the top-level map
            for (const prior of message.reactions.filter(r => r.participantId === reaction.participantId)) this.reactions.delete(prior.reactionId);
            message.reactions = message.reactions.filter(r => r.participantId !== reaction.participantId);
            message.reactions.push({ ...reaction });
            this.reactions.set(reaction.reactionId, { ...reaction });
        });
        server.onCreateInvite((invite, inviteLimitPerParticipant) => {
            this.bump("createInvite");
            const conversationId = invite.conversation.conversationId;

            // Ensure both participants exist as users
            if (!this.users.has(invite.fromParticipantId) || !this.users.has(invite.toParticipantId)) {
                throw new Error("Participant does not exist");
            }

            // Check if already a participant of this conversation
            if (this.isParticipant(conversationId, invite.toParticipantId)) throw new Error("Already a participant");

            // Per-participant outgoing invite cap, atomic with the dedup check below so the count cannot regress between read and insert
            const outgoing = this.invites.filter(i => i.fromParticipantId === invite.fromParticipantId).length;
            if (outgoing >= inviteLimitPerParticipant) throw new Error("Outgoing invite limit exceeded");

            // Dedup on the triple (conversationId, fromParticipantId, toParticipantId) - multiple senders can invite the same recipient
            const existing = this.invites.find(i =>
                i.conversation.conversationId === conversationId
                && i.fromParticipantId === invite.fromParticipantId
                && i.toParticipantId === invite.toParticipantId);
            if (existing) return { inserted: false };
            this.invites.push({ ...invite });
            return { inserted: true };
        });
        server.onCreateConversationParticipant((conversationId, participantId, conversationParticipantLimit, conversationLimitPerParticipant) => {
            this.bump("createConversationParticipant");
            const set = this.conversationParticipants.get(conversationId);
            if (!set) throw new Error("Conversation not found");
            if (set.has(participantId)) throw new Error("Already a participant");
            if (set.size >= conversationParticipantLimit) throw new Error("Conversation is full");
            if (this.countConversationsForParticipant(participantId) >= conversationLimitPerParticipant) {
                throw new Error("Per-participant conversation limit exceeded");
            }
            set.add(participantId);
        });
        server.onCreateConversationParticipantActivity(activity => {
            this.bump("createConversationParticipantActivity");
            if (!this.isParticipant(activity.conversationId, activity.participantId)) return;
            this.activities.set(this.activityKey(activity.conversationId, activity.participantId), { ...activity });
        });

        // Read handlers -----------------------------------------------------------
        
        server.onReadConversations(participantId => {
            this.bump("readConversations");
            return [...this.conversations.values()]
                .filter(c => this.isParticipant(c.conversationId, participantId))
                .map(c => this.surfaceConversation(c));
        });
        server.onReadConversation(conversationId => {
            this.bump("readConversation");
            const record = this.conversations.get(conversationId);
            return record ? this.surfaceConversation(record) : null;
        });
        server.onReadMessages((conversationId, cursorMessageId, after, amount) => {
            this.bump("readMessages");
            // All messages of the conversation, sorted oldest -> newest
            const all = [...this.messages.values()]
                .filter(m => m.conversationId === conversationId)
                .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

            // Null cursor returns the newest page; remaining = anything older
            if (cursorMessageId === null) {
                const pool = all.slice(-amount);
                return { messages: pool, remainingInDirection: Math.max(0, all.length - pool.length) };
            }

            // Locate the cursor in the sorted list
            const cursorIdx = all.findIndex(m => m.messageId === cursorMessageId);
            if (cursorIdx === -1) return { messages: [], remainingInDirection: 0 };

            // The cursor message is never included in the result
            if (after) {
                // Strictly newer - remaining = newer beyond what we returned
                const pool = all.slice(cursorIdx + 1, cursorIdx + 1 + amount);
                const consumedTo = cursorIdx + 1 + pool.length;
                return { messages: pool, remainingInDirection: Math.max(0, all.length - consumedTo) };
            }

            // Strictly older - remaining = older beyond what we returned
            const start = Math.max(0, cursorIdx - amount);
            const pool = all.slice(start, cursorIdx);
            return { messages: pool, remainingInDirection: start };
        });
        server.onReadMessage(messageId => {
            this.bump("readMessage");
            const message = this.messages.get(messageId);
            return message ? { ...message, reactions: [...message.reactions] } : null;
        });
        server.onReadMessagesByIds(messageIds => {
            this.bump("readMessagesByIds");
            return messageIds.flatMap(id => {
                const m = this.messages.get(id);
                return m ? [{ ...m, reactions: [...m.reactions] }] : [];
            });
        });
        server.onReadConversationLastMessageMetadata(conversationId => {
            this.bump("readConversationLastMessageMetadata");
            let latest: Message | null = null;
            for (const message of this.messages.values()) {
                if (message.conversationId !== conversationId) continue;
                if (!latest || message.createdAt.getTime() >= latest.createdAt.getTime()) latest = message;
            }
            return latest ? { messageId: latest.messageId, createdAt: latest.createdAt } : null;
        });
        server.onReadReaction(reactionId => {
            this.bump("readReaction");
            for (const message of this.messages.values()) {
                const reaction = message.reactions.find(r => r.reactionId === reactionId);
                if (reaction) return { ...reaction };
            }
            return null;
        });
        server.onReadInvitesInvolvingParticipant(participantId => {
            this.bump("readInvitesInvolvingParticipant");
            return this.invites
                .filter(i => i.fromParticipantId === participantId || i.toParticipantId === participantId)
                .map(i => ({ ...i }));
        });
        server.onReadInvitesForRecipient((conversationId, toParticipantId) => {
            this.bump("readInvitesForRecipient");
            return this.invites
                .filter(i => i.conversation.conversationId === conversationId && i.toParticipantId === toParticipantId)
                .map(i => ({ ...i }));
        });
        server.onReadInvite((conversationId, fromParticipantId, toParticipantId) => {
            this.bump("readInvite");
            const found = this.invites.find(i =>
                i.conversation.conversationId === conversationId
                && i.fromParticipantId === fromParticipantId
                && i.toParticipantId === toParticipantId);
            return found ? { ...found } : null;
        });
        server.onReadAliases(participantIds => {
            this.bump("readAliases");
            return participantIds.flatMap(pid => {
                const alias = this.aliases.get(pid);
                return alias ? [{ participantId: pid, alias }] : [];
            });
        });
        server.onReadConversationParticipantActivity((conversationId, participantId) => {
            this.bump("readConversationParticipantActivity");
            const found = this.activities.get(this.activityKey(conversationId, participantId));
            return found ? { ...found } : null;
        });
        server.onReadParticipantActivities(participantId => {
            this.bump("readParticipantActivities");
            return [...this.activities.values()].filter(a => a.participantId === participantId).map(a => ({ ...a }));
        });

        // Update handlers -----------------------------------------------

        server.onUpdateMessage(message => {
            this.bump("updateMessage");
            const existing = this.messages.get(message.messageId);
            if (!existing) throw new Error("Message not found");
            // Spec: existing reactions are preserved across edits
            this.messages.set(message.messageId, { ...message, reactions: existing.reactions });
        });
        server.onUpdateConversationParticipantActivity(activity => {
            this.bump("updateConversationParticipantActivity");
            if (!this.isParticipant(activity.conversationId, activity.participantId)) return;
            this.activities.set(this.activityKey(activity.conversationId, activity.participantId), { ...activity });
        });

        // Delete handlers ----------------------------------------------------

        server.onDeleteReaction(reactionId => {
            this.bump("deleteReaction");
            this.reactions.delete(reactionId);
            for (const message of this.messages.values()) {
                const idx = message.reactions.findIndex(r => r.reactionId === reactionId);
                if (idx >= 0) { message.reactions.splice(idx, 1); return; }
            }
        });
        server.onDeleteConversationParticipantAndParticipantActivity((conversationId, participantId) => {
            this.bump("deleteConversationParticipantAndParticipantActivity");
            // Atomic in JS, mirrors the consumer's transaction (remove participant seat + delete their activity row)
            this.conversationParticipants.get(conversationId)?.delete(participantId);
            this.activities.delete(this.activityKey(conversationId, participantId));
        });
        server.onDeleteAllConversationParticipantsAndParticipantActivitiesForParticipant(participantId => {
            this.bump("deleteAllConversationParticipantsAndParticipantActivitiesForParticipant");
            const deletedConversations: { conversationId: string, formerParticipantIds: string[], deletedInvites: { fromParticipantId: string, toParticipantId: string }[] }[] = [];
            const remainingConversations: { conversationId: string, conversationRecord: ConversationRecord, remainingParticipantIds: string[], lastMessage: Message | null }[] = [];
            for (const [conversationId, set] of [...this.conversationParticipants]) {
                if (!set.has(participantId)) continue;
                if (set.size === 1) {
                    // Last member, cascade-delete the whole conversation
                    const formerParticipantIds = [...set];
                    const deletedInvites = this.deleteConversationAndReturnInvites(conversationId);
                    deletedConversations.push({ conversationId, formerParticipantIds, deletedInvites });
                } else {
                    // Remove this participant + their activity, surface the post-removal state
                    set.delete(participantId);
                    this.activities.delete(this.activityKey(conversationId, participantId));
                    const record = this.conversations.get(conversationId)!;
                    const surfaced = this.surfaceConversation(record);
                    remainingConversations.push({ conversationId, conversationRecord: { ...record }, remainingParticipantIds: surfaced.participantIds, lastMessage: surfaced.lastMessage });
                }
            }
            return { deletedConversations, remainingConversations };
        });
        server.onDeleteConversationWithMessagesReactionsInvitesAndActivities(conversationId => {
            this.bump("deleteConversationWithMessagesReactionsInvitesAndActivities");
            const deletedInvites = this.deleteConversationAndReturnInvites(conversationId);
            return { deletedInvites };
        });
        server.onDeleteInvites(invites => {
            this.bump("deleteInvites");
            this.invites = this.invites.filter(existing => !invites.some(target =>
                target.conversationId === existing.conversation.conversationId
                && target.fromParticipantId === existing.fromParticipantId
                && target.toParticipantId === existing.toParticipantId));
        });
        server.onDeleteMessagesBefore(thresholdDate => {
            this.bump("deleteMessagesBefore");
            const affected = new Set<string>();
            for (const [id, m] of this.messages) {
                if (m.createdAt.getTime() < thresholdDate.getTime()) {
                    affected.add(m.conversationId);
                    for (const r of m.reactions) this.reactions.delete(r.reactionId);
                    this.messages.delete(id);
                }
            }
            return { affectedConversationIds: [...affected] };
        });
        server.onDeleteConversationsWithMessagesReactionsInvitesAndActivitiesBefore(thresholdDate => {
            this.bump("deleteConversationsWithMessagesReactionsInvitesAndActivitiesBefore");
            const deletedConversations: { conversationId: string, formerParticipantIds: string[], deletedInvites: { fromParticipantId: string, toParticipantId: string }[] }[] = [];
            for (const [conversationId, conversation] of [...this.conversations]) {
                if (conversation.lastActivityAt.getTime() >= thresholdDate.getTime()) continue;

                const formerParticipantIds = [...(this.conversationParticipants.get(conversationId) ?? [])];
                const deletedInvites = this.deleteConversationAndReturnInvites(conversationId);
                deletedConversations.push({ conversationId, formerParticipantIds, deletedInvites });
            }
            return { deletedConversations };
        });
        server.onDeleteInvitesBefore(thresholdDate => {
            this.bump("deleteInvitesBefore");
            const expired = this.invites.filter(i => i.createdAt.getTime() < thresholdDate.getTime());
            this.invites = this.invites.filter(i => i.createdAt.getTime() >= thresholdDate.getTime());
            const deletedInvites = expired.map(i => ({
                conversationId: i.conversation.conversationId,
                fromParticipantId: i.fromParticipantId,
                toParticipantId: i.toParticipantId,
            }));
            return { deletedInvites };
        });

        // Validation handlers ------------------------------------------------
        
        server.onParticipantAuth((participantId, authData) => {
            return authData === `token-${participantId}`;
        });
    }
}
