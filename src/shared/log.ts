export function logHandlerError(context: string, error: unknown): void {
    console.error(`headless-chat handler error in ${context}:`, error);
}
