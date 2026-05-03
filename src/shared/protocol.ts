type RequestMessage = {
    type: "request",
    requestId: string,
    participantId: string,
    authData: unknown,
    method: string,
    args: unknown[],
}

type SubscribeMessage = {
    type: "subscribe",
    participantId: string,
    authData: unknown,
    scope: string,
}

type UnsubscribeMessage = {
    type: "unsubscribe",
    participantId: string,
    authData: unknown,
    scope: string,
}

type ResponseMessage = {
    type: "response",
    requestId: string,
    ok: boolean,
    data?: unknown,
    error?: string,
}

type EventMessage = {
    type: "event",
    scope: string,
    data: unknown,
}

export type ClientToServer = RequestMessage | SubscribeMessage | UnsubscribeMessage;
export type ServerToClient = ResponseMessage | EventMessage;

// Scope kinds
// Per-conversation scopes carry a conversationId, global scopes do not
export type Scope =
    | { kind: "message", conversationId: string }
    | { kind: "indicators", conversationId: string }
    | { kind: "conversation" }
    | { kind: "invite" };

// Wire encoding
// Per-conversation scopes serialize as `${kind}:${conversationId}`, global scopes as just `${kind}`
export function encodeScope(scope: Scope): string {
    switch (scope.kind) {
        case "message": return `message:${scope.conversationId}`;
        case "indicators": return `indicators:${scope.conversationId}`;
        case "conversation": return "conversation";
        case "invite": return "invite";
    }
}

export function decodeScope(scope: string): Scope | null {
    if (scope === "conversation") return { kind: "conversation" };
    if (scope === "invite") return { kind: "invite" };
    if (scope.startsWith("message:")) return { kind: "message", conversationId: scope.slice("message:".length) };
    if (scope.startsWith("indicators:")) return { kind: "indicators", conversationId: scope.slice("indicators:".length) };
    return null;
}
