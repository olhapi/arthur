export function validateNativeBinary(binary: string): Promise<string>;
export function nativeRoundtrip(options?: { binary?: string; destination?: string }): Promise<Record<string, unknown>>;
