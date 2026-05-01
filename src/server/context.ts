import type { Handlers, ResolvedRateLimits } from "./server-types.js";
import type { Subscriptions } from "./subscriptions.js";
import type { RateLimiter } from "./rate-limits.js";
import { logError } from "../shared/log.js";

// Used for services as a "this.*" replacement so that they don't all need to be on the server class
export type ServerContext = {
    handlers: Handlers,
    subscriptions: Subscriptions,
    rateLimiter: RateLimiter,
    rateLimits: ResolvedRateLimits,
    activityCache: Map<string, number>, // ${conversationId}|${participantId} -> lastReadMessageCreatedAt as ms
}

export type AfterHook = () => void | Promise<void>;

// Every service returns this shape, hooks run once the RPC response has been sent
export type ServiceResult<T> = { result: T, hooks: AfterHook[] }

// Fires an optional handler synchronously and logs any throw or rejected promise without propagating
export function fireHook<K extends keyof Handlers>(handlers: Handlers, name: K, ...args: Parameters<NonNullable<Handlers[K]>>): void {
    const handler = handlers[name] as ((...a: typeof args) => unknown) | undefined;
    if (!handler) return;
    try {
        const result = handler(...args);
        if (result instanceof Promise) result.catch(error => logError(name, error));
    } catch (error) {
        logError(name, error);
    }
}

export function newId(): string {
    return crypto.randomUUID();
}

export function now(): Date {
    return new Date();
}
