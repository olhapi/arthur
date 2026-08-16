export interface UninstallPlan { targets: string[]; nativeHostDirectory: string; }
export function buildUninstallPlan(options: Record<string, unknown>): Promise<UninstallPlan>;
export function applyUninstallPlan(plan: UninstallPlan, dependencies?: { fs?: unknown }): Promise<void>;
