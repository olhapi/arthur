import { mkdtemp, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { CHROMIUM_EXTENSION_ID } from "./identity.mjs";
import { applyInstallPlan, buildInstallPlan } from "./install.mjs";
import { buildUninstallPlan, applyUninstallPlan } from "./uninstall.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "arthur-native-host-test-"));
  const home = path.join(root, "home");
  const repositoryPath = path.join(root, "repo");
  const nativeBinaryPath = path.join(repositoryPath, "native", "target", "release", "arthur-native-host");
  await mkdir(path.dirname(nativeBinaryPath), { recursive: true });
  await writeFile(nativeBinaryPath, "native-host");
  return { home, repositoryPath, nativeBinaryPath };
}

describe("native-host installation plan", () => {
  it("contains one direct Rust binary and three exact user-level manifests", async () => {
    const options = await fixture();
    const plan = await buildInstallPlan({ ...options, platform: "darwin" });
    const binary = path.join(options.home, "Library/Application Support/Arthur/native-host/arthur-native-host");
    expect(plan.payloads).toEqual([{ source: options.nativeBinaryPath, destination: binary, mode: 0o755 }]);
    expect(plan.manifests.map((manifest) => manifest.destination)).toEqual([
      path.join(options.home, "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.olhapi.arthur.json"),
      path.join(options.home, "Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.olhapi.arthur.json"),
      path.join(options.home, "Library/Application Support/Mozilla/NativeMessagingHosts/com.olhapi.arthur.json"),
    ]);
    expect(plan.manifests[0]?.contents.allowed_origins).toEqual([`chrome-extension://${CHROMIUM_EXTENSION_ID}/`]);
    expect(plan.manifests[1]?.contents.path).toBe(binary);
    expect(plan.manifests[2]?.contents.allowed_extensions).toEqual(["arthur@olhapi.com"]);
  });

  it("rejects non-macOS, non-regular input, symlink targets, and targets outside Arthur's allowlist", async () => {
    const options = await fixture();
    await expect(buildInstallPlan({ ...options, platform: "linux" })).rejects.toThrow(/macOS/i);
    await unlink(options.nativeBinaryPath);
    await mkdir(options.nativeBinaryPath);
    await expect(buildInstallPlan({ ...options, platform: "darwin" })).rejects.toThrow(/regular/i);
    const clean = await fixture();
    const installed = path.join(clean.home, "Library/Application Support/Arthur/native-host/arthur-native-host");
    await mkdir(path.dirname(installed), { recursive: true });
    await symlink("/tmp/not-arthur", installed);
    await expect(buildInstallPlan({ ...clean, platform: "darwin" })).rejects.toThrow(/symlink/i);
    await expect(buildInstallPlan({ ...clean, platform: "darwin", targets: { binary: "/tmp/escape" } })).rejects.toThrow(/allowlist/i);
  });

  it("atomically installs only the binary and browser manifests", async () => {
    const options = await fixture();
    const plan = await buildInstallPlan({ ...options, platform: "darwin" });
    const renames: Array<[string, string]> = [];
    await applyInstallPlan(plan, {
      fs: {
        ...await import("node:fs/promises"),
        rename: async (from: string, to: string) => {
          renames.push([from, to]);
          return (await import("node:fs/promises")).rename(from, to);
        },
      },
    });
    expect(renames).toHaveLength(4);
    for (const [from, to] of renames) expect(path.dirname(from)).toBe(path.dirname(to));
    expect(await readFile(plan.payloads[0]!.destination, "utf8")).toBe("native-host");
    for (const manifest of plan.manifests) expect(JSON.parse(await readFile(manifest.destination, "utf8"))).toEqual(manifest.contents);
  });

  it("refuses a forged plan whose final path escapes the exact allowlist", async () => {
    const options = await fixture();
    const plan = await buildInstallPlan({ ...options, platform: "darwin" });
    plan.payloads[0]!.destination = path.join(options.home, "escape");
    await expect(applyInstallPlan(plan)).rejects.toThrow(/allowlist/i);
  });

  it("uninstalls only the four exact Arthur files", async () => {
    const options = await fixture();
    const plan = await buildInstallPlan({ ...options, platform: "darwin" });
    await applyInstallPlan(plan);
    const uninstall = await buildUninstallPlan({ home: options.home, platform: "darwin" });
    await applyUninstallPlan(uninstall);
    for (const target of uninstall.targets) await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(buildUninstallPlan({ home: options.home, platform: "darwin", targets: ["/tmp/escape"] })).rejects.toThrow(/allowlist/i);
  });
});
