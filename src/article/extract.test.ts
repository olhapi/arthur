// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { extractArticle } from "./extract.js";

const fixturePath = resolve(process.cwd(), "tests/fixtures/article.html");

function fixtureDocument(): Document {
  window.happyDOM.settings.navigation.disableChildFrameNavigation = true;
  return new DOMParser().parseFromString(readFileSync(fixturePath, "utf8"), "text/html");
}

describe("extractArticle", () => {
  it("extracts rendered article media into deterministic placeholders", () => {
    const article = extractArticle(fixtureDocument(), "https://example.test/articles/media?edition=1#section");

    expect(article.title).toBe("All Media Formats");
    expect(article.source).toBe("https://example.test/articles/media?edition=1");
    expect(article.markdown).toContain("## Preserved heading");
    expect(article.markdown).toContain("```ts");
    expect(article.markdown).not.toContain("onclick=");
    expect(article.media.map((item) => item.originalName)).toEqual(
      expect.arrayContaining([
        "animated.gif",
        "animated.webp",
        "diagram.svg",
        "photo.avif",
        "audio.mp3",
        "poster.jpg",
        "video.mp4",
      ]),
    );
    expect(article.media.filter((item) => item.originalName === "photo.avif")).toHaveLength(1);
    expect(article.markdown).toContain("[Embedded content](https://example.test/embedded/player)");
  });

  it("uses the live responsive source selected before document cloning", () => {
    const document = new DOMParser().parseFromString(
      `<!doctype html>
        <html><head><title>Responsive article</title></head><body>
          <article class="article-content">
            <h1>Responsive article</h1>
            <p>This article proves extraction reads the browser-selected responsive image instead of a fallback attribute.</p>
            <img id="hero" src="/media/fallback.jpg" srcset="/media/small.jpg 400w, /media/selected.webp 1200w" alt="Hero">
          </article>
        </body></html>`,
      "text/html",
    );
    const hero = document.querySelector<HTMLImageElement>("#hero");
    Object.defineProperty(hero, "currentSrc", {
      configurable: true,
      value: "https://cdn.example.test/rendered/selected.webp",
    });

    const article = extractArticle(document, "https://example.test/articles/responsive");

    expect(article.media).toContainEqual(
      expect.objectContaining({ url: "https://cdn.example.test/rendered/selected.webp" }),
    );
    expect(article.media).not.toContainEqual(expect.objectContaining({ url: "https://example.test/media/fallback.jpg" }));
  });

  it("preserves Markdown structures that Readability retains", () => {
    const article = extractArticle(fixtureDocument(), "https://example.test/articles/media?edition=1");

    expect(article.markdown).toContain("| Format | Extension |");
    expect(article.markdown).toContain("~~deprecated~~");
    expect(article.markdown).toContain("> A preserved quotation.");
    expect(article.markdown).toMatch(/-\s+First item/);
    expect(article.markdown).toContain("[a useful link](https://example.test/guide)");
  });

  it("fails when Readability cannot extract article content", () => {
    const empty = new DOMParser().parseFromString("", "text/html");

    expect(() => extractArticle(empty, "https://example.test/empty")).toThrow(
      "Could not extract a readable article",
    );
  });
});
