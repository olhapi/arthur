export interface BuildSiteOptions {
  rootDir?: string;
  outputDir?: string;
  run?: (command: string, args: string[], options: Record<string, unknown>) => unknown;
}

export function buildSite(options?: BuildSiteOptions): Promise<void>;
