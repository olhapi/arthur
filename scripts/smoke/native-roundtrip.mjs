import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURES = [
  ["animated.gif", "image", "image/gif"], ["animated.webp", "image", "image/webp"],
  ["diagram.svg", "image", "image/svg+xml"], ["photo.avif", "image", "image/avif"],
  ["audio.mp3", "audio", "audio/mpeg"], ["video.mp4", "video", "video/mp4"],
];
const MAX_REQUEST = 64 * 1024 * 1024;
const IMAGE_LIMIT = 100 * 1024 * 1024;
const AV_LIMIT = 2 * 1024 * 1024 * 1024;
const TOTAL_LIMIT = 4 * 1024 * 1024 * 1024;

function fail(message) { throw new Error(message); }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function frame(value) { const body = Buffer.from(JSON.stringify(value)); return Buffer.concat([Buffer.from(Uint32Array.of(body.length).buffer), body]); }
function rawFrame(body) { const header = Buffer.alloc(4); header.writeUInt32LE(body.length); return Buffer.concat([header, body]); }

function decodeFrames(bytes) {
  const result = [];
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 4 > bytes.length) fail("native stdout contains a truncated frame header");
    const length = bytes.readUInt32LE(offset); offset += 4;
    if (length === 0 || offset + length > bytes.length) fail("native stdout contains a malformed frame");
    result.push(JSON.parse(bytes.subarray(offset, offset + length).toString("utf8")));
    offset += length;
  }
  return result;
}

export async function validateNativeBinary(binary) {
  if (!path.isAbsolute(binary) || path.basename(binary) !== "arthur-native-host") fail("Binary is not Arthur's direct Rust binary.");
  const stat = await fs.lstat(binary);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o111) === 0) fail("Binary is not Arthur's direct Rust binary.");
  const handle = await fs.open(binary, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(2); await handle.read(bytes, 0, 2, 0);
    if (bytes.toString("utf8") === "#!") fail("Binary is not Arthur's direct Rust binary.");
  } finally { await handle.close(); }
  return path.resolve(binary);
}

function run(binary, messagesOrBytes) {
  const input = Buffer.isBuffer(messagesOrBytes) ? messagesOrBytes : Buffer.concat(messagesOrBytes.map(frame));
  const result = spawnSync(binary, [], { input, encoding: null, env: { PATH: "/usr/bin:/bin" }, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? Buffer.alloc(0), stderr: result.stderr ?? Buffer.alloc(0), messages: decodeFrames(result.stdout ?? Buffer.alloc(0)) };
}

function expect(result, predicate, label) { if (!predicate(result)) fail(label); }
function message(type, requestId) { return { type, requestId }; }

function saveMessages({ destination, source, title, markdown, session, media = [] }) {
  const messages = [
    { ...message("hello", "hello"), protocolVersion: 1 },
    { ...message("begin_save", "begin"), sessionId: session, destination, source, title, markdown },
  ];
  for (const item of media) {
    messages.push({ ...message("begin_media", `begin-${item.id}`), sessionId: session, mediaId: item.id, source: item.source, kind: item.kind, contentType: item.contentType, byteLength: item.bytes.length });
    messages.push({ type: "media_chunk", sessionId: session, mediaId: item.id, sequence: 0, data: item.bytes.toString("base64") });
    messages.push({ ...message("end_media", `end-${item.id}`), sessionId: session, mediaId: item.id, chunks: 1 });
  }
  messages.push({ ...message("commit_save", "commit"), sessionId: session });
  return messages;
}

async function fixtureMedia() {
  return Promise.all(FIXTURES.map(async ([name, kind, contentType]) => ({
    id: randomUUID(), name, kind, contentType, source: `https://fixtures.example.test/${name}`,
    bytes: await fs.readFile(path.join(ROOT, "tests/fixtures/media", name)),
  })));
}

async function assertSaved(destination, media) {
  const notes = (await fs.readdir(destination)).filter((name) => name.endsWith(".md"));
  if (notes.length !== 1 || notes[0] !== "Article.md") fail("normalized source did not replace Article.md in place");
  const note = await fs.readFile(path.join(destination, notes[0]), "utf8");
  if (!note.startsWith("---\ntitle: \"Article\"\nsource: \"https://example.test/a\"\n---\n\n") || note.includes("\r")) fail("note frontmatter or line endings are invalid");
  const attachmentNames = await fs.readdir(path.join(destination, "attachments"));
  if (attachmentNames.length !== media.length) fail("not every fixture was installed");
  const hashes = await Promise.all(attachmentNames.map(async (name) => sha256(await fs.readFile(path.join(destination, "attachments", name)))));
  const expected = media.map((item) => sha256(item.bytes)).sort();
  if (hashes.sort().join(",") !== expected.join(",")) fail("attachments are not byte-identical fixture copies");
  for (const name of attachmentNames) if (!note.includes(`![[attachments/${name}]]`)) fail("note does not use lowercase attachments embeds");
  return note;
}

async function poisonCases(binary) {
  const hello = frame({ type: "hello", requestId: "later", protocolVersion: 1 });
  const cases = [
    Buffer.concat([Buffer.alloc(4), hello]),
    Buffer.concat([Buffer.from(Uint32Array.of(MAX_REQUEST + 1).buffer), hello]),
    Buffer.concat([rawFrame(Buffer.from([0xc3, 0x28])), hello]),
    Buffer.concat([rawFrame(Buffer.from("not-json")), hello]),
    Buffer.from([1, 0]),
  ];
  for (const input of cases) {
    const result = run(binary, input);
    if (result.status === 0 || result.messages.length !== 1 || result.messages[0]?.type !== "error" || result.messages[0]?.code !== "invalid_native_frame") fail("poisoned connection accepted a later frame");
    if (!result.stderr.toString("utf8").includes("native message stream rejected")) fail("poison diagnostic is missing or not redacted");
  }
}

function liveHost(binary) {
  const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" } });
  let buffered = Buffer.alloc(0); let stderr = Buffer.alloc(0); const waiters = [];
  function pump() {
    while (buffered.length >= 4) {
      const length = buffered.readUInt32LE(0);
      if (length === 0 || buffered.length < length + 4) return;
      const value = JSON.parse(buffered.subarray(4, length + 4).toString("utf8"));
      buffered = buffered.subarray(length + 4);
      const waiter = waiters.shift(); if (waiter) waiter.resolve(value);
    }
  }
  child.stdout.on("data", (chunk) => { buffered = Buffer.concat([buffered, chunk]); pump(); });
  child.stderr.on("data", (chunk) => { stderr = Buffer.concat([stderr, chunk]); });
  child.on("error", (error) => { for (const waiter of waiters.splice(0)) waiter.reject(error); });
  return {
    async send(value) {
      const response = new Promise((resolve, reject) => waiters.push({ resolve, reject }));
      child.stdin.write(frame(value)); return response;
    },
    async close() {
      child.stdin.end();
      await new Promise((resolve, reject) => child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`native host exited ${code}`))));
      return stderr;
    },
  };
}

async function attachmentSymlinkRace(binary, destination) {
  const race = path.join(destination, "attachment-race"); const outside = path.join(destination, "outside");
  await fs.mkdir(race); await fs.mkdir(outside);
  const session = randomUUID(); const mediaId = randomUUID(); const host = liveHost(binary);
  try {
    const begin = await host.send({ ...message("begin_save", "race-begin"), sessionId: session, destination: race, source: "https://example.test/race", title: "Race", markdown: `arthur-media://${mediaId}` });
    if (begin.type !== "ack") fail("race setup did not begin a native save");
    await fs.rmdir(path.join(race, "attachments")); await fs.symlink(outside, path.join(race, "attachments"));
    const media = await host.send({ ...message("begin_media", "race-media"), sessionId: session, mediaId, source: "https://fixtures.example.test/race.gif", kind: "image", contentType: "image/gif", byteLength: 1 });
    if (media.type !== "ack") fail("race media did not begin");
    await host.send({ type: "media_chunk", sessionId: session, mediaId, sequence: 0, data: "eA==" });
    await host.send({ ...message("end_media", "race-end"), sessionId: session, mediaId, chunks: 1 });
    const commit = await host.send({ ...message("commit_save", "race-commit"), sessionId: session });
    if (commit.type !== "error" || commit.code !== "unsafe_child") fail("attachment symlink race was not rejected");
    if ((await fs.readdir(outside)).length !== 0) fail("attachment symlink race redirected a write outside the destination");
  } finally {
    const stderr = await host.close(); if (stderr.length !== 0) fail("race case emitted diagnostics on a valid connection");
  }
}

async function limits(binary, destination) {
  const prior = Buffer.from("---\ntitle: \"Limit\"\nsource: \"https://example.test/limit\"\n---\n\nold");
  const note = path.join(destination, "Limit.md"); await fs.writeFile(note, prior);
  const individualSession = randomUUID();
  const individual = run(binary, [
    { ...message("begin_save", "begin-limit"), sessionId: individualSession, destination, source: "https://example.test/limit", title: "Limit", markdown: "new" },
    { ...message("begin_media", "too-large"), sessionId: individualSession, mediaId: randomUUID(), source: "https://fixtures.example.test/large.gif", kind: "image", contentType: "image/gif", byteLength: IMAGE_LIMIT + 1 },
  ]);
  if (!individual.messages.some((item) => item.type === "error")) fail("individual media limit did not fail");
  if (!Buffer.from(await fs.readFile(note)).equals(prior)) fail("individual limit exposed a partial note");
  const session = randomUUID(); const ids = [randomUUID(), randomUUID(), randomUUID()];
  const total = run(binary, [
    { ...message("begin_save", "begin-total"), sessionId: session, destination, source: "https://example.test/limit", title: "Limit", markdown: "new" },
    ...ids.map((mediaId, index) => ({ ...message("begin_media", `total-${index}`), sessionId: session, mediaId, source: `https://fixtures.example.test/${index}.mp4`, kind: "video", contentType: "video/mp4", byteLength: AV_LIMIT })),
  ]);
  if (!total.messages.some((item) => item.type === "error" && item.code === "media_limit_exceeded")) fail("total media limit did not fail");
  if (!Buffer.from(await fs.readFile(note)).equals(prior)) fail("total limit exposed a partial note");
}

async function interrupted(binary, destination) {
  const note = path.join(destination, "Interrupted.md"); const prior = Buffer.from("---\ntitle: \"Interrupted\"\nsource: \"https://example.test/interrupted\"\n---\n\nold note"); await fs.writeFile(note, prior);
  const result = run(binary, [{ ...message("begin_save", "interrupt"), sessionId: randomUUID(), destination, source: "https://example.test/interrupted", title: "Interrupted", markdown: "new" }]);
  if (result.status !== 0 || result.stderr.length !== 0 || !Buffer.from(await fs.readFile(note)).equals(prior)) fail("EOF interruption changed the prior note");
}

export async function nativeRoundtrip({ binary, destination } = {}) {
  const directBinary = await validateNativeBinary(binary ?? path.join(ROOT, "native/target/release/arthur-native-host"));
  const ownsDestination = destination === undefined;
  const root = destination === undefined ? await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "arthur-native-roundtrip-")) : path.resolve(destination);
  if (!path.isAbsolute(root)) fail("Destination must be absolute.");
  await fs.mkdir(root, { recursive: true });
  try {
    await fs.writeFile(path.join(root, "Article.md"), "---\ntitle: \"Article\"\nsource: \"HTTPS://Example.TEST:443/a#old\"\n---\n\nold\n");
    const media = await fixtureMedia();
    const first = run(directBinary, saveMessages({ destination: root, source: "https://example.test/a#new", title: "Article", markdown: media.map((item) => `arthur-media://${item.id}`).join("\n"), session: randomUUID(), media }));
    if (first.status !== 0 || first.stderr.length !== 0 || first.messages.at(-1)?.type !== "save_result") fail("fixture save did not complete through the direct binary");
    await assertSaved(root, media);
    const collision = run(directBinary, saveMessages({ destination: root, source: "https://example.test/different", title: "Article", markdown: "unrelated", session: randomUUID() }));
    if (collision.status !== 0 || collision.messages.at(-1)?.type !== "save_result") fail("same-title different-source save failed");
    if ((await fs.readdir(root)).filter((name) => name.endsWith(".md")).length !== 2) fail("same-title different-source save overwrote an unrelated note");
    const warningId = randomUUID(); const warningSession = randomUUID();
    const warning = run(directBinary, [
      { ...message("begin_save", "warning-begin"), sessionId: warningSession, destination: root, source: "https://example.test/warning", title: "Warning", markdown: `arthur-media://${warningId}` },
      { ...message("begin_media", "warning-media"), sessionId: warningSession, mediaId: warningId, source: "https://fixtures.example.test/missing.mp3", kind: "audio", contentType: "audio/mpeg", byteLength: 1 },
      { type: "media_chunk", sessionId: warningSession, mediaId: warningId, sequence: 0, data: "eA==" },
      { ...message("end_media", "warning-end"), sessionId: warningSession, mediaId: warningId, chunks: 2 },
      { ...message("commit_save", "warning-commit"), sessionId: warningSession },
    ]);
    if (!warning.messages.some((item) => item.type === "warning" && item.code === "media_fallback") || warning.messages.at(-1)?.type !== "save_result") fail("incomplete media did not commit with a warning");
    if (!(await fs.readFile(path.join(root, "Warning.md"), "utf8")).includes("<https://fixtures.example.test/missing.mp3>")) fail("warning did not retain a normalized remote autolink");
    await limits(directBinary, root); await interrupted(directBinary, root); await attachmentSymlinkRace(directBinary, root); await poisonCases(directBinary);
    return { acceptance: "native-roundtrip", binary: directBinary, destination: root, fixtures: media.map((item) => ({ name: item.name, sha256: sha256(item.bytes) })), checks: ["bytes", "overwrite", "collision", "warning", "limits", "interruption", "symlink-race", "poison"] };
  } finally { if (ownsDestination) await fs.rm(root, { recursive: true, force: true }); }
}

function parseArguments(argv) {
  let binary; let destination;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]; const value = argv[index + 1];
    if ((flag !== "--binary" && flag !== "--destination") || !value) throw new Error("Usage: native-roundtrip.mjs [--binary path] [--destination /absolute/path]");
    if (flag === "--binary") binary = path.resolve(value);
    else {
      if (!path.isAbsolute(value)) throw new Error("Usage: native-roundtrip.mjs [--binary path] [--destination /absolute/path]");
      destination = value;
    }
  }
  return { binary, destination };
}

async function main() { process.stdout.write(`${JSON.stringify(await nativeRoundtrip(parseArguments(process.argv.slice(2))))}\n`); }
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => { process.stderr.write(`Arthur native roundtrip failed: ${error.message}\n`); process.exitCode = 1; });
