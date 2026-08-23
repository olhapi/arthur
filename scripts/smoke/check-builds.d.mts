export function validateBuildArtifacts(options?: { root?: string }): Promise<{ smoke: string; targets: string[] }>;
export function validateChromeStoreBuild(options?: { root?: string }): Promise<{ smoke: string; targets: string[] }>;
