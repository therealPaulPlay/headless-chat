// Generic in-memory keyed cache, returns copies on read and stores copies on set so callers can mutate freely without poisoning the cache
// Each entry tracks the last write time so a periodic sweep can evict stale ones
export class Cache<T> {
    private store = new Map<string, { value: T, lastTouchedMs: number }>();

    get(key: string): T | undefined {
        const entry = this.store.get(key);
        return entry === undefined ? undefined : structuredClone(entry.value);
    }

    set(key: string, value: T): void {
        this.store.set(key, { value: structuredClone(value), lastTouchedMs: Date.now() });
    }

    invalidate(key: string): void {
        this.store.delete(key);
    }

    // Returns the first key whose stored value matches the predicate, or undefined
    findKey(predicate: (value: T) => boolean): string | undefined {
        for (const [key, entry] of this.store) {
            if (predicate(structuredClone(entry.value))) return key;
        }
        return undefined;
    }

    // Invalidates every entry whose stored value matches the predicate
    invalidateMatching(predicate: (value: T) => boolean): void {
        for (const [key, entry] of this.store) {
            if (predicate(structuredClone(entry.value))) this.store.delete(key);
        }
    }

    // Evicts entries last written before thresholdMs, returns the number of entries removed
    sweep(thresholdMs: number): number {
        let removed = 0;
        for (const [key, entry] of this.store) {
            if (entry.lastTouchedMs < thresholdMs) { this.store.delete(key); removed++; }
        }
        return removed;
    }

    size(): number {
        return this.store.size;
    }
}
