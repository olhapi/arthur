export function validateSourceArchives(options?: { root?: string }): Promise<{ sourceArchives: Array<{ name: string; bytes: number; entries: number }> }>;
