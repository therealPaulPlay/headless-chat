const HTML_ESCAPES: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
};

const ESCAPE_RE = /(&(?!(?:amp|lt|gt|quot|#39);))|[<>"']/g;

function escapeString(value: string): string {
    return value.replace(ESCAPE_RE, (match) => HTML_ESCAPES[match] ?? match);
}

// Recursively HTML-escape every string in the payload, mutating in place
export function sanitize<T>(data: T): T {
    if (typeof data === "string") return escapeString(data) as T;
    if (data === null || typeof data !== "object") return data;
    if (data instanceof Date || data instanceof Uint8Array) return data;
    if (Array.isArray(data)) {
        for (let i = 0; i < data.length; i++) data[i] = sanitize(data[i]);
        return data;
    }
    const obj = data as Record<string, unknown>;
    for (const key of Object.keys(obj)) obj[key] = sanitize(obj[key]);
    return data;
}
