import type { Handlers } from "./server-types.js";
import { logError } from "../shared/log.js";

export function isValidEmoji(value: string): boolean {
    if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
    // Reject anything that isn't exactly one user-perceived character (grapheme)
    // ZWJ sequences, flags, and skin-tone variants are multi-codepoint but render as one grapheme so they pass
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const iter = segmenter.segment(value)[Symbol.iterator]();
    const first = iter.next();
    if (first.done || !iter.next().done) return false; // Reject if no grapheme or 2+ graphenes
    return /\p{Extended_Pictographic}/u.test(first.value.segment);
}

export async function applyProfanityChecks(handlers: Handlers, text: string): Promise<string> {
    // Spec says these must not throw, but to be defensive, any thrown error fails closed
    if (handlers.profanityCheckBlock) {
        let allowed: boolean;
        try { allowed = await handlers.profanityCheckBlock(text); }
        catch (error) { logError("profanityCheckBlock", error); throw new Error("Profanity check failed"); }
        if (!allowed) throw new Error("Message rejected by profanity filter");
    }
    if (handlers.profanityCheckCensor) {
        try { return await handlers.profanityCheckCensor(text); }
        catch (error) { logError("profanityCheckCensor", error); throw new Error("Profanity check failed"); }
    }
    return text;
}

export function effectiveMaxParticipants(maxSize: number | null | undefined, hardUpperLimit: number): number {
    if (maxSize === undefined || maxSize === null) return hardUpperLimit;
    return Math.min(maxSize, hardUpperLimit);
}
