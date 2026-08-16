import { describe, expect, it } from "vitest";

import {
  contentAddressedFilename,
  extensionForMedia,
  sanitizeFilenameStem,
} from "./filenames.js";

describe("native filenames", () => {
  it("removes macOS separators and control characters from filename stems", () => {
    expect(sanitizeFilenameStem("cover:/\\\u0000draft\n")).toBe("coverdraft");
  });

  it("uses a safe fallback for empty and dot-only names", () => {
    expect(sanitizeFilenameStem(" . ")).toBe("attachment");
    expect(sanitizeFilenameStem("\u0000")).toBe("attachment");
  });

  it("normalizes stems to NFC and caps them at 180 UTF-8 bytes", () => {
    const stem = sanitizeFilenameStem(`Cafe\u0301${"a".repeat(200)}`);

    expect(stem.startsWith("Café")).toBe(true);
    expect(Buffer.byteLength(stem, "utf8")).toBe(180);
  });

  it("uses a recognized URL extension before a MIME fallback", () => {
    expect(extensionForMedia("photo.JPEG", "image/webp")).toBe("jpeg");
    expect(extensionForMedia("animated.webp", "image/webp")).toBe("webp");
    expect(extensionForMedia("download", "image/webp")).toBe("webp");
  });

  it("creates a filename from the stem and digest prefix", () => {
    expect(contentAddressedFilename("hero", "b7c87d380f4e99ff", "webp")).toBe(
      "hero--b7c87d380f4e.webp",
    );
  });
});
