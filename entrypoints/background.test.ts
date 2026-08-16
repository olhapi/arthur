import { describe, expect, it, vi } from "vitest";

import { createBackgroundController } from "./background.js";
import { createExtractionMessageHandler } from "./content.js";

describe("createBackgroundController", () => {
  it("saves the active tab once and clears its previous status popup", async () => {
    let onClick: ((tab: { id?: number; url?: string }) => void) | undefined;
    const browser = {
      action: {
        onClicked: { addListener(listener: (tab: { id?: number; url?: string }) => void) { onClick = listener; } },
        setPopup: vi.fn().mockResolvedValue(undefined),
      },
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 18, url: "https://example.test/article" }]),
      },
    };
    const save = vi.fn().mockResolvedValue(undefined);
    createBackgroundController(browser, { save });

    onClick?.({ id: 18, url: "https://example.test/article" });
    await Promise.resolve();
    await Promise.resolve();

    expect(browser.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(browser.action.setPopup).toHaveBeenCalledWith({ tabId: 18, popup: "" });
    expect(save).toHaveBeenCalledWith(18, "https://example.test/article");
  });

  it("prevents a concurrent save for the same tab", async () => {
    let onClick: ((tab: { id?: number; url?: string }) => void) | undefined;
    const browser = {
      action: {
        onClicked: { addListener(listener: (tab: { id?: number; url?: string }) => void) { onClick = listener; } },
        setPopup: vi.fn().mockResolvedValue(undefined),
      },
      tabs: { query: vi.fn().mockResolvedValue([{ id: 22, url: "https://example.test/article" }]) },
    };
    let release: (() => void) | undefined;
    const save = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    createBackgroundController(browser, { save });

    onClick?.({ id: 22, url: "https://example.test/article" });
    await Promise.resolve();
    onClick?.({ id: 22, url: "https://example.test/article" });
    await Promise.resolve();

    expect(save).toHaveBeenCalledTimes(1);
    release?.();
  });
});

describe("createExtractionMessageHandler", () => {
  it("forwards extraction requests to the article extractor with the rendered document URL", () => {
    const document = new DOMParser().parseFromString("<article>Article</article>", "text/html");
    const extract = vi.fn().mockReturnValue({ title: "Article" });
    const handler = createExtractionMessageHandler(document, { href: "https://example.test/rendered#section" }, extract);

    expect(handler({ type: "extract_article" })).toEqual({ title: "Article" });
    expect(extract).toHaveBeenCalledWith(document, "https://example.test/rendered#section");
  });
});
