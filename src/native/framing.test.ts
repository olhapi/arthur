import { describe, expect, it } from "vitest";

import { encodeNativeMessage, NativeMessageDecoder } from "./framing.js";

describe("native message framing", () => {
  it("decodes fragmented and coalesced frames in order", () => {
    const first = encodeNativeMessage({ type: "first", value: 1 });
    const second = encodeNativeMessage({ type: "second", value: 2 });
    const decoder = new NativeMessageDecoder();

    expect(decoder.push(first.subarray(0, 3))).toEqual([]);
    expect(decoder.push(Buffer.concat([first.subarray(3), second]))).toEqual([
      { type: "first", value: 1 },
      { type: "second", value: 2 },
    ]);
  });

  it("rejects zero-length and oversized incoming frames", () => {
    const decoder = new NativeMessageDecoder();
    const zeroLength = Buffer.alloc(4);
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32LE(1024 * 1024 + 1);

    expect(() => decoder.push(zeroLength)).toThrow(/zero/i);
    expect(() => new NativeMessageDecoder().push(oversized)).toThrow(/1 MiB/i);
  });

  it("rejects invalid UTF-8 and JSON payloads", () => {
    const invalidUtf8 = Buffer.alloc(6);
    invalidUtf8.writeUInt32LE(2);
    invalidUtf8.set([0xc3, 0x28], 4);
    const invalidJson = Buffer.concat([
      Buffer.from([5, 0, 0, 0]),
      Buffer.from("nope!", "utf8"),
    ]);

    expect(() => new NativeMessageDecoder().push(invalidUtf8)).toThrow(/UTF-8/i);
    expect(() => new NativeMessageDecoder().push(invalidJson)).toThrow(/JSON/i);
  });
});
