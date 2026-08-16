import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

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

function boundedSubBlocks(bytes, offset, label) {
  while (offset < bytes.length) {
    const size = bytes[offset]; offset += 1;
    if (size === 0) return offset;
    if (offset + size > bytes.length) fail(`${label} contains a truncated data block.`);
    offset += size;
  }
  fail(`${label} has no data terminator.`);
}

function inspectGif(bytes) {
  if (bytes.length < 14 || !["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) fail("animated.gif has an invalid GIF header.");
  const width = bytes.readUInt16LE(6); const height = bytes.readUInt16LE(8);
  if (width === 0 || height === 0) fail("animated.gif has invalid dimensions.");
  let offset = 13; let frames = 0; let duration = 0;
  if ((bytes[10] & 0x80) !== 0) offset += 3 * (1 << ((bytes[10] & 0x07) + 1));
  while (offset < bytes.length) {
    const marker = bytes[offset]; offset += 1;
    if (marker === 0x3b) {
      if (offset !== bytes.length || frames < 2 || duration <= 0) fail("animated.gif is not a bounded multi-frame GIF.");
      return { format: "gif", width, height, frames, duration, streams: ["image"] };
    }
    if (marker === 0x21) {
      if (offset >= bytes.length) fail("animated.gif contains a truncated extension.");
      const label = bytes[offset]; offset += 1;
      if (label === 0xf9) {
        if (offset + 6 > bytes.length || bytes[offset] !== 4 || bytes[offset + 5] !== 0) fail("animated.gif contains an invalid graphic control extension.");
        duration += bytes.readUInt16LE(offset + 2) / 100;
        offset += 6;
      } else offset = boundedSubBlocks(bytes, offset, "animated.gif");
      continue;
    }
    if (marker !== 0x2c || offset + 9 > bytes.length) fail("animated.gif contains an invalid image descriptor.");
    const packed = bytes[offset + 8]; offset += 9;
    if ((packed & 0x80) !== 0) offset += 3 * (1 << ((packed & 0x07) + 1));
    if (offset >= bytes.length || bytes[offset] > 11) fail("animated.gif contains invalid LZW image data.");
    offset = boundedSubBlocks(bytes, offset + 1, "animated.gif"); frames += 1;
  }
  fail("animated.gif has no trailer.");
}

function riffChunks(bytes, start, end, label) {
  const chunks = [];
  for (let offset = start; offset < end;) {
    if (offset + 8 > end) fail(`${label} contains a truncated chunk header.`);
    const type = bytes.subarray(offset, offset + 4).toString("ascii"); const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8; const next = body + size + (size & 1);
    if (body + size > end || next > end) fail(`${label} contains an out-of-bounds chunk.`);
    chunks.push({ type, body, end: body + size, size }); offset = next;
  }
  return chunks;
}

function readUInt24LE(bytes, offset) { return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16); }

function inspectWebp(bytes) {
  if (bytes.length < 12 || bytes.subarray(0, 4).toString("ascii") !== "RIFF" || bytes.subarray(8, 12).toString("ascii") !== "WEBP" || bytes.readUInt32LE(4) + 8 !== bytes.length) fail("animated.webp has invalid RIFF/WEBP bounds.");
  const chunks = riffChunks(bytes, 12, bytes.length, "animated.webp");
  const vp8x = chunks.find((chunk) => chunk.type === "VP8X"); const animation = chunks.find((chunk) => chunk.type === "ANIM");
  if (!vp8x || vp8x.size !== 10 || (bytes[vp8x.body] & 0x02) === 0 || !animation || animation.size < 6) fail("animated.webp is missing its animation structure.");
  const width = readUInt24LE(bytes, vp8x.body + 4) + 1; const height = readUInt24LE(bytes, vp8x.body + 7) + 1;
  const frames = chunks.filter((chunk) => chunk.type === "ANMF"); let duration = 0;
  for (const frameChunk of frames) {
    if (frameChunk.size < 24) fail("animated.webp contains a truncated ANMF chunk.");
    const frameWidth = readUInt24LE(bytes, frameChunk.body + 6) + 1; const frameHeight = readUInt24LE(bytes, frameChunk.body + 9) + 1;
    const frameDuration = readUInt24LE(bytes, frameChunk.body + 12);
    const payloads = riffChunks(bytes, frameChunk.body + 16, frameChunk.end, "animated.webp ANMF");
    if (frameWidth > width || frameHeight > height || frameDuration === 0 || !payloads.some((chunk) => chunk.type === "VP8 " || chunk.type === "VP8L")) fail("animated.webp contains an invalid animation frame.");
    duration += frameDuration / 1000;
  }
  if (frames.length < 2) fail("animated.webp does not contain multiple animation frames.");
  return { format: "webp", width, height, frames: frames.length, duration, streams: ["image"] };
}

function bmffBoxes(bytes, start = 0, end = bytes.length, label = "media") {
  const boxes = [];
  for (let offset = start; offset < end;) {
    if (offset + 8 > end) fail(`${label} contains a truncated box header.`);
    let size = bytes.readUInt32BE(offset); const type = bytes.subarray(offset + 4, offset + 8).toString("ascii"); let header = 8;
    if (size === 1) {
      if (offset + 16 > end) fail(`${label} contains a truncated extended box.`);
      const extended = bytes.readBigUInt64BE(offset + 8); if (extended > BigInt(Number.MAX_SAFE_INTEGER)) fail(`${label} box is too large.`);
      size = Number(extended); header = 16;
    } else if (size === 0) size = end - offset;
    if (size < header || offset + size > end) fail(`${label} contains an out-of-bounds box.`);
    boxes.push({ type, start: offset, body: offset + header, end: offset + size, size }); offset += size;
  }
  return boxes;
}

function descendants(bytes, boxes, containerTypes, label) {
  const result = [...boxes];
  for (const box of boxes) {
    const skip = box.type === "meta" ? 4 : box.type === "iinf" ? 6 : 0;
    if (containerTypes.has(box.type) && box.body + skip <= box.end) result.push(...descendants(bytes, bmffBoxes(bytes, box.body + skip, box.end, label), containerTypes, label));
  }
  return result;
}

function ftypBrands(bytes, box) {
  if (!box || box.size < 16 || (box.end - box.body) % 4 !== 0) return [];
  const brands = [];
  for (let offset = box.body; offset < box.end; offset += 4) if (offset !== box.body + 4) brands.push(bytes.subarray(offset, offset + 4).toString("ascii"));
  return brands;
}

function readSizedUInt(bytes, offset, size, end, label) {
  if (size > 8 || offset + size > end) fail(`${label} contains an invalid sized integer.`);
  let value = 0n;
  for (let index = 0; index < size; index += 1) value = (value << 8n) | BigInt(bytes[offset + index]);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail(`${label} sized integer is too large.`);
  return { value: Number(value), offset: offset + size };
}

function ilocExtents(bytes, box) {
  const label = "photo.avif iloc"; if (!box || box.end - box.body < 8) fail(`${label} is truncated.`);
  const version = bytes[box.body]; if (version > 2) fail(`${label} has an unsupported version.`);
  const offsetSize = bytes[box.body + 4] >>> 4; const lengthSize = bytes[box.body + 4] & 0x0f; const baseOffsetSize = bytes[box.body + 5] >>> 4; const indexSize = version === 1 || version === 2 ? bytes[box.body + 5] & 0x0f : 0;
  let offset = box.body + 6; const countBytes = version < 2 ? 2 : 4; let read = readSizedUInt(bytes, offset, countBytes, box.end, label); const itemCount = read.value; offset = read.offset;
  const extents = [];
  for (let item = 0; item < itemCount; item += 1) {
    read = readSizedUInt(bytes, offset, version < 2 ? 2 : 4, box.end, label); offset = read.offset;
    if (version === 1 || version === 2) { read = readSizedUInt(bytes, offset, 2, box.end, label); offset = read.offset; }
    read = readSizedUInt(bytes, offset, 2, box.end, label); offset = read.offset;
    read = readSizedUInt(bytes, offset, baseOffsetSize, box.end, label); const baseOffset = read.value; offset = read.offset;
    read = readSizedUInt(bytes, offset, 2, box.end, label); const extentCount = read.value; offset = read.offset;
    for (let extent = 0; extent < extentCount; extent += 1) {
      if (indexSize !== 0) { read = readSizedUInt(bytes, offset, indexSize, box.end, label); offset = read.offset; }
      read = readSizedUInt(bytes, offset, offsetSize, box.end, label); const extentOffset = read.value; offset = read.offset;
      read = readSizedUInt(bytes, offset, lengthSize, box.end, label); const extentLength = read.value; offset = read.offset;
      extents.push({ offset: baseOffset + extentOffset, length: extentLength });
    }
  }
  if (offset !== box.end) fail(`${label} has trailing bytes.`);
  return extents;
}

function inspectAvif(bytes) {
  const top = bmffBoxes(bytes, 0, bytes.length, "photo.avif"); const ftyp = top.find((box) => box.type === "ftyp");
  const brands = ftypBrands(bytes, ftyp); if (!brands.some((brand) => brand === "avif" || brand === "avis")) fail("photo.avif has no AVIF compatible brand.");
  const meta = top.find((box) => box.type === "meta"); const mdat = top.find((box) => box.type === "mdat");
  if (!meta || !mdat || mdat.end <= mdat.body) fail("photo.avif has no coded image payload.");
  const boxes = descendants(bytes, [meta], new Set(["meta", "iprp", "ipco", "iinf"]), "photo.avif");
  const ispe = boxes.find((box) => box.type === "ispe");
  const codedItem = boxes.some((box) => box.type === "infe" && bytes.subarray(box.body, box.end).includes(Buffer.from("av01"))); const iloc = boxes.find((box) => box.type === "iloc");
  const codedExtent = ilocExtents(bytes, iloc).some((extent) => extent.length > 0 && extent.offset >= mdat.body && extent.offset + extent.length <= mdat.end);
  if (!codedItem || !codedExtent || !boxes.some((box) => box.type === "av1C") || !ispe || ispe.end - ispe.body < 12) fail("photo.avif has no bounded AV1 coded item evidence.");
  const width = bytes.readUInt32BE(ispe.body + 4); const height = bytes.readUInt32BE(ispe.body + 8);
  if (width === 0 || height === 0) fail("photo.avif has invalid dimensions.");
  return { format: "avif", width, height, frames: 1, streams: ["image"] };
}

const MPEG_BITRATES = {
  "1-1": [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  "1-2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  "1-3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  "2-1": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  "2-2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  "2-3": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

function mpegFrame(bytes, offset) {
  if (offset + 4 > bytes.length) return undefined;
  const header = bytes.readUInt32BE(offset); if (((header >>> 21) & 0x7ff) !== 0x7ff) return undefined;
  const versionBits = (header >>> 19) & 3; const layerBits = (header >>> 17) & 3; const bitrateIndex = (header >>> 12) & 15; const rateIndex = (header >>> 10) & 3;
  if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return undefined;
  const version = versionBits === 3 ? 1 : 2; const layer = 4 - layerBits;
  const baseRate = [44100, 48000, 32000][rateIndex]; const sampleRate = versionBits === 3 ? baseRate : versionBits === 2 ? baseRate / 2 : baseRate / 4;
  const bitrate = MPEG_BITRATES[`${version}-${layer}`]?.[bitrateIndex]; if (!bitrate) return undefined;
  const padding = (header >>> 9) & 1;
  const length = layer === 1 ? Math.floor((12 * bitrate * 1000) / sampleRate + padding) * 4 : Math.floor(((layer === 3 && version !== 1 ? 72 : 144) * bitrate * 1000) / sampleRate + padding);
  const samples = layer === 1 ? 384 : layer === 3 && version !== 1 ? 576 : 1152;
  if (length < 4 || offset + length > bytes.length) return undefined;
  return { length, sampleRate, samples };
}

function inspectMp3(bytes) {
  let offset = 0;
  if (bytes.subarray(0, 3).toString("ascii") === "ID3") {
    if (bytes.length < 10 || [...bytes.subarray(6, 10)].some((byte) => byte > 0x7f)) fail("audio.mp3 has an invalid ID3 size.");
    offset = 10 + ((bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9]) + ((bytes[5] & 0x10) !== 0 ? 10 : 0);
    if (offset > bytes.length) fail("audio.mp3 has an out-of-bounds ID3 tag.");
  }
  let frames = 0; let duration = 0;
  while (offset < bytes.length) {
    const frameInfo = mpegFrame(bytes, offset); if (!frameInfo) break;
    frames += 1; duration += frameInfo.samples / frameInfo.sampleRate; offset += frameInfo.length;
  }
  if (frames < 2 || duration <= 0) fail("audio.mp3 has no consecutive MPEG audio frames.");
  return { format: "mp3", frames, duration, streams: ["audio"] };
}

function inspectMp4(bytes) {
  const top = bmffBoxes(bytes, 0, bytes.length, "video.mp4"); const ftyp = top.find((box) => box.type === "ftyp"); const moov = top.find((box) => box.type === "moov"); const mdat = top.find((box) => box.type === "mdat");
  if (!ftyp || ftypBrands(bytes, ftyp).length === 0 || !moov || !mdat || mdat.end <= mdat.body) fail("video.mp4 is missing bounded media boxes.");
  const moovChildren = bmffBoxes(bytes, moov.body, moov.end, "video.mp4 moov"); const trak = moovChildren.find((box) => box.type === "trak"); const movie = moovChildren.find((box) => box.type === "mvhd" && box.end - box.body >= 20);
  if (!trak) fail("video.mp4 has no bounded trak box.");
  const trakChildren = bmffBoxes(bytes, trak.body, trak.end, "video.mp4 trak"); const mdia = trakChildren.find((box) => box.type === "mdia"); const track = trakChildren.find((box) => box.type === "tkhd" && box.end - box.body >= 8);
  if (!mdia) fail("video.mp4 has no bounded mdia box.");
  const mediaChildren = bmffBoxes(bytes, mdia.body, mdia.end, "video.mp4 mdia");
  const videoHandler = mediaChildren.find((box) => box.type === "hdlr" && box.end - box.body >= 12 && bytes.subarray(box.body + 8, box.body + 12).toString("ascii") === "vide");
  const minf = mediaChildren.find((box) => box.type === "minf"); if (!minf) fail("video.mp4 has no bounded video media information.");
  const stbl = bmffBoxes(bytes, minf.body, minf.end, "video.mp4 minf").find((box) => box.type === "stbl"); if (!stbl) fail("video.mp4 has no bounded sample table.");
  const sampleSize = bmffBoxes(bytes, stbl.body, stbl.end, "video.mp4 stbl").find((box) => box.type === "stsz" && box.end - box.body >= 12);
  const frames = sampleSize ? bytes.readUInt32BE(sampleSize.body + 8) : 0;
  if (!videoHandler || frames === 0 || !track || !movie) fail("video.mp4 has no video track with nonempty sample evidence.");
  const width = bytes.readUInt32BE(track.end - 8) / 65536; const height = bytes.readUInt32BE(track.end - 4) / 65536;
  const timescale = bytes.readUInt32BE(movie.body + 12); const duration = timescale === 0 ? 0 : bytes.readUInt32BE(movie.body + 16) / timescale;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || duration <= 0) fail("video.mp4 has invalid dimensions or duration.");
  return { format: "mp4", width, height, frames, duration, streams: ["video"] };
}

function inspectSvg(bytes) {
  if (bytes.length === 0 || bytes.length > 1024 * 1024 || bytes.includes(0)) fail("diagram.svg exceeds its bounded XML representation.");
  let svg; try { svg = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim(); } catch { fail("diagram.svg is not UTF-8 XML."); }
  if (/<!DOCTYPE|<!ENTITY/iu.test(svg)) fail("diagram.svg contains unsupported XML declarations.");
  const root = /^(?:<\?xml\s[^?]*\?>\s*)?<svg\b([^>]*)>[\s\S]*<\/svg>$/u.exec(svg); if (!root) fail("diagram.svg has no bounded SVG root.");
  const width = Number(/\bwidth="(\d+)"/u.exec(root[1])?.[1]); const height = Number(/\bheight="(\d+)"/u.exec(root[1])?.[1]);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) fail("diagram.svg has invalid dimensions.");
  return { format: "svg", width, height, frames: 1, streams: ["image"] };
}

export function inspectMediaBytes(fixtures) {
  for (const fixture of FIXTURES) {
    if (!Buffer.isBuffer(fixtures[fixture.name])) fail(`Missing committed fixture ${fixture.name}.`);
    if (fixtures[fixture.name].length > 16 * 1024 * 1024) fail(`Committed fixture ${fixture.name} exceeds its inspection bound.`);
  }
  return {
    "animated.gif": inspectGif(fixtures["animated.gif"]),
    "animated.webp": inspectWebp(fixtures["animated.webp"]),
    "diagram.svg": inspectSvg(fixtures["diagram.svg"]),
    "photo.avif": inspectAvif(fixtures["photo.avif"]),
    "audio.mp3": inspectMp3(fixtures["audio.mp3"]),
    "video.mp4": inspectMp4(fixtures["video.mp4"]),
  };
}

export async function inspectMediaFixtures() {
  const fixtures = Object.fromEntries(await Promise.all(FIXTURES.map(async ({ name }) => [name, await fs.readFile(path.join(ROOT, "tests/fixtures/media", name))])));
  return inspectMediaBytes(fixtures);
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

function buildAcceptanceBinary() {
  const target = path.join(ROOT, "native/target/acceptance");
  const result = spawnSync(process.execPath, [
    path.join(ROOT, "scripts/rust-toolchain.mjs"),
    "build", "--manifest-path", path.join(ROOT, "native/Cargo.toml"), "--release", "--locked",
    "--features", "acceptance-faults", "--bin", "arthur-native-acceptance-host", "--target-dir", target,
  ], { cwd: ROOT, encoding: "utf8" });
  if (result.error || result.status !== 0 || result.stdout !== "") fail("Arthur's acceptance-only Rust binary could not be built in its separate target directory.");
  return path.join(target, "release/arthur-native-acceptance-host");
}

function run(binary, messagesOrBytes) {
  const input = Buffer.isBuffer(messagesOrBytes) ? messagesOrBytes : Buffer.concat(messagesOrBytes.map(frame));
  const result = spawnSync(binary, [], { input, encoding: null, env: { PATH: "/usr/bin:/bin" }, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? Buffer.alloc(0), stderr: result.stderr ?? Buffer.alloc(0), messages: decodeFrames(result.stdout ?? Buffer.alloc(0)) };
}

export function validateTranscript(result, expected, label, { status = 0, stderr = "" } = {}) {
  if (result.status !== status) fail(`${label} child status was not exactly ${status}.`);
  if (result.stderr.toString("utf8") !== stderr) fail(`${label} diagnostic output was not the exact redacted allowlist.`);
  if (!isDeepStrictEqual(result.messages, expected)) {
    const signature = (messages) => messages.map((item) => `${item?.type ?? "unknown"}:${item?.requestId ?? "none"}:${item?.code ?? "none"}`).join(",");
    let mismatch = "unknown";
    for (let index = 0; index < Math.max(expected.length, result.messages.length); index += 1) {
      const expectedKeys = Object.keys(expected[index] ?? {}).sort(); const actualKeys = Object.keys(result.messages[index] ?? {}).sort();
      const key = [...new Set([...expectedKeys, ...actualKeys])].find((field) => !isDeepStrictEqual(expected[index]?.[field], result.messages[index]?.[field]));
      if (key) { mismatch = `${index}.${key}`; break; }
    }
    fail(`${label} framed transcript had extra, missing, or reordered messages at ${mismatch} (expected ${signature(expected)}; received ${signature(result.messages)}).`);
  }
}

function message(type, requestId) { return { type, requestId }; }

function helloResult() { return { type: "hello_result", requestId: "hello", protocolVersion: 1, hostName: "Arthur native host", hostVersion: "0.1.0" }; }
function ack(requestId, sessionId, mediaId, sequence) {
  return { type: "ack", requestId, ...(sessionId === undefined ? {} : { sessionId }), ...(mediaId === undefined ? {} : { mediaId }), ...(sequence === undefined ? {} : { sequence }) };
}
function saveResult(requestId, sessionId, savedPath) { return { type: "save_result", requestId, sessionId, savedPath }; }
function typedError(requestId, sessionId, code, messageText) { return { type: "error", ...(requestId === undefined ? {} : { requestId }), ...(sessionId === undefined ? {} : { sessionId }), code, message: messageText }; }

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

function successfulSaveTranscript(sessionId, media, savedPath) {
  const transcript = [helloResult(), ack("begin", sessionId)];
  for (const item of media) transcript.push(ack(`begin-${item.id}`, sessionId), ack("chunk", sessionId, item.id, 0), ack(`end-${item.id}`, sessionId, item.id));
  transcript.push(saveResult("commit", sessionId, savedPath));
  return transcript;
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
    validateTranscript(result, expected, testCase.name, { status: 1, stderr: "native message stream rejected\n" });
    evidence.push({ case: testCase.name, framedErrors: 1, stderr: "native message stream rejected" });
  }
  const eof = run(binary, Buffer.alloc(0));
  validateTranscript(eof, [], "normal EOF");
  if (eof.stdout.length !== 0) fail("normal EOF was not completely silent");
  return { poison: evidence, normalEof: "silent" };
}

function liveHost(binary) {
  const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" } });
  let buffered = Buffer.alloc(0); let stderr = Buffer.alloc(0); const waiters = []; const extras = [];
  function pump() {
    while (buffered.length >= 4) {
      const length = buffered.readUInt32LE(0);
      if (length === 0 || buffered.length < length + 4) return;
      const value = JSON.parse(buffered.subarray(4, length + 4).toString("utf8"));
      buffered = buffered.subarray(length + 4);
      const waiter = waiters.shift(); if (waiter) waiter.resolve(value); else extras.push(value);
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
      if (stderr.length !== 0 || buffered.length !== 0 || extras.length !== 0 || waiters.length !== 0) fail("race host emitted extra, truncated, missing, or diagnostic output");
    },
  };
}

function exactMessage(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) fail(`${label} response was not the exact expected typed message.`);
}

async function attachmentSymlinkRace(binary, destination) {
  const race = path.join(destination, "attachment-race"); const outside = path.join(destination, "outside");
  await fs.mkdir(race); await fs.mkdir(outside);
  const session = randomUUID(); const mediaId = randomUUID(); const host = liveHost(binary);
  try {
    const begin = await host.send({ ...message("begin_save", "race-begin"), sessionId: session, destination: race, source: "https://example.test/race", title: "Race", markdown: `arthur-media://${mediaId}` });
    exactMessage(begin, ack("race-begin", session), "race begin");
    await fs.rmdir(path.join(race, "attachments")); await fs.symlink(outside, path.join(race, "attachments"));
    const media = await host.send({ ...message("begin_media", "race-media"), sessionId: session, mediaId, source: "https://fixtures.example.test/race.gif", kind: "image", contentType: "image/gif", byteLength: 1 });
    exactMessage(media, ack("race-media", session), "race media begin");
    exactMessage(await host.send({ type: "media_chunk", sessionId: session, mediaId, sequence: 0, data: "eA==" }), ack("chunk", session, mediaId, 0), "race chunk");
    exactMessage(await host.send({ ...message("end_media", "race-end"), sessionId: session, mediaId, chunks: 1 }), ack("race-end", session, mediaId), "race media end");
    const commit = await host.send({ ...message("commit_save", "race-commit"), sessionId: session });
    exactMessage(commit, typedError("race-commit", session, "unsafe_child", "The destination contains an unsafe child entry."), "race commit");
    if ((await fs.readdir(outside)).length !== 0) fail("attachment symlink race redirected a write outside the destination");
  } finally {
    await host.close();
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
  validateTranscript(individual, [
    ack("begin-limit", individualSession),
    typedError(undefined, undefined, "invalid_message", "The native message is invalid."),
  ], "individual media limit");
  if (!Buffer.from(await fs.readFile(note)).equals(prior)) fail("individual limit exposed a partial note");
  const session = randomUUID(); const ids = [randomUUID(), randomUUID(), randomUUID()];
  const total = run(binary, [
    { ...message("begin_save", "begin-total"), sessionId: session, destination, source: "https://example.test/limit", title: "Limit", markdown: "new" },
    ...ids.map((mediaId, index) => ({ ...message("begin_media", `total-${index}`), sessionId: session, mediaId, source: `https://fixtures.example.test/${index}.mp4`, kind: "video", contentType: "video/mp4", byteLength: AV_LIMIT })),
  ]);
  validateTranscript(total, [
    ack("begin-total", session),
    ack("total-0", session),
    ack("total-1", session),
    typedError("total-2", session, "media_limit_exceeded", "The media exceeds the configured size limit."),
  ], "total media limit");
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
  validateTranscript(result, expected, "acceptance pre-note-rename fault");
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
  const acceptanceBinary = await validateAcceptanceBinary(faultBinary ?? buildAcceptanceBinary());
  const ownsDestination = destination === undefined;
  const requestedRoot = destination === undefined ? await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "arthur-native-roundtrip-")) : path.resolve(destination);
  const { root } = await claimAcceptanceDestination(requestedRoot, { owned: ownsDestination });
  const canonicalRoot = await fs.realpath(root);
  let completed = false;
  try {
    const beforeTree = await visibleTree(root);
    await fs.writeFile(path.join(root, "Article.md"), "---\ntitle: \"Article\"\nsource: \"HTTPS://Example.TEST:443/a#old\"\n---\n\nold\n");
    const media = await fixtureMedia();
    const fixtureSession = randomUUID();
    const first = run(directBinary, saveMessages({ destination: root, source: "https://example.test/a#new", title: "Article", markdown: media.map((item) => `arthur-media://${item.id}`).join("\n"), session: fixtureSession, media }));
    validateTranscript(first, successfulSaveTranscript(fixtureSession, media, path.join(canonicalRoot, "Article.md")), "fixture save");
    const saved = await assertSaved(root, media);
    const unrelatedBefore = await fs.readFile(path.join(root, "Article.md"));
    const collisionName = `Article--${sha256(Buffer.from("https://example.test/different")).slice(0, 12)}.md`;
    const collisionSession = randomUUID();
    const collision = run(directBinary, saveMessages({ destination: root, source: "https://example.test/different", title: "Article", markdown: "unrelated", session: collisionSession }));
    validateTranscript(collision, successfulSaveTranscript(collisionSession, [], path.join(canonicalRoot, collisionName)), "same-title collision save");
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
    validateTranscript(warning, [
      ack("warning-begin", warningSession),
      ack("warning-media", warningSession),
      ack("chunk", warningSession, warningId, 0),
      { type: "warning", requestId: "warning-end", sessionId: warningSession, code: "media_fallback", message: "Media transfer was incomplete; original link was retained." },
      saveResult("warning-commit", warningSession, path.join(canonicalRoot, "Warning.md")),
    ], "warning fallback save");
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
