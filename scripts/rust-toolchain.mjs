import { execFileSync, spawn } from "node:child_process";
import { dirname, delimiter } from "node:path";
import process from "node:process";

const TOOLCHAIN = "1.97.1";
const text = (value) => String(value).trim();

function defaultDependencies() {
  return {
    execFileSync,
    spawn,
    env: process.env,
    dirname,
    delimiter,
    on: process.on.bind(process),
    off: process.off.bind(process),
    exit: (signal) => process.kill(process.pid, signal),
  };
}

function command(deps, executable, arguments_) {
  const value = text(deps.execFileSync(executable, arguments_, { encoding: "utf8" }));
  if (!value) throw new Error(`Unable to resolve ${arguments_[1] ?? "toolchain binary"}`);
  return value;
}

function assertVersion(deps, binary, name) {
  const version = command(deps, binary, ["--version"]);
  if (version.split(/\s+/, 2).join(" ") !== `${name} ${TOOLCHAIN}`) {
    throw new Error(`Expected ${name} ${TOOLCHAIN}, received ${version}`);
  }
}

export function resolveToolchain(deps = defaultDependencies()) {
  const prefix = command(deps, "brew", ["--prefix", "rustup"]);
  const rustup = `${prefix}/bin/rustup`;
  const cargo = command(deps, rustup, ["which", "cargo", "--toolchain", TOOLCHAIN]);
  const rustc = command(deps, rustup, ["which", "rustc", "--toolchain", TOOLCHAIN]);
  assertVersion(deps, cargo, "cargo");
  assertVersion(deps, rustc, "rustc");
  return { cargo, rustc, bin: deps.dirname(cargo) };
}

export function runCargo(args, deps = defaultDependencies()) {
  if (!Array.isArray(args) || args.length === 0) throw new Error("Cargo arguments are required");
  const toolchain = resolveToolchain(deps);
  const env = { ...deps.env, RUSTC: toolchain.rustc, PATH: `${toolchain.bin}${deps.delimiter}${deps.env.PATH ?? ""}` };
  const child = deps.spawn(toolchain.cargo, args, { env, stdio: "inherit" });
  return new Promise((resolve, reject) => {
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
    const handlers = new Map(signals.map((signal) => [signal, () => child.kill(signal)]));
    for (const [signal, handler] of handlers) deps.on(signal, handler);
    const cleanup = () => { for (const [signal, handler] of handlers) deps.off(signal, handler); };
    child.once("error", (error) => { cleanup(); reject(error); });
    child.once("close", (code, signal) => {
      cleanup();
      if (signal) { deps.exit(signal); resolve(0); return; }
      resolve(code ?? 1);
    });
  });
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  runCargo(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
