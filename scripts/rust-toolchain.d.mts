export function resolveToolchain(dependencies: unknown): { cargo: string; rustc: string; bin: string };
export function runCargo(arguments_: string[], dependencies: unknown): Promise<number>;
