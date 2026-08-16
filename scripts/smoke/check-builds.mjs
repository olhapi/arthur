import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TARGETS = [
  ["chrome", "chrome-mv3", 3],
  ["edge", "edge-mv3", 3],
  ["firefox", "firefox-mv2", 2],
];
const REQUIRED_PERMISSIONS = ["activeTab", "storage", "nativeMessaging"];
const MATCHES = ["http://*/*", "https://*/*"];

function fail(message) { throw new Error(message); }

function exactArray(actual, expected, label) {
  if (!Array.isArray(actual) || actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    fail(`${label} is not the expected exact array.`);
  }
}

function assertFile(root, relative, label) {
  return fs.stat(path.join(root, relative)).then((stat) => {
    if (!stat.isFile()) fail(`${label} is missing.`);
  });
}

function validateManifest(manifest, target, version) {
  if (manifest.manifest_version !== version || manifest.name !== "arthur" || manifest.version !== "0.1.0") {
    fail(`${target} manifest identity is invalid.`);
  }
  exactArray(manifest.permissions, version === 3 ? REQUIRED_PERMISSIONS : [...REQUIRED_PERMISSIONS, ...MATCHES], `${target} permissions`);
  if (version === 3) exactArray(manifest.host_permissions, MATCHES, `${target} host permissions`);
  const gecko = manifest.browser_specific_settings?.gecko;
  if (!gecko || gecko.id !== "arthur@olhapi.com") fail(`${target} Gecko identity is missing.`);
  if (manifest.options_ui?.page !== "options.html" || manifest.options_ui?.open_in_tab !== false) fail(`${target} options page is invalid.`);
  if (!Array.isArray(manifest.content_scripts) || manifest.content_scripts.length !== 1) fail(`${target} content script is missing.`);
  const content = manifest.content_scripts[0];
  exactArray(content.matches, MATCHES, `${target} content-script matches`);
  exactArray(content.js, ["content-scripts/content.js"], `${target} content-script entries`);
  if (version === 3) {
    if (manifest.background?.service_worker !== "background.js") fail(`${target} service worker is invalid.`);
    if (!manifest.action || Object.hasOwn(manifest.action, "default_popup")) fail(`${target} must not declare a default action popup.`);
  } else {
    exactArray(manifest.background?.scripts, ["background.js"], `${target} background scripts`);
    if (!manifest.browser_action || Object.hasOwn(manifest.browser_action, "default_popup")) fail(`${target} must not declare a default browser-action popup.`);
  }
}

export async function validateBuildArtifacts({ root = path.join(ROOT, ".output") } = {}) {
  const canonicalRoot = path.resolve(root);
  const targets = [];
  for (const [target, directory, version] of TARGETS) {
    const artifact = path.join(canonicalRoot, directory);
    const manifest = JSON.parse(await fs.readFile(path.join(artifact, "manifest.json"), "utf8"));
    validateManifest(manifest, target, version);
    await Promise.all([
      assertFile(artifact, "background.js", `${target} background entrypoint`),
      assertFile(artifact, "content-scripts/content.js", `${target} content-script entrypoint`),
      assertFile(artifact, "options.html", `${target} options page`),
      assertFile(artifact, "status.html", `${target} status page`),
    ]);
    targets.push(target);
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
