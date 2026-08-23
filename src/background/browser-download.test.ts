import { describe, expect, it } from "vitest";

import { markdownDownload } from "./browser-download.js";

describe("markdownDownload", () => {
  it("creates a safe Markdown filename and preserves article identity in frontmatter", () => {
    expect(markdownDownload({
      title: '  A / unsafe: title?  ',
      source: "https://example.test/article?ref=1",
      markdown: "# Body\n\nSaved content.",
      media: [],
    })).toEqual({
      filename: "A unsafe title.md",
      contents: [
        "---",
        'title: "  A / unsafe: title?  "',
        'source: "https://example.test/article?ref=1"',
        "---",
        "",
        "# Body",
        "",
        "Saved content.",
      ].join("\n"),
    });
  });

  it("keeps registered media as remote links instead of native-only placeholders", () => {
    expect(markdownDownload({
      title: "Article",
      source: "https://example.test/article",
      markdown: "Before arthur-media://7f9b5e81-4e80-4b7b-9ac5-c5d54f88b832 after arthur-media://unknown.",
      media: [{
        id: "7f9b5e81-4e80-4b7b-9ac5-c5d54f88b832",
        url: "https://cdn.example.test/hero.webp",
        originalName: "hero.webp",
        kind: "image",
        placeholder: "arthur-media://7f9b5e81-4e80-4b7b-9ac5-c5d54f88b832",
      }],
    }).contents).toContain("Before <https://cdn.example.test/hero.webp> after arthur-media://unknown.");
  });
});
