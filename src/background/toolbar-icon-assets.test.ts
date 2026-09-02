import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

const TOOLBAR_ICONS = ["arthur", "arthur-ready", "arthur-saving", "arthur-saved", "arthur-attention"];

function alphaMetrics(png: Buffer): {
  width: number;
  height: number;
  visibleWidth: number;
  visibleHeight: number;
  edgeAlpha: number[];
} {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }

  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const encoded = inflateSync(Buffer.concat(chunks));
  const pixels = Buffer.alloc(stride * height);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = encoded[sourceOffset++];
    for (let x = 0; x < stride; x += 1) {
      const raw = encoded[sourceOffset++];
      const left = x >= bytesPerPixel ? pixels[y * stride + x - bytesPerPixel] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= bytesPerPixel ? pixels[(y - 1) * stride + x - bytesPerPixel] : 0;
      const paethBase = left + up - upLeft;
      const paeth =
        Math.abs(paethBase - left) <= Math.abs(paethBase - up) && Math.abs(paethBase - left) <= Math.abs(paethBase - upLeft)
          ? left
          : Math.abs(paethBase - up) <= Math.abs(paethBase - upLeft)
            ? up
            : upLeft;
      const predictor = [0, left, up, Math.floor((left + up) / 2), paeth][filter];
      if (predictor === undefined) throw new Error(`Unsupported PNG filter ${filter}`);
      pixels[y * stride + x] = (raw + predictor) & 0xff;
    }
  }

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (pixels[y * stride + x * bytesPerPixel + 3] === 0) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  const alphaAt = (x: number, y: number): number => pixels[y * stride + x * bytesPerPixel + 3];
  return {
    width,
    height,
    visibleWidth: maxX - minX + 1,
    visibleHeight: maxY - minY + 1,
    edgeAlpha: [alphaAt(0, height / 2), alphaAt(width - 1, height / 2), alphaAt(width / 2, 0), alphaAt(width / 2, height - 1)],
  };
}

describe("toolbar icon assets", () => {
  it.each(TOOLBAR_ICONS)("fills the toolbar slot edge-to-edge for %s", async (name) => {
    const png = await readFile(join(process.cwd(), "public", "icons", `${name}-16.png`));
    const metrics = alphaMetrics(png);

    expect(metrics).toMatchObject({ width: 16, height: 16 });
    expect(metrics.visibleWidth).toBe(16);
    expect(metrics.visibleHeight).toBe(16);
    expect(metrics.edgeAlpha.every((alpha) => alpha >= 240)).toBe(true);
  });
});
