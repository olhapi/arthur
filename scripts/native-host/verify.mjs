import { spawn as nodeSpawn } from "node:child_process";
import * as nodeFs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FIREFOX_EXTENSION_ID, NATIVE_HOST_NAME, assertRegularNonSymlink, canonicalizeHome, nativeHostTargets, validateDirectoryChain } from "./install.mjs";
import { CHROMIUM_EXTENSION_ID } from "./identity.mjs";

const MINIMAL_ENV = { PATH: "/usr/bin:/bin" };
const MAX_RESPONSE_BYTES = 1024 * 1024;

function missing(error) {
  return error && typeof error === "object" && error.code === "ENOENT";
}

function expectedManifest(binary, browser) {
  const base = { name: NATIVE_HOST_NAME, description: "Arthur native host", path: binary, type: "stdio" };
  return browser === "firefox"
    ? { ...base, allowed_extensions: [FIREFOX_EXTENSION_ID] }
    : { ...base, allowed_origins: [`chrome-extension://${CHROMIUM_EXTENSION_ID}/`] };
}

function exactJson(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} does not match Arthur's required native-host manifest.`);
}

async function readManifest(fs, home, pathname, expected, label) {
  await validateDirectoryChain(fs, home, path.dirname(pathname));
  await assertRegularNonSymlink(fs, pathname, label);
  let parsed;
  try { parsed = JSON.parse(await fs.readFile(pathname, "utf8")); } catch { throw new Error(`${label} contains invalid JSON.`); }
  exactJson(parsed, expected, label);
}

function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(body.length);
  return Buffer.concat([prefix, body]);
}

function parseSingleFrame(bytes) {
  if (bytes.length < 4) throw new Error("Native host returned a malformed framed response.");
  const length = bytes.readUInt32LE(0);
  if (length === 0 || length > 1024 * 1024 || bytes.length !== length + 4) throw new Error("Native host returned malformed or noisy stdout.");
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(4)); } catch { throw new Error("Native host returned invalid UTF-8."); }
  try { return JSON.parse(text); } catch { throw new Error("Native host returned malformed JSON."); }
}

export function requestHost(spawn, binary, request) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], { env: MINIMAL_ENV, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let header = Buffer.alloc(0);
    let responseLength;
    let stdoutBytes = 0;
    let failed = false;
    const fail = (error) => {
      if (failed) return;
      failed = true;
      child.kill?.();
      reject(error);
    };
    child.stdout.on("data", (chunk) => {
      if (failed) return;
      const bytes = Buffer.from(chunk);
      stdoutBytes += bytes.length;
      if (stdoutBytes > MAX_RESPONSE_BYTES + 4) return fail(new Error("Native host response exceeds 1 MiB."));
      try {
        let payload = bytes;
        if (responseLength === undefined) {
          header = Buffer.concat([header, bytes]);
          if (header.length < 4) {
            stdout.push(bytes);
            return;
          }
          responseLength = header.readUInt32LE(0);
          if (responseLength > MAX_RESPONSE_BYTES) return fail(new Error("Native host response exceeds 1 MiB."));
          payload = header.subarray(4);
        }
        decoder.decode(payload, { stream: true });
      } catch { return fail(new Error("Native host returned invalid UTF-8.")); }
      stdout.push(bytes);
    });
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", fail);
    child.on("close", (code) => {
      if (failed) return;
      if (code !== 0) return reject(new Error("Native host exited unsuccessfully."));
      if (Buffer.concat(stderr).length !== 0) return reject(new Error("Native host wrote diagnostics during verification."));
      try {
        decoder.decode();
        resolve(parseSingleFrame(Buffer.concat(stdout)));
      } catch (error) { reject(error instanceof Error ? error : new Error("Native host returned invalid UTF-8.")); }
    });
    child.stdin.on("error", reject);
    child.stdin.end(frame(request));
  });
}

async function assertAbsent(fs, home, targets) {
  for (const target of Object.values(targets)) {
    try {
      await validateDirectoryChain(fs, home, path.dirname(target));
      await fs.lstat(target);
      throw new Error(`Arthur native-host target was expected absent: ${target}`);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
}

export async function verifyInstall({ home, platform, destination, expectAbsent = false, fs = nodeFs, spawn = nodeSpawn } = {}) {
  const canonicalHome = await canonicalizeHome(fs, home);
  const targets = nativeHostTargets({ home: canonicalHome, platform });
  if (expectAbsent) {
    if (destination !== undefined) throw new Error("--expect-absent cannot be combined with a destination test.");
    await assertAbsent(fs, canonicalHome, targets);
    return { installed: false, absent: true };
  }
  await validateDirectoryChain(fs, canonicalHome, path.dirname(targets.binary));
  await readManifest(fs, canonicalHome, targets.chrome, expectedManifest(targets.binary, "chromium"), "Chrome manifest");
  await readManifest(fs, canonicalHome, targets.edge, expectedManifest(targets.binary, "chromium"), "Edge manifest");
  await readManifest(fs, canonicalHome, targets.firefox, expectedManifest(targets.binary, "firefox"), "Firefox manifest");
  await assertRegularNonSymlink(fs, targets.binary, "Installed native-host binary");
  const binaryStat = await fs.lstat(targets.binary);
  if ((binaryStat.mode & 0o777) !== 0o755) throw new Error("Installed native-host binary must have mode 0755.");
  await validateDirectoryChain(fs, canonicalHome, path.dirname(targets.binary));
  const nativeFiles = await fs.readdir(path.dirname(targets.binary));
  if (nativeFiles.length !== 1 || nativeFiles[0] !== "arthur-native-host") throw new Error("Native-host directory must contain exactly one binary.");
  const hello = await requestHost(spawn, targets.binary, { type: "hello", requestId: "verify-hello", protocolVersion: 1 });
  if (!hello || hello.type !== "hello_result" || hello.requestId !== "verify-hello" || hello.protocolVersion !== 1 || hello.hostName !== "Arthur native host" || typeof hello.hostVersion !== "string") {
    throw new Error("Native host returned an invalid hello response.");
  }
  if (destination === undefined) return { installed: true };
  if (!path.isAbsolute(destination)) throw new Error("Destination test path must be absolute.");
  const normalizedDestination = await fs.realpath(path.resolve(destination));
  const result = await requestHost(spawn, targets.binary, { type: "test_destination", requestId: "verify-destination", destination: normalizedDestination });
  if (!result || result.type !== "test_destination_result" || result.requestId !== "verify-destination" || result.destination !== normalizedDestination || result.writable !== true) {
    throw new Error("Native host destination test did not confirm the exact writable destination.");
  }
  return { installed: true, destination: normalizedDestination };
}

function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === "--expect-absent") return { expectAbsent: true };
  if (argv.length === 2 && argv[0] === "--destination") return { destination: argv[1] };
  if (argv.length === 0) return {};
  throw new Error("Usage: verify.mjs [--destination /absolute/path | --expect-absent]");
}

async function main({ argv, env, platform, fs, spawn }) {
  const options = parseArguments(argv);
  await verifyInstall({ ...options, home: env.HOME, platform, fs, spawn });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main({ argv: process.argv.slice(2), env: process.env, platform: process.platform, fs: nodeFs, spawn: nodeSpawn })
    .catch((error) => { process.stderr.write(`Arthur native-host verification failed: ${error.message}\n`); process.exitCode = 1; });
}
