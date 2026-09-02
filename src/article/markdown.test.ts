// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import { finalizeMarkdown, htmlToMarkdown } from "./markdown.js";

const mediaId = "7f9b5e81-4e80-4b7b-9ac5-c5d54f88b832";

describe("htmlToMarkdown", () => {
  it("omits empty blockquotes embedded in list items", () => {
    expect(
      htmlToMarkdown(`
        <ul>
          <li><p>How well did I listen (1-10)?</p><blockquote><p><br></p></blockquote></li>
          <li><p>Where did I drift off, and why?</p><blockquote><br></blockquote></li>
          <li><p>How often did I interrupt?</p><blockquote></blockquote></li>
        </ul>
      `),
    ).toBe(
      [
        "-   How well did I listen (1-10)?",
        "-   Where did I drift off, and why?",
        "-   How often did I interrupt?",
      ].join("\n"),
    );
  });
});

describe("finalizeMarkdown", () => {
  it("converts resolved media placeholders to Obsidian attachment embeds", () => {
    expect(finalizeMarkdown(`before arthur-media://${mediaId} after`, new Map([[mediaId, "hero--abc.webp"]]))).toBe(
      "before ![[attachments/hero--abc.webp]] after",
    );
  });

  it("preserves literal, unknown, and suffix-colliding placeholders", () => {
    const unknown = "9a1a403f-d44a-4b63-b408-0f68934b3d72";
    expect(
      finalizeMarkdown(
        `arthur-media://m1 arthur-media://${unknown} arthur-media://${mediaId}suffix ARTHUR-MEDIA://${mediaId}`,
        new Map([[mediaId, "hero--abc.webp"]]),
      ),
    ).toBe(`arthur-media://m1 arthur-media://${unknown} arthur-media://${mediaId}suffix ARTHUR-MEDIA://${mediaId}`);
  });

  it("rewrites the nil and max UUID forms accepted by the canonical schema", () => {
    const nil = "00000000-0000-0000-0000-000000000000";
    const max = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    expect(
      finalizeMarkdown(
        `arthur-media://${nil} arthur-media://${max}`,
        new Map([
          [nil, "nil.webp"],
          [max, "max.webp"],
        ]),
      ),
    ).toBe("![[attachments/nil.webp]] ![[attachments/max.webp]]");
  });
});
