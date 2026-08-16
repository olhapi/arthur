import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { applyInstallPlan, buildInstallPlan } from "./install.mjs";
import { verifyInstall } from "./verify.mjs";

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
  it("directly spawns the installed binary with minimal PATH and validates hello", async () => {
    const { home, plan } = await installedFixture();
    const spawn = spawning({ type: "hello_result", requestId: "verify-hello", protocolVersion: 1, hostName: "Arthur native host", hostVersion: "0.1.0" });
    await expect(verifyInstall({ home, platform: "darwin", spawn })).resolves.toMatchObject({ installed: true });
    expect(spawn).toHaveBeenCalledWith(plan.payloads[0]!.destination, [], expect.objectContaining({ env: { PATH: "/usr/bin:/bin" } }));
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
    await expect(verifyInstall({ home, platform: "darwin", spawn: spawningBytes(Buffer.alloc(1024 * 1024 + 1)) })).rejects.toThrow(/1 MiB/i);
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
  });
});
