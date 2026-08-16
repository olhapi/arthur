// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import { finalizeMarkdown } from "./markdown.js";

describe("finalizeMarkdown", () => {
  it("converts resolved media placeholders to Obsidian attachment embeds", () => {
    expect(finalizeMarkdown("before arthur-media://m1 after", new Map([["m1", "hero--abc.webp"]]))).toBe(
      "before ![[attachments/hero--abc.webp]] after",
    );
  });

  it("leaves placeholders without a saved attachment unchanged", () => {
    expect(finalizeMarkdown("arthur-media://m2", new Map())).toBe("arthur-media://m2");
  });
});
