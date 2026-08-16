import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { resolveToolchain, runCargo } from "./rust-toolchain.mjs";

const originalEnvironment = { PATH: "/parent/bin", KEEP: "yes" };

function dependencies(outputs = ["/brew/rustup\n", "/toolchains/1.97.1/bin/cargo\n", "/toolchains/1.97.1/bin/rustc\n", "cargo 1.97.1\n", "rustc 1.97.1\n"]) {
  const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
  const execFileSync = vi.fn(() => outputs.shift() ?? "");
  const spawn = vi.fn(() => child);
  const parentEnvironment = { ...originalEnvironment };
  const signalHandlers = new Map<string, () => void>();
  return { child, deps: {
    execFileSync, spawn, env: parentEnvironment, delimiter: ":", dirname: (value: string) => value.slice(0, value.lastIndexOf("/")),
    on: (signal: string, handler: () => void) => signalHandlers.set(signal, handler),
    off: vi.fn((signal: string, handler: () => void) => { if (signalHandlers.get(signal) === handler) signalHandlers.delete(signal); }),
    exit: vi.fn(),
  }, parentEnvironment, signalHandlers };
}

describe("Rust toolchain adapter", () => {
  it("resolves exact rustup Cargo and rustc binaries", () => {
    const { deps } = dependencies();
    expect(resolveToolchain(deps)).toEqual({ cargo: "/toolchains/1.97.1/bin/cargo", rustc: "/toolchains/1.97.1/bin/rustc", bin: "/toolchains/1.97.1/bin" });
    expect(deps.execFileSync).toHaveBeenNthCalledWith(1, "brew", ["--prefix", "rustup"], { encoding: "utf8" });
    expect(deps.execFileSync).toHaveBeenNthCalledWith(2, "/brew/rustup/bin/rustup", ["which", "cargo", "--toolchain", "1.97.1"], { encoding: "utf8" });
  });

  it("rejects adjacent version prefixes and missing resolution", () => {
    expect(() => resolveToolchain(dependencies(["/brew\n", "/cargo\n", "/rustc\n", "cargo 1.97.10\n", "rustc 1.97.1\n"]).deps)).toThrow(/cargo 1.97.1/i);
    expect(() => resolveToolchain(dependencies(["/brew\n", "\n"]).deps)).toThrow(/resolve/i);
  });

  it("spawns with an isolated exact compiler environment", async () => {
    const { child, deps, parentEnvironment } = dependencies();
    const result = runCargo(["test", "--locked"], deps);
    expect(deps.spawn).toHaveBeenCalledWith("/toolchains/1.97.1/bin/cargo", ["test", "--locked"], expect.objectContaining({ stdio: "inherit", env: expect.objectContaining({ RUSTC: "/toolchains/1.97.1/bin/rustc", PATH: "/toolchains/1.97.1/bin:/parent/bin" }) }));
    expect(parentEnvironment).toEqual(originalEnvironment);
    child.emit("close", 0, null);
    await expect(result).resolves.toBe(0);
  });

  it("rejects empty Cargo arguments and forwards then removes signal handlers", async () => {
    const { child, deps, signalHandlers } = dependencies();
    expect(() => runCargo([], deps)).toThrow(/cargo argument/i);
    const result = runCargo(["test"], deps);
    signalHandlers.get("SIGINT")?.();
    expect(child.kill).toHaveBeenCalledWith("SIGINT");
    child.emit("close", 23, null);
    await expect(result).resolves.toBe(23);
    expect(signalHandlers.size).toBe(0);
    expect(deps.off).toHaveBeenCalledWith("SIGINT", expect.any(Function));
  });
});
