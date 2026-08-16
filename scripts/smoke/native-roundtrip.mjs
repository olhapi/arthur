import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURES = [
  { name: "animated.gif", kind: "image", contentType: "image/gif", format: "gif" },
  { name: "animated.webp", kind: "image", contentType: "image/webp", format: "webp" },
  { name: "diagram.svg", kind: "image", contentType: "image/svg+xml", format: "svg" },
  { name: "photo.avif", kind: "image", contentType: "image/avif", format: "avif" },
  { name: "audio.mp3", kind: "audio", contentType: "audio/mpeg", format: "mp3" },
  { name: "video.mp4", kind: "video", contentType: "video/mp4", format: "mp4" },
];
const DESTINATION_MARKER = ".arthur-native-roundtrip-v1";
const DESTINATION_MARKER_BYTES = "Arthur native roundtrip acceptance\n";
const MAX_REQUEST = 64 * 1024 * 1024;
const IMAGE_LIMIT = 100 * 1024 * 1024;
const AV_LIMIT = 2 * 1024 * 1024 * 1024;
const TOTAL_LIMIT = 4 * 1024 * 1024 * 1024;

function fail(message) { throw new Error(message); }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function frame(value) { const body = Buffer.from(JSON.stringify(value)); return Buffer.concat([Buffer.from(Uint32Array.of(body.length).buffer), body]); }
function rawFrame(body) { const header = Buffer.alloc(4); header.writeUInt32LE(body.length); return Buffer.concat([header, body]); }

function command(commandName, args) {
  const result = spawnSync(commandName, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) fail(`${commandName} could not validate Arthur's committed fixtures.`);
  return result.stdout;
}

function ffprobe(name) {
  return JSON.parse(command("ffprobe", ["-v", "error", "-show_entries", "format=format_name,duration:stream=codec_name,codec_type,width,height,nb_frames,duration", "-of", "json", path.join(ROOT, "tests/fixtures/media", name)]));
}

export async function inspectMediaFixtures() {
  const result = {};
  const gif = ffprobe("animated.gif").streams?.[0];
  if (gif?.codec_name !== "gif" || gif.width !== 2 || gif.height !== 2 || Number(gif.nb_frames) !== 2 || Number(gif.duration) <= 0) fail("animated.gif is not a decodable two-frame GIF.");
  result["animated.gif"] = { format: "gif", width: gif.width, height: gif.height, frames: Number(gif.nb_frames), duration: Number(gif.duration), streams: [gif.codec_type] };

  const webpInfo = command("webpmux", ["-info", path.join(ROOT, "tests/fixtures/media/animated.webp")]);
  const webpFrames = Number(/Number of frames:\s*(\d+)/.exec(webpInfo)?.[1]);
  const webpSize = /Canvas size:\s*(\d+) x (\d+)/.exec(webpInfo);
  const webpDurations = [...webpInfo.matchAll(/^\s*\d+:\s+\d+\s+\d+\s+\S+\s+\d+\s+\d+\s+(\d+)\s+/gmu)].map((match) => Number(match[1]));
  if (!webpInfo.includes("Features present: animation") || webpFrames !== 2 || !webpSize || webpDurations.length !== 2 || webpDurations.some((duration) => duration <= 0)) fail("animated.webp is not a decodable two-frame animated WebP.");
  result["animated.webp"] = { format: "webp", width: Number(webpSize[1]), height: Number(webpSize[2]), frames: webpFrames, duration: webpDurations.reduce((total, duration) => total + duration, 0) / 1000, streams: ["video"] };

  const svg = await fs.readFile(path.join(ROOT, "tests/fixtures/media/diagram.svg"), "utf8");
  const svgTag = /^<svg\b[^>]*\bwidth="(\d+)"[^>]*\bheight="(\d+)"[^>]*>/u.exec(svg.trim());
  if (!svgTag || !svg.includes("</svg>")) fail("diagram.svg is not a bounded SVG image.");
  result["diagram.svg"] = { format: "svg", width: Number(svgTag[1]), height: Number(svgTag[2]), frames: 1, streams: ["image"] };

  const avif = ffprobe("photo.avif"); const avifStream = avif.streams?.[0];
  const avifHeader = await fs.readFile(path.join(ROOT, "tests/fixtures/media/photo.avif"));
  if (avifHeader.subarray(4, 12).toString("ascii") !== "ftypavif" || avifStream?.codec_name !== "av1" || avifStream.width !== 16 || avifStream.height !== 16) fail("photo.avif is not a decodable AVIF image.");
  result["photo.avif"] = { format: "avif", width: avifStream.width, height: avifStream.height, frames: Number(avifStream.nb_frames), streams: ["image"] };

  const mp3 = ffprobe("audio.mp3"); const mp3Stream = mp3.streams?.[0];
  if (mp3Stream?.codec_name !== "mp3" || mp3Stream.codec_type !== "audio" || Number(mp3Stream.duration ?? mp3.format?.duration) <= 0) fail("audio.mp3 has no decodable audio frames.");
  result["audio.mp3"] = { format: "mp3", duration: Number(mp3Stream.duration ?? mp3.format.duration), streams: ["audio"] };

  const mp4 = ffprobe("video.mp4"); const video = mp4.streams?.find((stream) => stream.codec_type === "video");
  if (!mp4.format?.format_name?.includes("mp4") || !video || video.width !== 16 || video.height !== 16 || Number(video.nb_frames) < 2 || Number(video.duration ?? mp4.format?.duration) <= 0) fail("video.mp4 has no decodable video frames.");
  result["video.mp4"] = { format: "mp4", width: video.width, height: video.height, frames: Number(video.nb_frames), duration: Number(video.duration ?? mp4.format.duration), streams: ["video"] };
  return result;
}

export async function claimAcceptanceDestination(destination, { owned = false } = {}) {
  const root = path.resolve(destination);
  let stat;
  try { stat = await fs.lstat(root); } catch (error) {
    if (error?.code === "ENOENT") fail("Explicit acceptance destination must be an existing empty directory.");
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("Acceptance destination must be a real directory.");
  if ((await fs.readdir(root)).length !== 0) fail("Acceptance destination must be empty and dedicated to this run.");
  const marker = path.join(root, DESTINATION_MARKER);
  const handle = await fs.open(marker, "wx", 0o600);
  try { await handle.writeFile(DESTINATION_MARKER_BYTES); await handle.sync(); } finally { await handle.close(); }
  const after = await fs.readdir(root);
  if (after.length !== 1 || after[0] !== DESTINATION_MARKER) {
    await fs.unlink(marker);
    fail("Acceptance destination changed while it was being claimed.");
  }
  return { root, owned };
}

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

async function validateDirectBinary(binary, expectedName, label) {
  if (!path.isAbsolute(binary) || path.basename(binary) !== expectedName) fail(`Binary is not Arthur's ${label} Rust binary.`);
  const stat = await fs.lstat(binary);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o111) === 0) fail(`Binary is not Arthur's ${label} Rust binary.`);
  const handle = await fs.open(binary, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(2); await handle.read(bytes, 0, 2, 0);
    if (bytes.toString("utf8") === "#!") fail(`Binary is not Arthur's ${label} Rust binary.`);
  } finally { await handle.close(); }
  return path.resolve(binary);
}

export function validateNativeBinary(binary) {
  return validateDirectBinary(binary, "arthur-native-host", "direct");
}

export function validateAcceptanceBinary(binary) {
  return validateDirectBinary(binary, "arthur-native-acceptance-host", "acceptance-only");
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
  await inspectMediaFixtures();
  return Promise.all(FIXTURES.map(async (fixture) => ({
    ...fixture, id: randomUUID(), source: `https://fixtures.example.test/${fixture.name}`,
    bytes: await fs.readFile(path.join(ROOT, "tests/fixtures/media", fixture.name)),
  })));
}

async function assertSaved(destination, media) {
  const notes = (await fs.readdir(destination)).filter((name) => name.endsWith(".md"));
  if (notes.length !== 1 || notes[0] !== "Article.md") fail("normalized source did not replace Article.md in place");
  const note = await fs.readFile(path.join(destination, notes[0]), "utf8");
  if (!note.startsWith("---\ntitle: \"Article\"\nsource: \"https://example.test/a\"\n---\n\n") || note.includes("\r")) fail("note frontmatter or line endings are invalid");
  const attachmentNames = (await fs.readdir(path.join(destination, "attachments"))).sort();
  if (attachmentNames.length !== media.length) fail("not every fixture was installed");
  const pairs = [];
  for (const item of media) {
    const inputSha256 = sha256(item.bytes);
    const outputName = `${path.parse(item.name).name}--${inputSha256.slice(0, 12)}.${path.extname(item.name).slice(1)}`;
    if (!attachmentNames.includes(outputName)) fail(`missing exact output for ${item.name}`);
    const outputSha256 = sha256(await fs.readFile(path.join(destination, "attachments", outputName)));
    if (outputSha256 !== inputSha256) fail(`${item.name} output bytes changed`);
    if (!note.includes(`![[attachments/${outputName}]]`)) fail(`${item.name} does not use its exact lowercase attachments embed`);
    pairs.push({ name: item.name, inputSha256, output: `attachments/${outputName}`, outputSha256 });
  }
  return { note, pairs };
}

async function poisonCases(binary) {
  const hello = frame({ type: "hello", requestId: "later", protocolVersion: 1 });
  const cases = [
    { name: "zero-length", input: Buffer.concat([Buffer.alloc(4), hello]) },
    { name: "oversized", input: Buffer.concat([Buffer.from(Uint32Array.of(MAX_REQUEST + 1).buffer), hello]) },
    { name: "invalid-utf8", input: Buffer.concat([rawFrame(Buffer.from([0xc3, 0x28])), hello]) },
    { name: "invalid-json", input: Buffer.concat([rawFrame(Buffer.from('{"privateArticle":"must-not-leak"')), hello]) },
    { name: "truncated-eof", input: Buffer.from([1, 0]) },
  ];
  const evidence = [];
  for (const testCase of cases) {
    const result = run(binary, testCase.input);
    const expected = [{ type: "error", code: "invalid_native_frame", message: "The native message stream is invalid." }];
    if (result.status === 0 || JSON.stringify(result.messages) !== JSON.stringify(expected)) fail(`${testCase.name} did not emit exactly one canonical framed error`);
    if (result.stderr.toString("utf8") !== "native message stream rejected\n") fail(`${testCase.name} diagnostic was not on the strict redacted allowlist`);
    evidence.push({ case: testCase.name, framedErrors: 1, stderr: "native message stream rejected" });
  }
  const eof = run(binary, Buffer.alloc(0));
  if (eof.status !== 0 || eof.stdout.length !== 0 || eof.stderr.length !== 0 || eof.messages.length !== 0) fail("normal EOF was not completely silent");
  return { poison: evidence, normalEof: "silent" };
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

async function interruptedBeforeNoteRename(binary, destination) {
  const root = path.join(destination, "pre-note-rename");
  await fs.mkdir(root);
  const note = path.join(root, "Interrupted.md");
  const prior = Buffer.from("---\ntitle: \"Interrupted\"\nsource: \"https://example.test/interrupted\"\n---\n\nprior bytes\n");
  await fs.writeFile(note, prior);
  const beforeTree = await visibleTree(root);
  const beforeSha256 = sha256(prior);
  const sessionId = randomUUID();
  const result = run(binary, [
    { ...message("begin_save", "interrupt-begin"), sessionId, destination: root, source: "https://example.test/interrupted", title: "Interrupted", markdown: "replacement bytes" },
    { ...message("commit_save", "interrupt-commit"), sessionId },
  ]);
  const expected = [
    { type: "ack", requestId: "interrupt-begin", sessionId },
    { type: "error", requestId: "interrupt-commit", sessionId, code: "commit_failed", message: "The article could not be saved safely." },
  ];
  if (result.status !== 0 || result.stderr.length !== 0 || JSON.stringify(result.messages) !== JSON.stringify(expected)) fail("acceptance fault did not interrupt at the canonical pre-note-rename boundary");
  const after = await fs.readFile(note);
  if (!after.equals(prior)) fail("pre-note-rename interruption changed the prior note bytes");
  const markdownNames = (await fs.readdir(root)).filter((name) => name.endsWith(".md"));
  if (JSON.stringify(markdownNames) !== JSON.stringify(["Interrupted.md"])) fail("pre-note-rename interruption exposed a new note");
  return {
    fault: "CommitFault::BeforeNoteRename",
    beforeTree,
    afterTree: await visibleTree(root),
    beforeSha256,
    afterSha256: sha256(after),
  };
}

async function visibleTree(root) {
  const result = [];
  async function visit(directory, prefix = "") {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === ".arthur-workspace-v1") continue;
      const relative = path.posix.join(prefix, entry.name);
      result.push(entry.isDirectory() ? `${relative}/` : relative);
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative);
    }
  }
  await visit(root);
  return result;
}

export async function nativeRoundtrip({ binary, faultBinary, destination } = {}) {
  const directBinary = await validateNativeBinary(binary ?? path.join(ROOT, "native/target/release/arthur-native-host"));
  const acceptanceBinary = await validateAcceptanceBinary(faultBinary ?? path.join(ROOT, "native/target/acceptance/release/arthur-native-acceptance-host"));
  const ownsDestination = destination === undefined;
  const requestedRoot = destination === undefined ? await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "arthur-native-roundtrip-")) : path.resolve(destination);
  const { root } = await claimAcceptanceDestination(requestedRoot, { owned: ownsDestination });
  let completed = false;
  try {
    const beforeTree = await visibleTree(root);
    await fs.writeFile(path.join(root, "Article.md"), "---\ntitle: \"Article\"\nsource: \"HTTPS://Example.TEST:443/a#old\"\n---\n\nold\n");
    const media = await fixtureMedia();
    const first = run(directBinary, saveMessages({ destination: root, source: "https://example.test/a#new", title: "Article", markdown: media.map((item) => `arthur-media://${item.id}`).join("\n"), session: randomUUID(), media }));
    if (first.status !== 0 || first.stderr.length !== 0 || first.messages.at(-1)?.type !== "save_result") fail("fixture save did not complete through the direct binary");
    const saved = await assertSaved(root, media);
    const unrelatedBefore = await fs.readFile(path.join(root, "Article.md"));
    const collision = run(directBinary, saveMessages({ destination: root, source: "https://example.test/different", title: "Article", markdown: "unrelated", session: randomUUID() }));
    if (collision.status !== 0 || collision.messages.at(-1)?.type !== "save_result") fail("same-title different-source save failed");
    const collisionName = `Article--${sha256(Buffer.from("https://example.test/different")).slice(0, 12)}.md`;
    const markdownNames = (await fs.readdir(root)).filter((name) => name.endsWith(".md")).sort();
    if (JSON.stringify(markdownNames) !== JSON.stringify(["Article.md", collisionName].sort())) fail("same-title different-source save did not use its exact source-hash suffix");
    if (!Buffer.from(await fs.readFile(path.join(root, "Article.md"))).equals(unrelatedBefore)) fail("same-title different-source save changed the unrelated note bytes");
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
    await limits(directBinary, root); await attachmentSymlinkRace(directBinary, root);
    const framing = await poisonCases(directBinary);
    const interruption = await interruptedBeforeNoteRename(acceptanceBinary, root);
    const afterTree = await visibleTree(root);
    const result = { acceptance: "native-roundtrip", binary: directBinary, faultBinary: acceptanceBinary, destination: root, fixtures: saved.pairs, collision: { expectedPath: collisionName, unrelatedSha256Before: sha256(unrelatedBefore), unrelatedSha256After: sha256(await fs.readFile(path.join(root, "Article.md"))) }, framing, interruption, trees: { before: beforeTree, after: afterTree }, checks: ["bytes", "overwrite", "collision", "warning", "limits", "symlink-race", "poison", "silent-eof", "pre-note-rename"] };
    completed = true;
    return result;
  } finally { if (ownsDestination && completed) await fs.rm(root, { recursive: true, force: true }); }
}

function parseArguments(argv) {
  let binary; let faultBinary; let destination;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]; const value = argv[index + 1];
    if ((flag !== "--binary" && flag !== "--fault-binary" && flag !== "--destination") || !value) throw new Error("Usage: native-roundtrip.mjs [--binary path] [--fault-binary path] [--destination /absolute/path]");
    if (flag === "--binary") binary = path.resolve(value);
    else if (flag === "--fault-binary") faultBinary = path.resolve(value);
    else {
      if (!path.isAbsolute(value)) throw new Error("Usage: native-roundtrip.mjs [--binary path] [--fault-binary path] [--destination /absolute/path]");
      destination = value;
    }
  }
  return { binary, faultBinary, destination };
}

async function main() { process.stdout.write(`${JSON.stringify(await nativeRoundtrip(parseArguments(process.argv.slice(2))))}\n`); }
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => { process.stderr.write(`Arthur native roundtrip failed: ${error.message}\n`); process.exitCode = 1; });
