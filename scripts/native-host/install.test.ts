import * as nodeFs from "node:fs/promises";
import { mkdtemp, mkdir, readFile, readdir, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { CHROMIUM_EXTENSION_ID } from "./identity.mjs";
import { applyInstallPlan, buildInstallPlan } from "./install.mjs";
import { buildUninstallPlan, applyUninstallPlan } from "./uninstall.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "arthur-native-host-test-"));
  const home = path.join(root, "home");
  const repositoryPath = path.join(root, "repo");
  const nativeBinaryPath = path.join(repositoryPath, "native", "target", "release", "arthur-native-host");
  await mkdir(home, { recursive: true });
  await mkdir(path.dirname(nativeBinaryPath), { recursive: true });
  await writeFile(nativeBinaryPath, "native-host");
  return { home, repositoryPath, nativeBinaryPath };
}

describe("native-host installation plan", () => {
  it("contains one direct Rust binary and three exact user-level manifests", async () => {
    const options = await fixture();
    const plan = await buildInstallPlan({ ...options, platform: "darwin" });
    const binary = path.join(plan.home, "Library/Application Support/Arthur/native-host/arthur-native-host");
    expect(plan.payloads).toEqual([{ source: options.nativeBinaryPath, destination: binary, mode: 0o755 }]);
    expect(plan.manifests.map((manifest) => manifest.destination)).toEqual([
      path.join(plan.home, "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.olhapi.arthur.json"),
      path.join(plan.home, "Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.olhapi.arthur.json"),
      path.join(plan.home, "Library/Application Support/Mozilla/NativeMessagingHosts/com.olhapi.arthur.json"),
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
    await expect(buildInstallPlan({ ...clean, nativeBinaryPath: path.join(clean.repositoryPath, "missing"), platform: "darwin" })).rejects.toThrow(/missing/i);
    const sourceLink = path.join(clean.repositoryPath, "source-link");
    await symlink(clean.nativeBinaryPath, sourceLink);
    await expect(buildInstallPlan({ ...clean, nativeBinaryPath: sourceLink, platform: "darwin" })).rejects.toThrow(/symlink/i);
  });

  it("atomically installs only the binary and browser manifests", async () => {
    const options = await fixture();
    const plan = await buildInstallPlan({ ...options, platform: "darwin" });
    const renames: Array<[string, string]> = [];
    await applyInstallPlan(plan, {
      home: options.home,
      platform: "darwin",
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
    await expect(applyInstallPlan(plan, { home: options.home, platform: "darwin" })).rejects.toThrow(/allowlist/i);
  });

  it("recomputes its allowlist rather than trusting a fully forged plan", async () => {
    const options = await fixture();
    const plan = await buildInstallPlan({ ...options, platform: "darwin" });
    const forged = path.join(options.home, "forged", "arthur-native-host");
    plan.targets = { binary: forged, chrome: `${forged}.chrome`, edge: `${forged}.edge`, firefox: `${forged}.firefox` };
    plan.payloads[0]!.destination = forged;
    for (const [index, manifest] of plan.manifests.entries()) {
      manifest.destination = [plan.targets.chrome, plan.targets.edge, plan.targets.firefox][index]!;
      manifest.contents.path = forged;
    }
    await expect(applyInstallPlan(plan, { home: options.home, platform: "darwin" })).rejects.toThrow(/allowlist|home/i);
  });

  it("uninstalls only the four exact Arthur files", async () => {
    const options = await fixture();
    const plan = await buildInstallPlan({ ...options, platform: "darwin" });
    await applyInstallPlan(plan, { home: options.home, platform: "darwin" });
    const uninstall = await buildUninstallPlan({ home: options.home, platform: "darwin" });
    await applyUninstallPlan(uninstall, { home: options.home, platform: "darwin" });
    for (const target of uninstall.targets) await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(buildUninstallPlan({ home: options.home, platform: "darwin", targets: ["/tmp/escape"] })).rejects.toThrow(/allowlist/i);
  });

  it("treats missing target parents as absent during bounded uninstall", async () => {
    const options = await fixture();
    const uninstall = await buildUninstallPlan({ home: options.home, platform: "darwin" });
    await expect(applyUninstallPlan(uninstall, { home: options.home, platform: "darwin" })).resolves.toBeUndefined();
  });

  it("rejects forged uninstall plans and manifest/ancestor symlinks", async () => {
    const options = await fixture();
    const plan = await buildInstallPlan({ ...options, platform: "darwin" });
    await applyInstallPlan(plan, { home: options.home, platform: "darwin" });
    const uninstall = await buildUninstallPlan({ home: options.home, platform: "darwin" });
    uninstall.nativeHostDirectory = path.join(options.home, "escape");
    await expect(applyUninstallPlan(uninstall, { home: options.home, platform: "darwin" })).rejects.toThrow(/allowlist/i);

    const leaf = await fixture();
    const chromeManifest = path.join(leaf.home, "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.olhapi.arthur.json");
    await mkdir(path.dirname(chromeManifest), { recursive: true });
    await symlink("/tmp/not-arthur", chromeManifest);
    await expect(buildInstallPlan({ ...leaf, platform: "darwin" })).rejects.toThrow(/symlink/i);

    const ancestor = await fixture();
    await symlink("/tmp", path.join(ancestor.home, "Library"));
    const ancestorPlan = await buildInstallPlan({ ...ancestor, platform: "darwin" });
    await expect(applyInstallPlan(ancestorPlan, { home: ancestor.home, platform: "darwin" })).rejects.toThrow(/directory/i);

    const nonDirectory = await fixture();
    const nonDirectoryPlan = await buildInstallPlan({ ...nonDirectory, platform: "darwin" });
    await writeFile(path.join(nonDirectory.home, "Library"), "not-a-directory");
    await expect(applyInstallPlan(nonDirectoryPlan, { home: nonDirectory.home, platform: "darwin" })).rejects.toThrow(/directory/i);
    const bounded = await buildUninstallPlan({ home: nonDirectory.home, platform: "darwin" });
    await expect(applyUninstallPlan(bounded, { home: nonDirectory.home, platform: "darwin" })).rejects.toThrow(/directory/i);
  });

  it("rejects a symlink ancestor during uninstall before any unlink or rmdir", async () => {
    const options = await fixture();
    const uninstall = await buildUninstallPlan({ home: options.home, platform: "darwin" });
    await symlink("/tmp", path.join(options.home, "Library"));
    const unlink = vi.fn(nodeFs.unlink);
    const rmdir = vi.fn(nodeFs.rmdir);
    await expect(applyUninstallPlan(uninstall, { home: options.home, platform: "darwin", fs: { ...nodeFs, unlink, rmdir } })).rejects.toThrow(/directory/i);
    expect(unlink).not.toHaveBeenCalled();
    expect(rmdir).not.toHaveBeenCalled();
  });

  it("does not rename when exclusive staging write, fsync, or close fails", async () => {
    for (const failure of ["open", "writeFile", "sync", "close"] as const) {
      const options = await fixture();
      const plan = await buildInstallPlan({ ...options, platform: "darwin" });
      let openCount = 0;
      const openCalls: unknown[][] = [];
      const rename = vi.fn(nodeFs.rename);
      const fs = {
        ...nodeFs,
        rename,
        open: async (...args: Parameters<typeof nodeFs.open>) => {
          openCalls.push(args);
          openCount += 1;
          if (failure === "open" && openCount === 2) throw new Error("exclusive staging open failed");
          const handle = await nodeFs.open(...args);
          if (openCount !== 2 || failure === "open") return handle;
          return new Proxy(handle, { get(target, property) {
            if (property === failure) return async () => { throw new Error(`${failure} failed`); };
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          } });
        },
      };
      await expect(applyInstallPlan(plan, { home: options.home, platform: "darwin", fs })).rejects.toThrow(failure === "open" ? /open failed/i : new RegExp(`${failure} failed`, "i"));
      expect(rename).not.toHaveBeenCalled();
      await expect(readFile(plan.payloads[0]!.destination)).rejects.toMatchObject({ code: "ENOENT" });
      expect(openCalls.some((arguments_) => arguments_[1] === "wx")).toBe(true);
      expect((await readdir(path.dirname(plan.payloads[0]!.destination))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    }
  });
});
