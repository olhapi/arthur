export interface NativeManifest { destination: string; contents: Record<string, unknown>; }
export interface InstallPlan { home: string; platform: string; targets: Record<string, string>; payloads: Array<{ source: string; destination: string; mode: number }>; manifests: NativeManifest[]; }
export const NATIVE_HOST_NAME: string;
export const FIREFOX_EXTENSION_ID: string;
export function nativeHostTargets(options: { home: string; platform: string; targets?: Record<string, string> }): Record<string, string>;
export function assertRegularNonSymlink(fs: unknown, pathname: string, label: string): Promise<boolean>;
export function buildInstallPlan(options: Record<string, unknown>): Promise<InstallPlan>;
export function applyInstallPlan(plan: InstallPlan, dependencies: { fs?: unknown; home: string; platform: string }): Promise<void>;
