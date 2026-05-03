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

    private activityKey(conversationId: string, participantId: string): string {
        return `${conversationId}|${participantId}`;
    }

    private surfaceConversation(record: ConversationRecord): Conversation {
        const messagesIn = [...this.messages.values()].filter(m => m.conversationId === record.conversationId);
        const lastMessage = messagesIn.length === 0 ? null : messagesIn.reduce((a, b) => a.createdAt.getTime() > b.createdAt.getTime() ? a : b);
        const participants = [...(this.conversationParticipants.get(record.conversationId) ?? [])];
        return { ...record, participants, lastMessage };
    }

    private isParticipant(conversationId: string, participantId: string): boolean {
        return this.conversationParticipants.get(conversationId)?.has(participantId) ?? false;
    }

    // Mirrors the consumer's transaction, used by both single-conversation and bulk delete handlers
    // Returns the invite pairs that were deleted so the library can broadcast and fire hooks
    private deleteConversationAndReturnInvites(conversationId: string): { fromParticipantId: string, toParticipantId: string }[] {
        const invitesForConversation = this.invites.filter(i => i.conversation.conversationId === conversationId);
        const deletedInvites = invitesForConversation.map(i => ({ fromParticipantId: i.fromParticipantId, toParticipantId: i.toParticipantId }));

        for (const [id, message] of this.messages) {
            if (message.conversationId === conversationId) this.messages.delete(id);
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

        server.onCreateConversation((record, creatorParticipantId) => {
            // Atomic in JS, mirrors the consumer's transaction (insert conversation + insert creator seat)
            this.conversations.set(record.conversationId, { ...record });
            this.conversationParticipants.set(record.conversationId, new Set([creatorParticipantId]));
        });
        server.onCreateMessage(message => {
            // Participation guard
            if (!message.systemEvent && !this.isParticipant(message.conversationId, message.participantId)) {
                throw new Error("Not a participant of this conversation");
            }
            this.messages.set(message.messageId, { ...message, reactions: [] });
        });
        server.onCreateReaction(reaction => {
            const message = this.messages.get(reaction.messageId);
            if (!message) throw new Error("Message not found");
            if (!this.isParticipant(message.conversationId, reaction.participantId)) throw new Error("Not a participant");
            // Dedup on (messageId, participantId)
            if (message.reactions.find(r => r.participantId === reaction.participantId && r.content === reaction.content)) return;
            message.reactions.push({ ...reaction });
        });
        server.onCreateInvite(invite => {
            const conversationId = invite.conversation.conversationId;
            
            // Ensure both participants exist as users
            if (!this.users.has(invite.fromParticipantId) || !this.users.has(invite.toParticipantId)) {
                throw new Error("Participant does not exist");
            }
            
            // Check if already a participant of this conversation
            if (this.isParticipant(conversationId, invite.toParticipantId)) throw new Error("Already a participant");
            
            // Dedup
            const existing = this.invites.find(i => i.conversation.conversationId === conversationId && i.toParticipantId === invite.toParticipantId);
            if (existing) return;
            this.invites.push({ ...invite });
        });
        server.onCreateConversationParticipantActivity(activity => {
            if (!this.isParticipant(activity.conversationId, activity.participantId)) return;
            this.activities.set(this.activityKey(activity.conversationId, activity.participantId), { ...activity });
        });

        // Read handlers -----------------------------------------------------------
        
        server.onReadConversations(participantId => {
            return [...this.conversations.values()]
                .filter(c => this.isParticipant(c.conversationId, participantId))
                .map(c => this.surfaceConversation(c));
        });
        server.onReadConversation(conversationId => {
            const record = this.conversations.get(conversationId);
            return record ? this.surfaceConversation(record) : null;
        });
        server.onReadMessages((conversationId, cursorMessageId, after, amount) => {
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
            const message = this.messages.get(messageId);
            return message ? { ...message, reactions: [...message.reactions] } : null;
        });
        server.onReadConversationLastMessage(conversationId => {
            let latest: Message | null = null;
            for (const message of this.messages.values()) {
                if (message.conversationId !== conversationId) continue;
                if (!latest || message.createdAt.getTime() >= latest.createdAt.getTime()) latest = message;
            }
            return latest ? { messageId: latest.messageId, createdAt: latest.createdAt } : null;
        });
        server.onReadReaction(reactionId => {
            for (const message of this.messages.values()) {
                const reaction = message.reactions.find(r => r.reactionId === reactionId);
                if (reaction) return { ...reaction };
            }
            return null;
        });
        server.onReadInvites(participantId => {
            return this.invites
                .filter(i => i.fromParticipantId === participantId || i.toParticipantId === participantId)
                .map(i => ({ ...i }));
        });
        server.onReadInvite((conversationId, toParticipantId) => {
            const found = this.invites.find(i => i.conversation.conversationId === conversationId && i.toParticipantId === toParticipantId);
            return found ? { ...found } : null;
        });
        server.onReadAliases(participantIds => {
            return participantIds.flatMap(pid => {
                const alias = this.aliases.get(pid);
                return alias ? [{ participantId: pid, alias }] : [];
            });
        });
        server.onReadConversationParticipantActivity((conversationId, participantId) => {
            const found = this.activities.get(this.activityKey(conversationId, participantId));
            return found ? { ...found } : null;
        });
        server.onReadParticipantActivities(participantId => {
            return [...this.activities.values()].filter(a => a.participantId === participantId).map(a => ({ ...a }));
        });

        // Update handlers -----------------------------------------------
        
        server.onAddConversationParticipant((conversationId, participantId, maxParticipants) => {
            const set = this.conversationParticipants.get(conversationId);
            if (!set) throw new Error("Conversation not found");
            if (set.has(participantId)) throw new Error("Already a participant");
            if (set.size >= maxParticipants) throw new Error("Conversation is full");
            set.add(participantId);
        });
        server.onRemoveConversationParticipant((conversationId, participantId) => {
            this.conversationParticipants.get(conversationId)?.delete(participantId);
        });
        server.onUpdateMessage(message => {
            const existing = this.messages.get(message.messageId);
            if (!existing) throw new Error("Message not found");
            // Spec: existing reactions are preserved across edits
            this.messages.set(message.messageId, { ...message, reactions: existing.reactions });
        });
        server.onUpdateConversationParticipantActivity(activity => {
            if (!this.isParticipant(activity.conversationId, activity.participantId)) return;
            this.activities.set(this.activityKey(activity.conversationId, activity.participantId), { ...activity });
        });

        // Delete handlers ----------------------------------------------------
        
        server.onDeleteReaction(reactionId => {
            for (const message of this.messages.values()) {
                const idx = message.reactions.findIndex(r => r.reactionId === reactionId);
                if (idx >= 0) { message.reactions.splice(idx, 1); return; }
            }
        });
        server.onDeleteConversationWithMessagesReactionsInvitesAndActivities(conversationId => {
            const deletedInvites = this.deleteConversationAndReturnInvites(conversationId);
            return { deletedInvites };
        });
        server.onDeleteInvites(invites => {
            this.invites = this.invites.filter(existing => !invites.some(target => target.conversationId === existing.conversation.conversationId && target.toParticipantId === existing.toParticipantId));
        });
        server.onDeleteConversationParticipantActivities((conversationIds, participantIds) => {
            for (const key of [...this.activities.keys()]) {
                const activity = this.activities.get(key);
                if (!activity) continue;
                if (conversationIds.includes(activity.conversationId) && participantIds.includes(activity.participantId)) {
                    this.activities.delete(key);
                }
            }
        });
        server.onDeleteMessagesBefore(thresholdDate => {
            for (const [id, m] of this.messages) if (m.createdAt.getTime() < thresholdDate.getTime()) this.messages.delete(id);
        });
        server.onDeleteConversationsWithMessagesReactionsInvitesAndActivitiesBefore(thresholdDate => {
            const deletedConversations: { conversationId: string, formerParticipants: string[], deletedInvites: { fromParticipantId: string, toParticipantId: string }[] }[] = [];
            for (const [conversationId, conversation] of [...this.conversations]) {
                if (conversation.lastActivityAt.getTime() >= thresholdDate.getTime()) continue;

                const formerParticipants = [...(this.conversationParticipants.get(conversationId) ?? [])];
                const deletedInvites = this.deleteConversationAndReturnInvites(conversationId);
                deletedConversations.push({ conversationId, formerParticipants, deletedInvites });
            }
            return { deletedConversations };
        });
        server.onDeleteInvitesBefore(thresholdDate => {
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
