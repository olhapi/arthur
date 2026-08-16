import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { claimAcceptanceDestination, inspectMediaBytes, inspectMediaFixtures, validateAcceptanceBinary, validateNativeBinary, validateTranscript } from "./native-roundtrip.mjs";

const FIXTURE_NAMES = ["animated.gif", "animated.webp", "diagram.svg", "photo.avif", "audio.mp3", "video.mp4"] as const;

async function fixtureBytes(): Promise<Record<string, Buffer>> {
  return Object.fromEntries(await Promise.all(FIXTURE_NAMES.map(async (name) => [name, await readFile(path.join(process.cwd(), "tests/fixtures/media", name))])));
}

function copyFixtures(fixtures: Record<string, Buffer>): Record<string, Buffer> {
  return Object.fromEntries(Object.entries(fixtures).map(([name, bytes]) => [name, Buffer.from(bytes)]));
}

function box(type: string, payload: Buffer): Buffer {
  const result = Buffer.alloc(8 + payload.length);
  result.writeUInt32BE(result.length, 0);
  result.write(type, 4, 4, "ascii");
  payload.copy(result, 8);
  return result;
}

function gifImageDataOffsets(bytes: Buffer): { descriptor: number; lzw: number } {
  const descriptor = bytes.indexOf(0x2c, 13);
  if (descriptor < 0) throw new Error("fixture has no GIF image descriptor");
  const packed = bytes[descriptor + 9]!;
  const paletteBytes = (packed & 0x80) === 0 ? 0 : 3 * (1 << ((packed & 0x07) + 1));
  return { descriptor, lzw: descriptor + 10 + paletteBytes };
}

function replaceFixture(fixtures: Record<string, Buffer>, name: string, bytes: Buffer): Record<string, Buffer> {
  return { ...copyFixtures(fixtures), [name]: bytes };
}

describe("native-roundtrip", () => {
  it("rejects a non-native executable path", async () => {
    await expect(validateNativeBinary(process.execPath)).rejects.toThrow("not Arthur's direct Rust binary");
    await expect(validateAcceptanceBinary(process.execPath)).rejects.toThrow("not Arthur's acceptance-only Rust binary");
  });

  it("validates real decodable animated image, image, audio, and video fixtures", async () => {
    await expect(inspectMediaFixtures()).resolves.toMatchObject({
      "animated.gif": { format: "gif", frames: 2 },
      "animated.webp": { format: "webp", frames: 2 },
      "diagram.svg": { format: "svg", width: 2, height: 2 },
      "photo.avif": { format: "avif", width: 16, height: 16 },
      "audio.mp3": { format: "mp3", streams: ["audio"] },
      "video.mp4": { format: "mp4", streams: ["video"] },
    });
  });

  it("validates fixtures without external probes under the native minimal PATH", () => {
    const moduleUrl = pathToFileURL(path.join(process.cwd(), "scripts/smoke/native-roundtrip.mjs")).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `import { inspectMediaFixtures } from ${JSON.stringify(moduleUrl)}; await inspectMediaFixtures();`], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe("");
    expect(child.stderr).toBe("");
  });

  it("rejects corruption of every required media structure", async () => {
    const originals = await fixtureBytes();
    expect(inspectMediaBytes(originals)).toMatchObject({ "animated.gif": { frames: 2 }, "animated.webp": { frames: 2 } });
    const textOffset = (bytes: Buffer, text: string) => {
      const offset = bytes.indexOf(Buffer.from(text));
      if (offset < 0) throw new Error(`fixture does not contain ${text}`);
      return offset;
    };
    const eraseText = (text: string) => (bytes: Buffer) => bytes.fill(0, textOffset(bytes, text), textOffset(bytes, text) + text.length);
    const corruptions: Array<{ fixture: string; structure: string; corrupt: (bytes: Buffer) => void }> = [
      { fixture: "animated.gif", structure: "header", corrupt: eraseText("GIF89a") },
      { fixture: "animated.gif", structure: "image descriptors", corrupt: (bytes) => bytes.fill(0, bytes.indexOf(0x2c, 13)) },
      { fixture: "animated.webp", structure: "RIFF bounds", corrupt: (bytes) => bytes.writeUInt32LE(0, 4) },
      { fixture: "animated.webp", structure: "VP8X animation flag", corrupt: (bytes) => { bytes[20] = bytes[20]! & ~0x02; } },
      { fixture: "animated.webp", structure: "ANIM", corrupt: eraseText("ANIM") },
      { fixture: "animated.webp", structure: "ANMF frames", corrupt: eraseText("ANMF") },
      { fixture: "diagram.svg", structure: "SVG root", corrupt: eraseText("<svg") },
      { fixture: "diagram.svg", structure: "SVG dimensions", corrupt: eraseText("width=\"2\"") },
      { fixture: "photo.avif", structure: "AVIF brands", corrupt: (bytes) => { for (let offset = bytes.indexOf(Buffer.from("avif")); offset >= 0; offset = bytes.indexOf(Buffer.from("avif"), offset + 1)) bytes.fill(0, offset, offset + 4); } },
      { fixture: "photo.avif", structure: "BMFF bounds", corrupt: (bytes) => bytes.writeUInt32BE(bytes.length, textOffset(bytes, "meta") - 4) },
      { fixture: "photo.avif", structure: "coded AV1 item", corrupt: eraseText("av01") },
      { fixture: "photo.avif", structure: "coded item extent", corrupt: (bytes) => { const type = textOffset(bytes, "iloc"); const end = type - 4 + bytes.readUInt32BE(type - 4); bytes.fill(0, end - 4, end); } },
      { fixture: "photo.avif", structure: "image dimensions", corrupt: (bytes) => bytes.fill(0, textOffset(bytes, "ispe") + 8, textOffset(bytes, "ispe") + 16) },
      { fixture: "photo.avif", structure: "coded payload", corrupt: eraseText("mdat") },
      { fixture: "audio.mp3", structure: "ID3 bounds", corrupt: (bytes) => { bytes[6] = 0xff; } },
      { fixture: "audio.mp3", structure: "consecutive MPEG frames", corrupt: (bytes) => bytes.fill(0, 45) },
      { fixture: "video.mp4", structure: "ftyp", corrupt: eraseText("ftyp") },
      { fixture: "video.mp4", structure: "moov", corrupt: eraseText("moov") },
      { fixture: "video.mp4", structure: "trak", corrupt: eraseText("trak") },
      { fixture: "video.mp4", structure: "mdia", corrupt: eraseText("mdia") },
      { fixture: "video.mp4", structure: "video handler", corrupt: eraseText("vide") },
      { fixture: "video.mp4", structure: "sample evidence", corrupt: (bytes) => bytes.fill(0, textOffset(bytes, "stsz") + 12, textOffset(bytes, "stsz") + 16) },
      { fixture: "video.mp4", structure: "mdat payload", corrupt: eraseText("mdat") },
    ];
    for (const { fixture, structure, corrupt } of corruptions) {
      const candidate: Record<string, Buffer> = Object.fromEntries(Object.entries(originals).map(([entry, bytes]) => [entry, Buffer.from(bytes)]));
      corrupt(candidate[fixture]!);
      expect(() => inspectMediaBytes(candidate), `${fixture} ${structure}`).toThrow();
    }
  });

  it("rejects invalid GIF geometry, illegal LZW code sizes, and unterminated image data", async () => {
    const originals = await fixtureBytes();
    const mutations: Array<{ name: string; mutate: (bytes: Buffer) => Buffer }> = [
      { name: "zero logical width", mutate: (bytes) => { bytes.writeUInt16LE(0, 6); return bytes; } },
      { name: "zero logical height", mutate: (bytes) => { bytes.writeUInt16LE(0, 8); return bytes; } },
      { name: "zero frame width", mutate: (bytes) => { const { descriptor } = gifImageDataOffsets(bytes); bytes.writeUInt16LE(0, descriptor + 5); return bytes; } },
      { name: "zero frame height", mutate: (bytes) => { const { descriptor } = gifImageDataOffsets(bytes); bytes.writeUInt16LE(0, descriptor + 7); return bytes; } },
      { name: "frame outside logical width", mutate: (bytes) => { const { descriptor } = gifImageDataOffsets(bytes); bytes.writeUInt16LE(bytes.readUInt16LE(6), descriptor + 1); return bytes; } },
      { name: "frame outside logical height", mutate: (bytes) => { const { descriptor } = gifImageDataOffsets(bytes); bytes.writeUInt16LE(bytes.readUInt16LE(8), descriptor + 3); return bytes; } },
      { name: "LZW minimum code size below 2", mutate: (bytes) => { const { lzw } = gifImageDataOffsets(bytes); bytes[lzw] = 1; return bytes; } },
      { name: "LZW minimum code size above 8", mutate: (bytes) => { const { lzw } = gifImageDataOffsets(bytes); bytes[lzw] = 9; return bytes; } },
      { name: "unterminated image sub-blocks", mutate: (bytes) => bytes.subarray(0, bytes.length - 2) },
    ];
    for (const mutation of mutations) {
      const gif = mutation.mutate(Buffer.from(originals["animated.gif"]!));
      expect(() => inspectMediaBytes(replaceFixture(originals, "animated.gif", gif)), mutation.name).toThrow(/animated\.gif/i);
    }
  });

  it("requires MP3 frames to consume the exact file without truncation or trailing garbage", async () => {
    const originals = await fixtureBytes();
    const mp3 = originals["audio.mp3"]!;
    expect(() => inspectMediaBytes(replaceFixture(originals, "audio.mp3", Buffer.concat([mp3, Buffer.from("garbage")])))).toThrow(/audio\.mp3/i);
    expect(() => inspectMediaBytes(replaceFixture(originals, "audio.mp3", mp3.subarray(0, mp3.length - 1)))).toThrow(/audio\.mp3/i);
  });

  it("rejects malformed, unbounded, or media-inconsistent MP4 sample tables", async () => {
    const originals = await fixtureBytes();
    const source = originals["video.mp4"]!;
    const type = source.indexOf(Buffer.from("stsz"));
    expect(type).toBeGreaterThan(3);
    const body = type + 4;
    const mutations: Array<{ name: string; mutate: (bytes: Buffer) => void }> = [
      { name: "nonzero stsz version", mutate: (bytes) => { bytes[body] = 1; } },
      { name: "nonzero stsz flags", mutate: (bytes) => { bytes[body + 3] = 1; } },
      { name: "sentinel sample count", mutate: (bytes) => bytes.writeUInt32BE(0xffffffff, body + 8) },
      { name: "sample count above cap", mutate: (bytes) => bytes.writeUInt32BE(1_000_001, body + 8) },
      { name: "truncated per-sample table", mutate: (bytes) => bytes.writeUInt32BE(12, type - 4) },
      { name: "sample bytes exceed mdat", mutate: (bytes) => { bytes.writeUInt32BE(1_000, body + 4); bytes.writeUInt32BE(2, body + 8); bytes.writeUInt32BE(20, type - 4); bytes.writeUInt32BE(8, body + 12); bytes.write("free", body + 16, 4, "ascii"); } },
    ];
    for (const mutation of mutations) {
      const mp4 = Buffer.from(source); mutation.mutate(mp4);
      expect(() => inspectMediaBytes(replaceFixture(originals, "video.mp4", mp4)), mutation.name).toThrow(/video\.mp4/i);
    }
  });

  it("bounds AVIF iloc item, extent, sized-integer, and zero-progress work", async () => {
    const originals = await fixtureBytes();
    const source = originals["photo.avif"]!;
    const type = source.indexOf(Buffer.from("iloc"));
    expect(type).toBeGreaterThan(3);
    const body = type + 4;
    const mutations: Array<{ name: string; mutate: (bytes: Buffer) => void }> = [
      { name: "item count cap", mutate: (bytes) => bytes.writeUInt16BE(0xffff, body + 6) },
      { name: "extent count cap", mutate: (bytes) => bytes.writeUInt16BE(0xffff, body + 12) },
      { name: "zero-width extent fields", mutate: (bytes) => { bytes[body + 4] = 0; } },
      { name: "invalid 15-byte extent field", mutate: (bytes) => { bytes[body + 4] = 0xf4; } },
      { name: "reserved version-zero index size", mutate: (bytes) => { bytes[body + 5] = 4; } },
    ];
    for (const mutation of mutations) {
      const avif = Buffer.from(source); mutation.mutate(avif);
      expect(() => inspectMediaBytes(replaceFixture(originals, "photo.avif", avif)), mutation.name).toThrow(/photo\.avif iloc/i);
    }
  });

  it("rejects deeply nested and excessive BMFF boxes with explicit budgets and no RangeError", async () => {
    const originals = await fixtureBytes();
    const ftyp = box("ftyp", Buffer.from("avif\0\0\0\0avif", "binary"));
    const mdat = box("mdat", Buffer.from([1]));
    let nested = box("free", Buffer.alloc(0));
    for (let index = 0; index < 12_000; index += 1) nested = box("iprp", nested);
    const deeplyNested = Buffer.concat([ftyp, box("meta", Buffer.concat([Buffer.alloc(4), nested])), mdat]);
    try {
      inspectMediaBytes(replaceFixture(originals, "photo.avif", deeplyNested));
      throw new Error("deep nesting unexpectedly passed");
    } catch (error) {
      expect(error).not.toBeInstanceOf(RangeError);
      expect(String(error)).toMatch(/photo\.avif.*(?:depth|budget)/i);
    }

    const excessive = Buffer.concat(Array.from({ length: 5_000 }, () => box("iprp", Buffer.alloc(0))));
    const tooManyBoxes = Buffer.concat([ftyp, box("meta", Buffer.concat([Buffer.alloc(4), excessive])), mdat]);
    expect(() => inspectMediaBytes(replaceFixture(originals, "photo.avif", tooManyBoxes))).toThrow(/photo\.avif.*box budget/i);
  });

  it("rejects extra, reordered, failed, or diagnostic-leaking transcripts", () => {
    const expected = [{ type: "ack", requestId: "one" }, { type: "save_result", requestId: "two" }];
    expect(() => validateTranscript({ status: 0, stderr: Buffer.alloc(0), messages: expected }, expected, "test")).not.toThrow();
    expect(() => validateTranscript({ status: 0, stderr: Buffer.alloc(0), messages: [...expected, { type: "ack", requestId: "extra" }] }, expected, "test")).toThrow(/transcript/i);
    expect(() => validateTranscript({ status: 0, stderr: Buffer.alloc(0), messages: [...expected].reverse() }, expected, "test")).toThrow(/transcript/i);
    expect(() => validateTranscript({ status: 1, stderr: Buffer.alloc(0), messages: expected }, expected, "test")).toThrow(/status/i);
    expect(() => validateTranscript({ status: 0, stderr: Buffer.from("secret article"), messages: expected }, expected, "test")).toThrow(/diagnostic/i);
  });

  it("keeps the documented acceptance package command exact", async () => {
    const packageJson = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8"));
    expect(packageJson.scripts["acceptance:native"]).toBe("node scripts/smoke/native-roundtrip.mjs --binary native/target/release/arthur-native-host");
  });

  it("refuses a nonempty explicit destination without changing it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "arthur-real-vault-"));
    const note = path.join(root, "real-note.md");
    await writeFile(note, "preserve me");
    await expect(claimAcceptanceDestination(root)).rejects.toThrow(/empty|dedicated/i);
    await expect(readFile(note, "utf8")).resolves.toBe("preserve me");
  });

  it("claims only an existing empty dedicated destination", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "arthur-dedicated-"));
    await expect(claimAcceptanceDestination(root)).resolves.toMatchObject({ root, owned: false });
    await expect(readFile(path.join(root, ".arthur-native-roundtrip-v1"), "utf8")).resolves.toBe("Arthur native roundtrip acceptance\n");
    const missing = path.join(root, "missing");
    await expect(claimAcceptanceDestination(missing)).rejects.toThrow(/existing/i);
    await mkdir(missing);
  });
});
