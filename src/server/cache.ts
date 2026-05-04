// Generic in-memory keyed cache, returns copies on read and stores copies on set so callers can mutate freely without poisoning the cache
export class Cache<T> {
    private store = new Map<string, T>();

    get(key: string): T | undefined {
        const cached = this.store.get(key);
        return cached === undefined ? undefined : structuredClone(cached);
    }

    set(key: string, value: T): void {
        this.store.set(key, structuredClone(value));
    }

    invalidate(key: string): void {
        this.store.delete(key);
    }

    // Returns the first key whose stored value matches the predicate, or undefined
    findKey(predicate: (value: T) => boolean): string | undefined {
        for (const [key, value] of this.store) {
            if (predicate(structuredClone(value))) return key;
        }
        return undefined;
    }

    // Invalidates every entry whose stored value matches the predicate
    invalidateMatching(predicate: (value: T) => boolean): void {
        for (const [key, value] of this.store) {
            if (predicate(structuredClone(value))) this.store.delete(key);
        }
    }
}
