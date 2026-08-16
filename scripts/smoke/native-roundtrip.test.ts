import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { claimAcceptanceDestination, inspectMediaFixtures, validateAcceptanceBinary, validateNativeBinary } from "./native-roundtrip.mjs";

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
