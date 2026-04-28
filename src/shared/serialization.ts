import { encode as msgpackEncode, decode } from "@msgpack/msgpack";

function sanitize<T>(data: T): T {
    // WIP
    // Escape symbols used in HTML like <, >, &, ", ' etc. if not already escaped
    return data;
}

export function encode<T>(data: T): Uint8Array {
    return msgpackEncode(data);
}

export function decodeAndSanitize<T>(data: Uint8Array): T {
    return sanitize(decode(data) as T);
}