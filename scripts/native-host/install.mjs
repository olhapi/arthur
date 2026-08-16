import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CHROMIUM_EXTENSION_ID } from "./identity.mjs";

export const NATIVE_HOST_NAME = "com.olhapi.arthur";
export const FIREFOX_EXTENSION_ID = "arthur@olhapi.com";
const APP_SUPPORT = ["Library", "Application Support"];

function requiredAbsolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new TypeError(`${label} must be an absolute path.`);
  return path.resolve(value);
}

function requireMacos(platform) {
  if (platform !== "darwin") throw new Error("Arthur native-host installation is supported only on macOS.");
}

export function nativeHostTargets({ home, platform, targets } = {}) {
  requireMacos(platform);
  const resolvedHome = requiredAbsolute(home, "home");
  const support = path.join(resolvedHome, ...APP_SUPPORT);
  const expected = {
    binary: path.join(support, "Arthur", "native-host", "arthur-native-host"),
    chrome: path.join(support, "Google", "Chrome", "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`),
    edge: path.join(support, "Microsoft Edge", "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`),
    firefox: path.join(support, "Mozilla", "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`),
  };
  if (targets !== undefined) {
    for (const [name, value] of Object.entries(targets)) {
      if (!(name in expected) || path.resolve(value) !== expected[name]) {
        throw new Error("Native-host target is outside Arthur's exact allowlist.");
      }
    }
  }
  return expected;
}

function manifest(pathname, browser) {
  const base = { name: NATIVE_HOST_NAME, description: "Arthur native host", path: pathname, type: "stdio" };
  return browser === "firefox"
    ? { ...base, allowed_extensions: [FIREFOX_EXTENSION_ID] }
    : { ...base, allowed_origins: [`chrome-extension://${CHROMIUM_EXTENSION_ID}/`] };
}

function missing(error) {
  return error && typeof error === "object" && error.code === "ENOENT";
}

export async function assertRegularNonSymlink(fs, pathname, label) {
  let stat;
  try {
    stat = await fs.lstat(pathname);
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink.`);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file.`);
  return true;
}

async function assertDirectory(fs, pathname) {
  await fs.mkdir(pathname, { recursive: true });
  const stat = await fs.lstat(pathname);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Native-host parent must be a real directory: ${pathname}`);
}

export async function buildInstallPlan({
  home,
  platform,
  repositoryPath,
  nativeBinaryPath,
  targets,
  fs = nodeFs,
} = {}) {
  const expected = nativeHostTargets({ home, platform, targets });
  const repository = repositoryPath === undefined ? undefined : requiredAbsolute(repositoryPath, "repositoryPath");
  const source = nativeBinaryPath === undefined
    ? path.join(repository ?? "", "native", "target", "release", "arthur-native-host")
    : requiredAbsolute(nativeBinaryPath, "nativeBinaryPath");
  if (!(await assertRegularNonSymlink(fs, source, "Release native binary"))) {
    throw new Error("Release native binary is missing.");
  }
  for (const target of Object.values(expected)) await assertRegularNonSymlink(fs, target, "Installed native-host target");
  return {
    targets: expected,
    payloads: [{ source, destination: expected.binary, mode: 0o755 }],
    manifests: [
      { destination: expected.chrome, contents: manifest(expected.binary, "chromium") },
      { destination: expected.edge, contents: manifest(expected.binary, "chromium") },
      { destination: expected.firefox, contents: manifest(expected.binary, "firefox") },
    ],
  };
}

async function atomicCopy(fs, source, destination, mode) {
  const parent = path.dirname(destination);
  await assertDirectory(fs, parent);
  await assertRegularNonSymlink(fs, destination, "Installed native-host target");
  const staging = path.join(parent, `.${path.basename(destination)}.${randomUUID()}.tmp`);
  const sourceHandle = await fs.open(source, "r");
  const destinationHandle = await fs.open(staging, "wx", mode);
  try {
    await destinationHandle.writeFile(await sourceHandle.readFile());
    await destinationHandle.chmod(mode);
    await destinationHandle.sync();
  } finally {
    await Promise.allSettled([sourceHandle.close(), destinationHandle.close()]);
  }
  await assertRegularNonSymlink(fs, destination, "Installed native-host target");
  await fs.rename(staging, destination);
}

async function atomicJson(fs, destination, contents) {
  const parent = path.dirname(destination);
  await assertDirectory(fs, parent);
  await assertRegularNonSymlink(fs, destination, "Native-host manifest target");
  const staging = path.join(parent, `.${path.basename(destination)}.${randomUUID()}.tmp`);
  const handle = await fs.open(staging, "wx", 0o644);
  try {
    await handle.writeFile(`${JSON.stringify(contents, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await assertRegularNonSymlink(fs, destination, "Native-host manifest target");
  await fs.rename(staging, destination);
}

export async function applyInstallPlan(plan, { fs = nodeFs } = {}) {
  if (!plan || !plan.targets || !Array.isArray(plan.payloads) || plan.payloads.length !== 1 || !Array.isArray(plan.manifests) || plan.manifests.length !== 3) {
    throw new TypeError("Install plan must contain exactly one payload and three manifests.");
  }
  const payload = plan.payloads[0];
  const expectedDestinations = [plan.targets.binary, plan.targets.chrome, plan.targets.edge, plan.targets.firefox];
  if (
    !payload || payload.mode !== 0o755 || payload.destination !== plan.targets.binary ||
    plan.manifests.some((entry, index) => entry.destination !== expectedDestinations[index + 1]) ||
    JSON.stringify(plan.manifests[0]?.contents) !== JSON.stringify(manifest(plan.targets.binary, "chromium")) ||
    JSON.stringify(plan.manifests[1]?.contents) !== JSON.stringify(manifest(plan.targets.binary, "chromium")) ||
    JSON.stringify(plan.manifests[2]?.contents) !== JSON.stringify(manifest(plan.targets.binary, "firefox"))
  ) throw new Error("Install plan contains a target outside Arthur's exact allowlist.");
  if (!(await assertRegularNonSymlink(fs, payload.source, "Release native binary"))) throw new Error("Release native binary is missing.");
  await atomicCopy(fs, payload.source, payload.destination, payload.mode);
  for (const entry of plan.manifests) await atomicJson(fs, entry.destination, entry.contents);
}

async function main({ argv, env, platform, fs, repositoryPath }) {
  if (argv.length !== 0) throw new Error("Usage: install.mjs");
  const plan = await buildInstallPlan({ home: env.HOME, platform, repositoryPath, fs });
  await applyInstallPlan(plan, { fs });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main({ argv: process.argv.slice(2), env: process.env, platform: process.platform, fs: nodeFs, repositoryPath: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..") })
    .catch((error) => { process.stderr.write(`Arthur native-host install failed: ${error.message}\n`); process.exitCode = 1; });
}
