import { describe, expect, it } from "vitest";

import { ClientMessageSchema, HostMessageSchema } from "./protocol.js";

const sessionId = "a5a74c85-92de-4a5d-9768-4e66c4d64987";

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
        mediaId: "m1",
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
        mediaId: "m1",
        sequence: 0,
        data: "not base64!",
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
