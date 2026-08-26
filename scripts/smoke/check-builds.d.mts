export function validateBuildArtifacts(options?: { root?: string; packagePath?: string }): Promise<{ smoke: string; targets: string[] }>;
export function validateChromeStoreBuild(options?: { root?: string; packagePath?: string }): Promise<{ smoke: string; targets: string[] }>;
export function validateStoreZipArtifacts(options?: { root?: string; packagePath?: string }): Promise<{
  smoke: string;
  storeArchives: Array<{ name: string; target: string; entries: number }>;
}>;
