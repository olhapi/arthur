import { describe, expect, it } from "vitest";

import { copyInstallCommand, isNativeRelease, renderAvailability } from "./site.js";

describe("renderAvailability", () => {
  it("keeps an unconfigured store unavailable instead of creating a dead link", () => {
    document.body.innerHTML = '<a data-store="chrome">Install for Chrome</a>';

    renderAvailability({ stores: { chrome: null, firefox: null } }, document);

    const link = document.querySelector("[data-store=chrome]");
    expect(link?.getAttribute("aria-disabled")).toBe("true");
    expect(link?.textContent).toBe("Chrome — coming soon");
    expect(link?.hasAttribute("href")).toBe(false);
  });

  it("turns a configured store URL into a labelled external install link", () => {
    document.body.innerHTML = '<a data-store="firefox">Install for Firefox</a>';

    renderAvailability(
      { stores: { chrome: null, firefox: "https://addons.mozilla.org/firefox/addon/arthur/" } },
      document,
    );

    const link = document.querySelector("[data-store=firefox]");
    expect(link?.getAttribute("href")).toBe("https://addons.mozilla.org/firefox/addon/arthur/");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.textContent).toBe("Install for Firefox");
  });

  it("renders the published Chrome and Firefox marketplace URLs", async () => {
    document.body.innerHTML = [
      '<a data-store="chrome">Install for Chrome</a>',
      '<a data-store="firefox">Install for Firefox</a>',
    ].join("");
    const { SITE_CONFIG } = await import("./site-config.js");

    renderAvailability(SITE_CONFIG, document);

    expect(document.querySelector("[data-store=chrome]")?.getAttribute("href")).toBe(
      "https://chromewebstore.google.com/detail/arthur-%E2%80%94-article-saver/bfcgihgadankhhijhhdlkekecfmbihef?authuser=0&hl=en",
    );
    expect(document.querySelector("[data-store=firefox]")?.getAttribute("href")).toBe(
      "https://addons.mozilla.org/en-US/firefox/addon/arthur-article-saver/",
    );
    expect(document.querySelector("[data-store=chrome]")?.textContent).toBe("Install for Chrome");
    expect(document.querySelector("[data-store=firefox]")?.textContent).toBe("Install for Firefox");
    expect(document.querySelector("[aria-disabled]")).toBeNull();
  });
});

describe("copyInstallCommand", () => {
  it("announces a successful copy without hiding the selected command", async () => {
    document.body.innerHTML = [
      '<button data-copy-command="#install-command">Copy</button>',
      '<code id="install-command">pnpm native:install</code>',
      '<p data-copy-status aria-live="polite"></p>',
    ].join("");
    const button = document.querySelector("button");
    const clipboard = { writeText: async (value: string) => expect(value).toBe("pnpm native:install") };

    await copyInstallCommand(button, clipboard, document);

    expect(document.querySelector("[data-copy-status]")?.textContent).toBe("Copied");
    expect(document.querySelector("#install-command")?.textContent).toBe("pnpm native:install");
  });
});

describe("isNativeRelease", () => {
  it("accepts a versioned GitHub Release asset with its SHA-256", () => {
    expect(
      isNativeRelease({
        version: "0.1.0",
        url: "https://github.com/olhapi/arthur/releases/download/v0.1.0/arthur-native-macos.tar.gz",
        sha256: "a".repeat(64),
        sourceUrl: "https://github.com/olhapi/arthur/blob/v0.1.0/scripts/native-host/install.mjs",
      }),
    ).toBe(true);
  });

  it("rejects mutable release links and missing checksums", () => {
    expect(
      isNativeRelease({
        version: "0.1.0",
        url: "https://github.com/olhapi/arthur/releases/latest/download/arthur-native-macos.tar.gz",
        sha256: "",
        sourceUrl: "https://github.com/olhapi/arthur",
      }),
    ).toBe(false);
  });
});
