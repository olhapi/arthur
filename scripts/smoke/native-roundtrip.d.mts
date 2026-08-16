export function validateNativeBinary(binary: string): Promise<string>;
export function validateAcceptanceBinary(binary: string): Promise<string>;
export function inspectMediaFixtures(): Promise<Record<string, { format: string; width?: number; height?: number; frames?: number; duration?: number; streams: string[] }>>;
export function claimAcceptanceDestination(destination: string, options?: { owned?: boolean }): Promise<{ root: string; owned: boolean }>;
export function nativeRoundtrip(options?: { binary?: string; faultBinary?: string; destination?: string }): Promise<Record<string, unknown>>;
