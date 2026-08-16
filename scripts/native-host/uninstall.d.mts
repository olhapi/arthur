export interface UninstallPlan { home: string; platform: string; targets: string[]; nativeHostDirectory: string; }
export function buildUninstallPlan(options: Record<string, unknown>): Promise<UninstallPlan>;
export function applyUninstallPlan(plan: UninstallPlan, dependencies: { fs?: unknown; home: string; platform: string }): Promise<void>;
