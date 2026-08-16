export function validateNativeBinary(binary: string): Promise<string>;
export function validateAcceptanceBinary(binary: string): Promise<string>;
export function inspectMediaFixtures(): Promise<Record<string, { format: string; width?: number; height?: number; frames?: number; duration?: number; streams: string[] }>>;
export function inspectMediaBytes(fixtures: Record<string, Buffer>): Record<string, { format: string; width?: number; height?: number; frames?: number; duration?: number; streams: string[] }>;
export function validateTranscript(result: { status: number | null; stderr: Buffer; messages: unknown[] }, expected: unknown[], label: string, options?: { status?: number; stderr?: string }): void;
export function claimAcceptanceDestination(destination: string, options?: { owned?: boolean }): Promise<{ root: string; owned: boolean }>;
export function nativeRoundtrip(options?: { binary?: string; faultBinary?: string; destination?: string }): Promise<Record<string, unknown>>;
