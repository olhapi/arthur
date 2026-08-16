import { describe, expect, it } from "vitest";

import { ClientMessageSchema, HostMessageSchema } from "./protocol.js";

const sessionId = "a5a74c85-92de-4a5d-9768-4e66c4d64987";
const mediaId = "7f9b5e81-4e80-4b7b-9ac5-c5d54f88b832";

describe("ClientMessageSchema", () => {
  it("accepts a versioned hello request", () => {
    expect(
      ClientMessageSchema.parse({
        type: "hello",
        requestId: "r1",
        protocolVersion: 1,
      }),
    ).toMatchObject({ type: "hello" });
  });

  it("rejects a negative media chunk sequence", () => {
    expect(() =>
      ClientMessageSchema.parse({
        type: "media_chunk",
        sessionId,
        mediaId,
        sequence: -1,
        data: "AA==",
      }),
    ).toThrow();
  });

  it("normalizes an HTTP(S) source for a save session", () => {
    expect(
      ClientMessageSchema.parse({
        type: "begin_save",
        requestId: "save-1",
        sessionId,
        destination: "/Vault/Clippings",
        source: "HTTPS://example.com/article",
        title: "An article",
        markdown: "# An article",
      }),
    ).toMatchObject({
      type: "begin_save",
      source: "https://example.com/article",
    });
  });

  it("rejects media data that is not base64", () => {
    expect(() =>
      ClientMessageSchema.parse({
        type: "media_chunk",
        sessionId,
        mediaId,
        sequence: 0,
        data: "not base64!",
      }),
    ).toThrow();
  });

  it("accepts a media chunk with exactly 262,144 decoded bytes", () => {
    expect(() =>
      ClientMessageSchema.parse({
        type: "media_chunk",
        sessionId,
        mediaId,
        sequence: 0,
        data: Buffer.alloc(262_144).toString("base64"),
      }),
    ).not.toThrow();
  });

  it("rejects a media chunk with 262,145 decoded bytes", () => {
    expect(() =>
      ClientMessageSchema.parse({
        type: "media_chunk",
        sessionId,
        mediaId,
        sequence: 0,
        data: Buffer.alloc(262_145).toString("base64"),
      }),
    ).toThrow();
  });

  it("requires UUID media identifiers and a 10 MiB UTF-16 Markdown limit", () => {
    expect(() =>
      ClientMessageSchema.parse({
        type: "begin_media",
        requestId: "media",
        sessionId,
        mediaId: "m1",
        source: "https://cdn.example.test/hero.webp",
        kind: "image",
        contentType: "image/webp",
        byteLength: 0,
      }),
    ).toThrow();

    const atLimit = "😀".repeat(5 * 1024 * 1024);
    expect(atLimit.length).toBe(10 * 1024 * 1024);
    expect(() =>
      ClientMessageSchema.parse({
        type: "begin_save",
        requestId: "save-limit",
        sessionId,
        destination: "/Vault/Clippings",
        source: "https://example.test/article",
        title: "An article",
        markdown: atLimit,
      }),
    ).not.toThrow();
    expect(() =>
      ClientMessageSchema.parse({
        type: "begin_save",
        requestId: "save-over-limit",
        sessionId,
        destination: "/Vault/Clippings",
        source: "https://example.test/article",
        title: "An article",
        markdown: `${atLimit}x`,
      }),
    ).toThrow();
  });
});

describe("HostMessageSchema", () => {
  it("accepts a typed save result", () => {
    expect(
      HostMessageSchema.parse({
        type: "save_result",
        requestId: "save-1",
        sessionId,
        savedPath: "/Vault/Clippings/an-article.md",
      }),
    ).toMatchObject({ type: "save_result" });
  });

  it("rejects an unbounded error shape with unknown fields", () => {
    expect(() =>
      HostMessageSchema.parse({
        type: "error",
        code: "write_failed",
        message: "Could not write file",
        extra: true,
      }),
    ).toThrow();
  });
});
