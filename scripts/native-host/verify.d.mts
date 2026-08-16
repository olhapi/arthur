export function requestHost(spawn: unknown, binary: string, request: unknown): Promise<unknown>;
export function verifyInstall(options: Record<string, unknown>): Promise<{ installed: boolean; absent?: boolean; destination?: string }>;
export function parseArguments(argv: string[]): { destination?: string; expectAbsent?: boolean };
