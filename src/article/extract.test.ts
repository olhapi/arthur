// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { extractArticle } from "./extract.js";
import { finalizeMarkdown } from "./markdown.js";

const fixturePath = resolve(process.cwd(), "tests/fixtures/article.html");

function fixtureDocument(): Document {
  window.happyDOM.settings.navigation.disableChildFrameNavigation = true;
  return new DOMParser().parseFromString(readFileSync(fixturePath, "utf8"), "text/html");
}

describe("extractArticle", () => {
  it("extracts rendered article media into injected UUID placeholders", () => {
    const ids = [
      "7f9b5e81-4e80-4b7b-9ac5-c5d54f88b832",
      "e0ddc6e9-9075-455f-9af0-2d2fd08dcc6d",
      "b57a7301-352a-4d4d-bdc0-cb7a0a020ee1",
      "4a08295e-a330-4cdd-9ca6-508eafef3bc4",
      "0cd5a1b1-152a-4bf5-8ddd-72dc516e5a75",
      "a430221c-6d1f-4a57-af26-7c3c70bb2d9a",
      "1853f601-f0a0-4667-b949-8e0bc5f6d8d1",
    ];
    let next = 0;
    const article = extractArticle(fixtureDocument(), "https://example.test/articles/media?edition=1#section", {
      createMediaId: () => ids[next++] ?? "",
    });

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
    expect(article.media.map((item) => item.id)).toEqual(ids);
    expect(article.media.every((item) => item.placeholder === `arthur-media://${item.id}`)).toBe(true);
    expect(article.markdown).toContain(`arthur-media://${ids[0]}`);
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

  it("unwraps a linked downloadable image into a local attachment embed", () => {
    const imageId = "7f9b5e81-4e80-4b7b-9ac5-c5d54f88b832";
    const document = new DOMParser().parseFromString(
      `<!doctype html><html><head><title>Linked image</title></head><body><article>
        <h1>Linked image</h1>
        <p>This deliberately substantial paragraph keeps Readability focused on the article and its linked image.</p>
        <a href="https://substackcdn.example.test/image/fetch/remote-wrapper"><img src="https://media.example.test/hero.jpeg" alt="Hero"></a>
      </article></body></html>`,
      "text/html",
    );

    const article = extractArticle(document, "https://example.test/linked-image", { createMediaId: () => imageId });
    const finalized = finalizeMarkdown(article.markdown, new Map([[imageId, "hero--abc.jpeg"]]));

    expect(finalized).toContain("![[attachments/hero--abc.jpeg]]");
    expect(finalized).not.toContain("substackcdn.example.test");
  });

  it("removes hidden and tracking-pixel media before extracting resources while retaining icons", () => {
    const document = new DOMParser().parseFromString(
      `<!doctype html><html><head><title>Tracked article</title></head><body><article>
        <h1>Tracked article</h1><p>This deliberately substantial article paragraph keeps Readability focused on this visible content rather than surrounding page chrome.</p>
        <img src="https://cdn.example.test/pixel.gif" width="1" height="1" data-tracking-id="a">
        <img src="https://cdn.example.test/collect.gif" data-tracking="true">
        <img src="https://cdn.example.test/hidden.webp" style="display: none">
        <img src="https://cdn.example.test/icon.svg" width="16" height="16" class="icon" alt="Icon">
      </article></body></html>`, "text/html",
    );

    const article = extractArticle(document, "https://example.test/tracked");
    expect(article.media.map((item) => item.url)).toContain("https://cdn.example.test/icon.svg");
    expect(article.media.map((item) => item.url)).not.toContain("https://cdn.example.test/pixel.gif");
    expect(article.media.map((item) => item.url)).not.toContain("https://cdn.example.test/collect.gif");
    expect(article.media.map((item) => item.url)).not.toContain("https://cdn.example.test/hidden.webp");
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
