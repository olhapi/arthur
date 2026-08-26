export function validateSourceArchives(options?: { root?: string; archive?: string }): Promise<{ sourceArchives: Array<{ name: string; bytes: number; entries: number }> }>;
