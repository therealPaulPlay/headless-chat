export function logError(context: string, error: unknown): void {
    console.error(`headless-chat error in ${context}:`, error);
}

// Module-level toggle for info-level logs
let infoEnabled = true;

export function setInfoLogging(enabled: boolean): void { infoEnabled = enabled; }

export function logInfo(context: string, fields: Record<string, unknown>): void {
    if (!infoEnabled) return;
    const parts = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(" ");
    console.log(`headless-chat ${context}: ${parts}`);
}
