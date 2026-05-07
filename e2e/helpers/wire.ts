import { Server, type RateLimitOptions, type CleanupOptions, type ServerOptions } from "../../src/server/server.js";
import { Client } from "../../src/client/client.js";
import { InMemoryStore } from "./store.js";
import type { Cache } from "../../src/server/cache.js";
import type { Conversation } from "../../src/shared/shared-types.js";

// Direct in-process wire, client.dispatch -> server.receive, server.dispatch -> client.receive
export class FakeTransport {
    server: Server;
    store: InMemoryStore;
    private clients = new Map<string, Client>();

    constructor(rateLimits?: RateLimitOptions, cleanup?: CleanupOptions, options?: ServerOptions) {
        this.store = new InMemoryStore();
        // Default the inter-cleanup gap to 0 so runDaily tests don't sleep 30s between blocks, callers can override via cleanup option
        const cleanupWithDefaults: CleanupOptions = { timeoutBetweenDailyCleanupsSeconds: 0, ...cleanup };
        // Default logInfo to false so tests don't spam stdout
        const optionsWithDefaults: ServerOptions = { logInfo: false, ...options };
        this.server = new Server((participantId, data) => {
            const client = this.clients.get(participantId);
            if (client) client.receive(data);
        }, rateLimits, cleanupWithDefaults, optionsWithDefaults);
        this.store.register(this.server);
    }

    // Test-only access into the lib's caches for assertions
    get conversationCache(): Cache<Conversation> { return (this.server as unknown as { ctx: { conversationCache: Cache<Conversation> } }).ctx.conversationCache; }
    get activityCache(): Cache<number> { return (this.server as unknown as { ctx: { activityCache: Cache<number> } }).ctx.activityCache; }

    addClient(participantId: string): Client {
        this.store.users.add(participantId);
        const client = new Client(
            data => { void this.server.receive(data); },
            participantId,
            () => `token-${participantId}`,
        );
        this.clients.set(participantId, client);
        return client;
    }

    stop(): void {
        this.server.stop();
    }
}

// Yield to the microtask queue so async fanouts settle before assertions
export function tick(times = 3): Promise<void> {
    let p = Promise.resolve();
    for (let i = 0; i < times; i++) p = p.then(() => undefined);
    return p;
}
