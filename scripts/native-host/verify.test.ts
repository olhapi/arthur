import { EventEmitter } from "node:events";
import { chmod, lstat, mkdtemp, mkdir, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { applyInstallPlan, buildInstallPlan } from "./install.mjs";
import { parseArguments, requestHost, verifyInstall } from "./verify.mjs";

function frame(value: unknown) {
  const json = Buffer.from(JSON.stringify(value));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(json.length);
  return Buffer.concat([prefix, json]);
}

function spawning(response: unknown) {
  return vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    queueMicrotask(() => {
      child.stdout.end(frame(response));
      child.stderr.end();
      child.emit("close", 0);
    });
    return child;
  });
}

function spawningBytes(bytes: Buffer) {
  return vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    queueMicrotask(() => { child.stdout.end(bytes); child.stderr.end(); child.emit("close", 0); });
    return child;
  });
}

async function installedFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "arthur-native-host-verify-"));
  const home = path.join(root, "home");
  const binary = path.join(root, "repo/native/target/release/arthur-native-host");
  await mkdir(path.dirname(binary), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(binary, "host");
  const plan = await buildInstallPlan({ home, nativeBinaryPath: binary, platform: "darwin" });
  await applyInstallPlan(plan, { home, platform: "darwin" });
  return { home, plan };
}

describe("native-host verification", () => {
  it("accepts pnpm's delimiter before native verification arguments", () => {
    expect(parseArguments(["--", "--destination", "/tmp/arthur"])).toEqual({ destination: "/tmp/arthur" });
    expect(parseArguments(["--", "--expect-absent"])).toEqual({ expectAbsent: true });
  });

  it("directly spawns the installed binary with minimal PATH and validates hello", async () => {
    const { home, plan } = await installedFixture();
    const spawn = spawning({ type: "hello_result", requestId: "verify-hello", protocolVersion: 1, hostName: "Arthur native host", hostVersion: "0.1.0" });
    await expect(verifyInstall({ home, platform: "darwin", spawn })).resolves.toMatchObject({ installed: true });
    expect(spawn).toHaveBeenCalledWith(
      plan.payloads[0]!.destination,
      [],
      expect.objectContaining({ env: { PATH: "/usr/bin:/bin", HOME: await realpath(home) } }),
    );
  });

  it("rejects malformed host output and only accepts complete absence when requested", async () => {
    const { home } = await installedFixture();
    await expect(verifyInstall({ home, platform: "darwin", spawn: spawning({ wrong: true }) })).rejects.toThrow(/hello/i);
    await expect(verifyInstall({ home, platform: "darwin", expectAbsent: true })).rejects.toThrow(/expected.*absent/i);
  });

  it("rejects malformed, noisy, invalid UTF-8, and oversized host stdout", async () => {
    const { home } = await installedFixture();
    await expect(verifyInstall({ home, platform: "darwin", spawn: spawningBytes(Buffer.from([1, 0, 0, 0, 0xff])) })).rejects.toThrow(/UTF-8/i);
    await expect(verifyInstall({ home, platform: "darwin", spawn: spawningBytes(Buffer.concat([frame({ type: "hello_result" }), Buffer.from("noise")])) })).rejects.toThrow(/malformed|noisy|hello/i);
    const maxHeader = Buffer.alloc(4);
    maxHeader.writeUInt32LE(1024 * 1024);
    await expect(verifyInstall({ home, platform: "darwin", spawn: spawningBytes(Buffer.concat([maxHeader, Buffer.alloc(1024 * 1024 + 1)])) })).rejects.toThrow(/1 MiB/i);
  });

  it("kills a host immediately when its header declares more than 1 MiB", async () => {
    let child: any;
    const spawn = vi.fn(() => {
      child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
      queueMicrotask(() => { child.stdout.end(Buffer.from([1, 0, 16, 0])); child.stderr.end(); child.emit("close", 0); });
      return child;
    });
    await expect(requestHost(spawn, "/tmp/host", { type: "hello" })).rejects.toThrow(/1 MiB/i);
    expect(child!.kill).toHaveBeenCalledTimes(1);
  });

  it("canonicalizes a legitimate destination symlink and does not spawn for complete absence", async () => {
    const { home } = await installedFixture();
    const root = path.dirname(home);
    const realDestination = path.join(root, "destination-real");
    const destinationLink = path.join(root, "destination-link");
    await mkdir(realDestination);
    await symlink(realDestination, destinationLink);
    const canonicalDestination = await realpath(destinationLink);
    const spawn = vi.fn()
      .mockImplementationOnce(spawning({ type: "hello_result", requestId: "verify-hello", protocolVersion: 1, hostName: "Arthur native host", hostVersion: "0.1.0" }))
      .mockImplementationOnce(spawning({ type: "test_destination_result", requestId: "verify-destination", destination: canonicalDestination, writable: true }));
    await expect(verifyInstall({ home, platform: "darwin", destination: destinationLink, spawn })).resolves.toMatchObject({ destination: canonicalDestination });

    const absentRoot = await mkdtemp(path.join(tmpdir(), "arthur-native-host-absent-"));
    const absentHome = path.join(absentRoot, "home");
    await mkdir(absentHome, { recursive: true });
    const absentSpawn = vi.fn();
    await expect(verifyInstall({ home: absentHome, platform: "darwin", expectAbsent: true, spawn: absentSpawn })).resolves.toMatchObject({ absent: true });
    expect(absentSpawn).not.toHaveBeenCalled();
  });

  it("requires an exact writable destination response", async () => {
    const { home } = await installedFixture();
    const destination = path.join(home, "destination");
    await mkdir(destination, { recursive: true });
    const canonicalDestination = await realpath(destination);
    const spawn = vi.fn()
      .mockImplementationOnce(spawning({ type: "hello_result", requestId: "verify-hello", protocolVersion: 1, hostName: "Arthur native host", hostVersion: "0.1.0" }))
      .mockImplementationOnce(spawning({ type: "test_destination_result", requestId: "verify-destination", destination: canonicalDestination, writable: true }));
    await expect(verifyInstall({ home, platform: "darwin", destination, spawn })).resolves.toMatchObject({ destination: canonicalDestination });
    const mismatch = vi.fn()
      .mockImplementationOnce(spawning({ type: "hello_result", requestId: "verify-hello", protocolVersion: 1, hostName: "Arthur native host", hostVersion: "0.1.0" }))
      .mockImplementationOnce(spawning({ type: "test_destination_result", requestId: "verify-destination", destination: `${canonicalDestination}-wrong`, writable: true }));
    await expect(verifyInstall({ home, platform: "darwin", destination, spawn: mismatch })).rejects.toThrow(/exact writable destination/i);
  });

  it("rejects bad manifest JSON, IDs, paths, modes, nonregular binaries, and extra payloads", async () => {
    const badJson = await installedFixture();
    await writeFile(badJson.plan.manifests[0]!.destination, "{");
    await expect(verifyInstall({ home: badJson.home, platform: "darwin" })).rejects.toThrow(/JSON/i);

    const badId = await installedFixture();
    await writeFile(badId.plan.manifests[1]!.destination, JSON.stringify({ ...badId.plan.manifests[1]!.contents, allowed_origins: ["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"] }));
    await expect(verifyInstall({ home: badId.home, platform: "darwin" })).rejects.toThrow(/manifest/i);

    const missingStoreOrigin = await installedFixture();
    await writeFile(missingStoreOrigin.plan.manifests[0]!.destination, JSON.stringify({
      ...missingStoreOrigin.plan.manifests[0]!.contents,
      allowed_origins: ["chrome-extension://kaknffcpoififkcmhphedbajjbacfaof/"],
    }));
    await expect(verifyInstall({
      home: missingStoreOrigin.home,
      platform: "darwin",
      spawn: spawning({ type: "hello_result", requestId: "verify-hello", protocolVersion: 1, hostName: "Arthur native host", hostVersion: "0.1.0" }),
    })).rejects.toThrow(/manifest/i);

    const badPath = await installedFixture();
    await writeFile(badPath.plan.manifests[2]!.destination, JSON.stringify({ ...badPath.plan.manifests[2]!.contents, path: "/not/arthur-native-host" }));
    await expect(verifyInstall({ home: badPath.home, platform: "darwin" })).rejects.toThrow(/manifest/i);

    const badMode = await installedFixture();
    await chmod(badMode.plan.payloads[0]!.destination, 0o700);
    await expect(verifyInstall({ home: badMode.home, platform: "darwin" })).rejects.toThrow(/0755/i);

    const nonregular = await installedFixture();
    await unlink(nonregular.plan.payloads[0]!.destination);
    await mkdir(nonregular.plan.payloads[0]!.destination);
    await expect(verifyInstall({ home: nonregular.home, platform: "darwin" })).rejects.toThrow(/regular/i);

    const extra = await installedFixture();
    await writeFile(path.join(path.dirname(extra.plan.payloads[0]!.destination), "extra"), "extra");
    await expect(verifyInstall({ home: extra.home, platform: "darwin" })).rejects.toThrow(/exactly one/i);
  });

  it("uses the built release binary through the complete fake-home lifecycle", async () => {
    const releaseBinary = path.resolve("native/target/release/arthur-native-host");
    await expect(lstat(releaseBinary)).resolves.toMatchObject({ isFile: expect.any(Function) });
    const root = await mkdtemp(path.join(tmpdir(), "arthur-native-host-real-"));
    const home = path.join(root, "home");
    const destination = path.join(root, "destination");
    await mkdir(home);
    await mkdir(destination);
    const plan = await buildInstallPlan({ home, nativeBinaryPath: releaseBinary, platform: "darwin" });
    await applyInstallPlan(plan, { home, platform: "darwin" });
    await expect(verifyInstall({ home, platform: "darwin", destination })).resolves.toMatchObject({ installed: true });
    const { applyUninstallPlan, buildUninstallPlan } = await import("./uninstall.mjs");
    const uninstall = await buildUninstallPlan({ home, platform: "darwin" });
    await applyUninstallPlan(uninstall, { home, platform: "darwin" });
    await expect(verifyInstall({ home, platform: "darwin", expectAbsent: true })).resolves.toMatchObject({ absent: true });
  });
});
