import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { CHROMIUM_PUBLIC_KEY_DER_BASE64 } from "../native-host/identity.mjs";
import { validateBuildArtifacts } from "./check-builds.mjs";

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
      name: "arthur",
      version: "0.1.0",
      permissions: target.manifestVersion === 3
        ? ["activeTab", "storage", "nativeMessaging"]
        : ["activeTab", "storage", "nativeMessaging", "http://*/*", "https://*/*"],
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

describe("check-builds", () => {
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
});
