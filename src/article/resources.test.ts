// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import { classifyMedia, materializeRenderedResources } from "./resources.js";

describe("classifyMedia", () => {
  it("classifies browser-retrievable image files", () => {
    expect(classifyMedia("https://cdn.test/photo.avif", "IMG")).toBe("image");
  });

  it("leaves HLS manifests as streams", () => {
    expect(classifyMedia("https://cdn.test/live.m3u8", "VIDEO", "application/vnd.apple.mpegurl")).toBe(
      "stream",
    );
  });

  it.each(["audio/mpegurl", "audio/x-mpegurl"])('recognizes %s as an HLS stream', (contentType) => {
    expect(classifyMedia("https://cdn.test/live", "AUDIO", contentType)).toBe("stream");
  });

  it("leaves DASH manifests as streams", () => {
    expect(classifyMedia("https://cdn.test/live.mpd", "VIDEO", "application/dash+xml")).toBe("stream");
  });
});

describe("materializeRenderedResources", () => {
  it("keeps resolved HTTP(S) resources and chooses rendered responsive media", () => {
    window.happyDOM.settings.navigation.disableChildFrameNavigation = true;
    const document = new DOMParser().parseFromString(
      `<!doctype html>
        <article onclick="alert('unsafe')">
          <img id="hero" src="/fallback.jpg" srcset="/small.jpg 400w, /hero.avif 1200w">
          <video id="movie" src="javascript:alert(1)" poster="/poster.jpg"><source src="/clip.mp4" type="video/mp4"></video>
          <audio><source src="/sound.mp3" type="audio/mpeg"></audio>
          <iframe src="/embedded/player"></iframe>
          <img id="blocked" src="data:image/png;base64,AAAA">
        </article>`,
      "text/html",
    );
    const hero = document.querySelector<HTMLImageElement>("#hero");
    Object.defineProperty(hero, "currentSrc", {
      configurable: true,
      value: "https://media.example.test/rendered/hero.avif",
    });

    materializeRenderedResources(document, "https://example.test/articles/media?edition=1");

    expect(hero?.getAttribute("src")).toBe("https://media.example.test/rendered/hero.avif");
    expect(hero?.hasAttribute("srcset")).toBe(false);
    expect(document.querySelector("#movie")?.getAttribute("src")).toBeNull();
    expect(document.querySelector("#movie")?.getAttribute("poster")).toBe(
      "https://example.test/poster.jpg",
    );
    expect(document.querySelector("video source")?.getAttribute("src")).toBe("https://example.test/clip.mp4");
    expect(document.querySelector("audio source")?.getAttribute("src")).toBe("https://example.test/sound.mp3");
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.querySelector("a")?.getAttribute("href")).toBe("https://example.test/embedded/player");
    expect(document.querySelector("#blocked")?.hasAttribute("src")).toBe(false);
    expect(document.querySelector("article")?.getAttribute("onclick")).toBe("alert('unsafe')");
  });
});
