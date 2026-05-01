export function logError(context: string, error: unknown): void {
    console.error(`headless-chat error in ${context}:`, error);
}
