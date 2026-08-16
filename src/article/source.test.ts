// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import { normalizeSource } from "./source.js";

describe("normalizeSource", () => {
  it("normalizes HTTP(S) URLs while retaining their path and query", () => {
    expect(normalizeSource("HTTPS://Example.COM:443/a?q=1#part")).toBe(
      "https://example.com/a?q=1",
    );
  });

  it("rejects non-browser HTTP(S) source URLs", () => {
    expect(() => normalizeSource("file:///tmp/article.html")).toThrow();
  });
});
