import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
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

export async function canonicalizeHome(fs, home) {
  const requested = requiredAbsolute(home, "home");
  const canonical = await fs.realpath(requested);
  const stat = await fs.lstat(canonical);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("home must resolve to a real directory.");
  return canonical;
}

export async function validateDirectoryChain(fs, home, directory, { create = false } = {}) {
  const relative = path.relative(home, directory);
  if (relative === "" || relative === ".") return;
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Native-host path escapes its canonical home.");
  let current = home;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Native-host parent must be a real directory: ${current}`);
    } catch (error) {
      if (!missing(error) || !create) throw error;
      await fs.mkdir(current);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Native-host parent must be a real directory: ${current}`);
    }
  }
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

export async function buildInstallPlan({
  home,
  platform,
  repositoryPath,
  nativeBinaryPath,
  targets,
  fs = nodeFs,
} = {}) {
  const canonicalHome = await canonicalizeHome(fs, home);
  const expected = nativeHostTargets({ home: canonicalHome, platform, targets });
  const repository = repositoryPath === undefined ? undefined : requiredAbsolute(repositoryPath, "repositoryPath");
  const source = nativeBinaryPath === undefined
    ? path.join(repository ?? "", "native", "target", "release", "arthur-native-host")
    : requiredAbsolute(nativeBinaryPath, "nativeBinaryPath");
  if (!(await assertRegularNonSymlink(fs, source, "Release native binary"))) {
    throw new Error("Release native binary is missing.");
  }
  for (const target of Object.values(expected)) await assertRegularNonSymlink(fs, target, "Installed native-host target");
  return {
    home: canonicalHome,
    platform,
    targets: expected,
    payloads: [{ source, destination: expected.binary, mode: 0o755 }],
    manifests: [
      { destination: expected.chrome, contents: manifest(expected.binary, "chromium") },
      { destination: expected.edge, contents: manifest(expected.binary, "chromium") },
      { destination: expected.firefox, contents: manifest(expected.binary, "firefox") },
    ],
  };
}

async function readRegularSource(fs, source) {
  if (!(await assertRegularNonSymlink(fs, source, "Release native binary"))) throw new Error("Release native binary is missing.");
  const handle = await fs.open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Release native binary must be a regular file.");
    const bytes = await handle.readFile();
    await handle.close();
    return bytes;
  } catch (error) {
    try { await handle.close(); } catch { /* close cannot repair the failed operation */ }
    throw error;
  }
}

async function removeOwnedStaging(fs, home, staging) {
  try {
    await validateDirectoryChain(fs, home, path.dirname(staging));
    const stat = await fs.lstat(staging);
    if (stat.isFile() && !stat.isSymbolicLink()) {
      await validateDirectoryChain(fs, home, path.dirname(staging));
      await fs.unlink(staging);
    }
  } catch { /* best-effort cleanup only for the unique owned staging path */ }
}

async function atomicWrite(fs, home, destination, bytes, mode, label) {
  const parent = path.dirname(destination);
  await validateDirectoryChain(fs, home, parent, { create: true });
  await assertRegularNonSymlink(fs, destination, "Installed native-host target");
  const staging = path.join(parent, `.${path.basename(destination)}.${randomUUID()}.tmp`);
  let destinationHandle;
  try {
    await validateDirectoryChain(fs, home, parent);
    destinationHandle = await fs.open(staging, "wx", mode);
    await destinationHandle.writeFile(bytes);
    await destinationHandle.chmod(mode);
    await destinationHandle.sync();
    await destinationHandle.close();
    destinationHandle = undefined;
  } catch (error) {
    if (destinationHandle !== undefined) {
      try { await destinationHandle.close(); } catch { /* preserve the original failure */ }
    }
    await removeOwnedStaging(fs, home, staging);
    throw error;
  }
  try {
    await validateDirectoryChain(fs, home, parent);
    await assertRegularNonSymlink(fs, destination, label);
    await fs.rename(staging, destination);
  } catch (error) {
    await removeOwnedStaging(fs, home, staging);
    throw error;
  }
}

async function atomicCopy(fs, home, source, destination, mode) {
  await atomicWrite(fs, home, destination, await readRegularSource(fs, source), mode, "Installed native-host target");
}

async function atomicJson(fs, home, destination, contents) {
  await atomicWrite(fs, home, destination, Buffer.from(`${JSON.stringify(contents, null, 2)}\n`), 0o644, "Native-host manifest target");
}

export async function applyInstallPlan(plan, { fs = nodeFs, home, platform } = {}) {
  if (!plan || !Array.isArray(plan.payloads) || plan.payloads.length !== 1 || !Array.isArray(plan.manifests) || plan.manifests.length !== 3) {
    throw new TypeError("Install plan must contain exactly one payload and three manifests.");
  }
  const canonicalHome = await canonicalizeHome(fs, home);
  const expectedTargets = nativeHostTargets({ home: canonicalHome, platform });
  const payload = plan.payloads[0];
  const expectedDestinations = [expectedTargets.binary, expectedTargets.chrome, expectedTargets.edge, expectedTargets.firefox];
  if (
    !payload || payload.mode !== 0o755 || payload.destination !== expectedTargets.binary ||
    plan.manifests.some((entry, index) => entry.destination !== expectedDestinations[index + 1]) ||
    JSON.stringify(plan.manifests[0]?.contents) !== JSON.stringify(manifest(expectedTargets.binary, "chromium")) ||
    JSON.stringify(plan.manifests[1]?.contents) !== JSON.stringify(manifest(expectedTargets.binary, "chromium")) ||
    JSON.stringify(plan.manifests[2]?.contents) !== JSON.stringify(manifest(expectedTargets.binary, "firefox"))
  ) throw new Error("Install plan contains a target outside Arthur's exact allowlist.");
  if (!(await assertRegularNonSymlink(fs, payload.source, "Release native binary"))) throw new Error("Release native binary is missing.");
  await atomicCopy(fs, canonicalHome, payload.source, payload.destination, payload.mode);
  for (const entry of plan.manifests) await atomicJson(fs, canonicalHome, entry.destination, entry.contents);
}

async function main({ argv, env, platform, fs, repositoryPath }) {
  if (argv.length !== 0) throw new Error("Usage: install.mjs");
  const plan = await buildInstallPlan({ home: env.HOME, platform, repositoryPath, fs });
  await applyInstallPlan(plan, { fs, home: env.HOME, platform });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main({ argv: process.argv.slice(2), env: process.env, platform: process.platform, fs: nodeFs, repositoryPath: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..") })
    .catch((error) => { process.stderr.write(`Arthur native-host install failed: ${error.message}\n`); process.exitCode = 1; });
}
