import * as nodeFs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalizeHome, nativeHostTargets, validateDirectoryChain } from "./install.mjs";

function missing(error) {
  return error && typeof error === "object" && error.code === "ENOENT";
}

async function parentIsAbsent(fs, home, parent) {
  try {
    await validateDirectoryChain(fs, home, parent);
    return false;
  } catch (error) {
    if (missing(error)) return true;
    throw error;
  }
}

export async function buildUninstallPlan({ home, platform, targets, fs = nodeFs } = {}) {
  const canonicalHome = await canonicalizeHome(fs, home);
  const expected = nativeHostTargets({ home: canonicalHome, platform });
  const allowlist = Object.values(expected);
  if (targets !== undefined && (targets.length !== allowlist.length || targets.some((target) => !allowlist.includes(target)))) {
    throw new Error("Uninstall target is outside Arthur's exact allowlist.");
  }
  return { home: canonicalHome, platform, targets: allowlist, nativeHostDirectory: path.dirname(expected.binary) };
}

export async function applyUninstallPlan(plan, { fs = nodeFs, home, platform } = {}) {
  if (!plan || !Array.isArray(plan.targets) || plan.targets.length !== 4) throw new TypeError("Uninstall plan must contain four exact targets.");
  const canonicalHome = await canonicalizeHome(fs, home);
  const expected = nativeHostTargets({ home: canonicalHome, platform });
  const targets = Object.values(expected);
  const nativeHostDirectory = path.dirname(expected.binary);
  if (plan.targets.some((target, index) => target !== targets[index]) || plan.nativeHostDirectory !== nativeHostDirectory) {
    throw new Error("Uninstall plan contains a target outside Arthur's exact allowlist.");
  }
  for (const target of targets) {
    if (await parentIsAbsent(fs, canonicalHome, path.dirname(target))) continue;
    try {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Refusing to remove unexpected native-host target: ${target}`);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  for (const target of targets) {
    try {
      if (await parentIsAbsent(fs, canonicalHome, path.dirname(target))) continue;
      await fs.unlink(target);
    } catch (error) { if (!missing(error)) throw error; }
  }
  try {
    if (await parentIsAbsent(fs, canonicalHome, nativeHostDirectory)) return;
    if ((await fs.readdir(nativeHostDirectory)).length === 0) {
      if (await parentIsAbsent(fs, canonicalHome, nativeHostDirectory)) return;
      await fs.rmdir(nativeHostDirectory);
    }
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

async function main({ argv, env, platform, fs }) {
  if (argv.length !== 0) throw new Error("Usage: uninstall.mjs");
  const plan = await buildUninstallPlan({ home: env.HOME, platform, fs });
  await applyUninstallPlan(plan, { fs, home: env.HOME, platform });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main({ argv: process.argv.slice(2), env: process.env, platform: process.platform, fs: nodeFs })
    .catch((error) => { process.stderr.write(`Arthur native-host uninstall failed: ${error.message}\n`); process.exitCode = 1; });
}
