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

export const SCOPE = {
    message: (conversationId: string) => `message:${conversationId}`,
    indicators: (conversationId: string) => `indicators:${conversationId}`,
    conversation: () => "conversation",
    invite: () => "invite",
};

export function isValidScope(scope: string): boolean {
    return scope === "conversation" || scope === "invite" || scope.startsWith("message:") || scope.startsWith("indicators:");
}
