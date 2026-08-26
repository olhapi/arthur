import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { CHROMIUM_PUBLIC_KEY_DER_BASE64 } from "../native-host/identity.mjs";
import { validateBuildArtifacts, validateChromeStoreBuild, validateStoreZipArtifacts } from "./check-builds.mjs";

const ICONS = {
  16: "icons/arthur-16.png",
  32: "icons/arthur-32.png",
  48: "icons/arthur-48.png",
  128: "icons/arthur-128.png",
};
const STATUS_ICONS = ["ready", "saving", "saved", "attention"].flatMap((status) =>
  Object.keys(ICONS).map((size) => `icons/arthur-${status}-${size}.png`),
);

async function buildFixture(
  mutator?: (target: string, manifest: Record<string, any>) => void,
  { includeStatusIcons = true } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "arthur-build-smoke-"));
  for (const target of [
    { name: "chrome", directory: "chrome-mv3", manifestVersion: 3 },
    { name: "edge", directory: "edge-mv3", manifestVersion: 3 },
    { name: "firefox", directory: "firefox-mv2", manifestVersion: 2 },
  ]) {
    const artifact = path.join(root, target.directory);
    await mkdir(path.join(artifact, "content-scripts"), { recursive: true });
    const manifest: Record<string, any> = {
      manifest_version: target.manifestVersion,
      name: "Arthur — Article Saver",
      version: "0.1.1",
      description: "Save the rendered article you are reading as clean, local Markdown.",
      homepage_url: "https://olhapi.github.io/arthur/",
      permissions: target.manifestVersion === 3
        ? ["activeTab", "storage", "nativeMessaging", "downloads"]
        : ["activeTab", "storage", "nativeMessaging", "downloads", "http://*/*", "https://*/*"],
      browser_specific_settings: { gecko: { id: "arthur@olhapi.com" } },
      options_ui: { page: "options.html", open_in_tab: false },
      content_scripts: [{ matches: ["http://*/*", "https://*/*"], js: ["content-scripts/content.js"] }],
      ...(target.manifestVersion === 3
        ? { key: CHROMIUM_PUBLIC_KEY_DER_BASE64, host_permissions: ["http://*/*", "https://*/*"], background: { service_worker: "background.js" }, action: { default_icon: ICONS }, icons: ICONS }
        : { background: { scripts: ["background.js"] }, browser_action: { default_icon: ICONS }, icons: ICONS }),
    };
    mutator?.(target.name, manifest);
    await writeFile(path.join(artifact, "manifest.json"), JSON.stringify(manifest));
    for (const relative of [
      "background.js", "content-scripts/content.js", "options.html", "status.html", ...Object.values(ICONS),
      ...(includeStatusIcons ? STATUS_ICONS : []),
    ]) {
      await mkdir(path.dirname(path.join(artifact, relative)), { recursive: true });
      await writeFile(path.join(artifact, relative), "fixture");
    }
  }
  return root;
}

async function buildChromeStoreFixture({ includeKey = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "arthur-store-build-smoke-"));
  const artifact = path.join(root, "chrome-mv3-store");
  await mkdir(path.join(artifact, "content-scripts"), { recursive: true });
  await writeFile(path.join(artifact, "manifest.json"), JSON.stringify({
    manifest_version: 3,
    name: "Arthur — Article Saver",
    version: "0.1.1",
    description: "Save the rendered article you are reading as clean, local Markdown.",
    homepage_url: "https://olhapi.github.io/arthur/",
    permissions: ["activeTab", "storage", "nativeMessaging", "downloads"],
    host_permissions: ["http://*/*", "https://*/*"],
    browser_specific_settings: { gecko: { id: "arthur@olhapi.com" } },
    options_ui: { page: "options.html", open_in_tab: false },
    content_scripts: [{ matches: ["http://*/*", "https://*/*"], js: ["content-scripts/content.js"] }],
    background: { service_worker: "background.js" },
    action: { default_icon: ICONS },
    icons: ICONS,
    ...(includeKey ? { key: CHROMIUM_PUBLIC_KEY_DER_BASE64 } : {}),
  }));
  for (const relative of ["background.js", "content-scripts/content.js", "options.html", "status.html", ...Object.values(ICONS), ...STATUS_ICONS]) {
    await mkdir(path.dirname(path.join(artifact, relative)), { recursive: true });
    await writeFile(path.join(artifact, relative), "fixture");
  }
  return root;
}

async function buildStoreZipFixture(mutator?: (target: string, manifest: Record<string, any>) => void) {
  const chromeRoot = await buildChromeStoreFixture();
  const browserRoot = await buildFixture(mutator);
  const root = await mkdtemp(path.join(tmpdir(), "arthur-store-zips-"));
  const packagePath = path.join(root, "package.json");
  await writeFile(packagePath, JSON.stringify({ version: "0.1.1" }));
  const archives: Array<readonly [string, string]> = [
    [path.join(chromeRoot, "chrome-mv3-store"), "arthur-0.1.1-chrome-store.zip"],
    [path.join(browserRoot, "firefox-mv2"), "arthur-0.1.1-firefox.zip"],
  ];
  for (const [directory, name] of archives) {
    const zip = spawnSync("/usr/bin/zip", ["-qr", path.join(root, name), "."], { cwd: directory });
    expect(zip.status).toBe(0);
  }
  return { root, packagePath };
}

describe("check-builds", () => {
  it("derives the expected manifest version from the release package", async () => {
    const root = await buildFixture((_target, manifest) => { manifest.version = "0.2.0"; });
    const packagePath = path.join(await mkdtemp(path.join(tmpdir(), "arthur-release-package-")), "package.json");
    await writeFile(packagePath, JSON.stringify({ version: "0.2.0" }));

    await expect(validateBuildArtifacts({ root, packagePath })).resolves.toMatchObject({
      targets: ["chrome", "edge", "firefox"],
    });
  });

  it("requires Arthur's public marketplace identity instead of package defaults", async () => {
    const publicMetadata = await buildFixture((_target, manifest) => {
      manifest.name = "Arthur — Article Saver";
      manifest.version = "0.1.1";
      manifest.description = "Save the rendered article you are reading as clean, local Markdown.";
      manifest.homepage_url = "https://olhapi.github.io/arthur/";
    });
    await expect(validateBuildArtifacts({ root: publicMetadata })).resolves.toMatchObject({ targets: ["chrome", "edge", "firefox"] });

    const packageDefaults = await buildFixture((_target, manifest) => {
      manifest.name = "arthur";
      manifest.version = "0.1.0";
      delete manifest.description;
      delete manifest.homepage_url;
    });
    await expect(validateBuildArtifacts({ root: packageDefaults })).rejects.toThrow(/identity|description|homepage/i);
  });

  it("rejects a Chromium manifest without Arthur's committed key", async () => {
    const root = await buildFixture((target, manifest) => { if (target === "chrome") delete manifest.key; });
    await expect(validateBuildArtifacts({ root })).rejects.toThrow(/key|identity/i);
  });

  it("rejects a built manifest that declares a default action popup", async () => {
    const root = await buildFixture((target, manifest) => { if (target === "edge") manifest.action.default_popup = "popup.html"; });
    await expect(validateBuildArtifacts({ root })).rejects.toThrow(/popup/i);
  });

  it("rejects a Firefox manifest that leaks Chromium's key", async () => {
    const root = await buildFixture((target, manifest) => {
      if (target === "firefox") manifest.key = CHROMIUM_PUBLIC_KEY_DER_BASE64;
    });
    await expect(validateBuildArtifacts({ root })).rejects.toThrow(/Firefox.*key|key.*Firefox/i);
  });

  it("rejects a manifest without the Arthur toolbar icon mapping", async () => {
    const root = await buildFixture((target, manifest) => {
      if (target === "firefox") delete manifest.browser_action.default_icon;
    });
    await expect(validateBuildArtifacts({ root })).rejects.toThrow(/icon/i);
  });

  it("rejects a build that omits a dynamic toolbar-status icon", async () => {
    const root = await buildFixture(undefined, { includeStatusIcons: false });
    await expect(validateBuildArtifacts({ root })).rejects.toThrow(/missing|ENOENT/i);
  });

  it("rejects a Chrome Web Store build that contains a fixed development key", async () => {
    const root = await buildChromeStoreFixture({ includeKey: true });
    await expect(validateChromeStoreBuild({ root })).rejects.toThrow(/key/i);
  });

  it("validates the exact Chrome and Firefox upload archives", async () => {
    const fixture = await buildStoreZipFixture();
    await expect(validateStoreZipArtifacts(fixture)).resolves.toMatchObject({
      storeArchives: [
        { name: "arthur-0.1.1-chrome-store.zip", target: "chrome" },
        { name: "arthur-0.1.1-firefox.zip", target: "firefox" },
      ],
    });
  });

  it("rejects a Firefox upload archive built for a different version", async () => {
    const fixture = await buildStoreZipFixture((target, manifest) => {
      if (target === "firefox") manifest.version = "0.1.0";
    });
    await expect(validateStoreZipArtifacts(fixture)).rejects.toThrow(/Firefox.*identity|identity.*Firefox/i);
  });
});
