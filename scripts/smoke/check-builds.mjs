import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CHROMIUM_EXTENSION_ID, CHROMIUM_PUBLIC_KEY_DER_BASE64, getChromiumExtensionId } from "../native-host/identity.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TARGETS = [
  { name: "chrome", directory: "chrome-mv3", manifestVersion: 3, chromium: true },
  { name: "edge", directory: "edge-mv3", manifestVersion: 3, chromium: true },
  { name: "firefox", directory: "firefox-mv2", manifestVersion: 2, chromium: false },
];
const REQUIRED_PERMISSIONS = ["activeTab", "storage", "nativeMessaging"];
const MATCHES = ["http://*/*", "https://*/*"];
const ICONS = {
  16: "icons/arthur-16.png",
  32: "icons/arthur-32.png",
  48: "icons/arthur-48.png",
  128: "icons/arthur-128.png",
};

function fail(message) { throw new Error(message); }

function exactArray(actual, expected, label) {
  if (!Array.isArray(actual) || actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    fail(`${label} is not the expected exact array.`);
  }
}

function exactIcons(actual, label) {
  if (actual === null || typeof actual !== "object" || Object.keys(actual).length !== Object.keys(ICONS).length) {
    fail(`${label} is not the expected exact icon map.`);
  }
  for (const [size, file] of Object.entries(ICONS)) {
    if (actual[size] !== file) fail(`${label} is not the expected exact icon map.`);
  }
}

function assertFile(root, relative, label) {
  return fs.stat(path.join(root, relative)).then((stat) => {
    if (!stat.isFile()) fail(`${label} is missing.`);
  });
}

function validateManifest(manifest, target) {
  if (manifest.manifest_version !== target.manifestVersion || manifest.name !== "arthur" || manifest.version !== "0.1.0") {
    fail(`${target.name} manifest identity is invalid.`);
  }
  exactArray(manifest.permissions, target.manifestVersion === 3 ? REQUIRED_PERMISSIONS : [...REQUIRED_PERMISSIONS, ...MATCHES], `${target.name} permissions`);
  if (target.chromium) {
    exactArray(manifest.host_permissions, MATCHES, `${target.name} host permissions`);
    if (manifest.key !== CHROMIUM_PUBLIC_KEY_DER_BASE64 || getChromiumExtensionId(manifest.key) !== CHROMIUM_EXTENSION_ID) {
      fail(`${target.name} manifest key does not produce Arthur's fixed Chromium identity.`);
    }
  } else if (Object.hasOwn(manifest, "key")) {
    fail(`${target.name} manifest must not contain Chromium's key.`);
  }
  const gecko = manifest.browser_specific_settings?.gecko;
  if (!gecko || gecko.id !== "arthur@olhapi.com") fail(`${target.name} Gecko identity is missing.`);
  exactIcons(manifest.icons, `${target.name} extension icons`);
  if (manifest.options_ui?.page !== "options.html" || manifest.options_ui?.open_in_tab !== false) fail(`${target.name} options page is invalid.`);
  if (!Array.isArray(manifest.content_scripts) || manifest.content_scripts.length !== 1) fail(`${target.name} content script is missing.`);
  const content = manifest.content_scripts[0];
  exactArray(content.matches, MATCHES, `${target.name} content-script matches`);
  exactArray(content.js, ["content-scripts/content.js"], `${target.name} content-script entries`);
  if (target.manifestVersion === 3) {
    if (manifest.background?.service_worker !== "background.js") fail(`${target.name} service worker is invalid.`);
    if (!manifest.action || Object.hasOwn(manifest.action, "default_popup")) fail(`${target.name} must not declare a default action popup.`);
    exactIcons(manifest.action.default_icon, `${target.name} toolbar icons`);
  } else {
    exactArray(manifest.background?.scripts, ["background.js"], `${target.name} background scripts`);
    if (!manifest.browser_action || Object.hasOwn(manifest.browser_action, "default_popup")) fail(`${target.name} must not declare a default browser-action popup.`);
    exactIcons(manifest.browser_action.default_icon, `${target.name} toolbar icons`);
  }
}

export async function validateBuildArtifacts({ root = path.join(ROOT, ".output") } = {}) {
  const canonicalRoot = path.resolve(root);
  const targets = [];
  for (const target of TARGETS) {
    const artifact = path.join(canonicalRoot, target.directory);
    const manifest = JSON.parse(await fs.readFile(path.join(artifact, "manifest.json"), "utf8"));
    validateManifest(manifest, target);
    await Promise.all([
      assertFile(artifact, "background.js", `${target.name} background entrypoint`),
      assertFile(artifact, "content-scripts/content.js", `${target.name} content-script entrypoint`),
      assertFile(artifact, "options.html", `${target.name} options page`),
      assertFile(artifact, "status.html", `${target.name} status page`),
      ...Object.values(ICONS).map((file) => assertFile(artifact, file, `${target.name} icon ${file}`)),
    ]);
    targets.push(target.name);
  }
  return { smoke: "build-artifacts", targets };
}

function parseArguments(argv) {
  if (argv.length === 0) return {};
  if (argv.length === 2 && argv[0] === "--build-root" && path.isAbsolute(argv[1])) return { root: argv[1] };
  throw new Error("Usage: check-builds.mjs [--build-root /absolute/path]");
}

async function main() {
  const result = await validateBuildArtifacts(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`Arthur build smoke failed: ${error.message}\n`); process.exitCode = 1; });
}
