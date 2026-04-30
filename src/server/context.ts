import type { Handlers, ResolvedRateLimits } from "./server-types.js";
import type { Subscriptions } from "./subscriptions.js";
import type { RateLimiter } from "./rate-limits.js";

// Used for services as a "this.*" replacement so that they don't all need to be on the server class
export type ServerContext = {
    handlers: Handlers,
    subscriptions: Subscriptions,
    rateLimiter: RateLimiter,
    rateLimits: ResolvedRateLimits,
    activityCache: Map<string, number>, // ${conversationId}|${participantId} -> lastReadMessageCreatedAt as ms
}

export function newId(): string {
    return crypto.randomUUID();
}

export function now(): Date {
    return new Date();
}
