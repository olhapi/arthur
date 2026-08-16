import { describe, expect, it, vi } from "vitest";

import { createBackgroundController } from "./background.js";
import { registerExtractionListener } from "./content.js";

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
      runtime: { onMessage: { addListener: vi.fn() } },
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

  it("prevents concurrent saves across tabs that share one native client", async () => {
    let onClick: ((tab: { id?: number; url?: string }) => void) | undefined;
    const browser = {
      action: {
        onClicked: { addListener(listener: (tab: { id?: number; url?: string }) => void) { onClick = listener; } },
        setPopup: vi.fn().mockResolvedValue(undefined),
      },
      tabs: { query: vi.fn() },
      runtime: { onMessage: { addListener: vi.fn() } },
    };
    let release: (() => void) | undefined;
    const save = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    createBackgroundController(browser, { save });

    browser.tabs.query.mockResolvedValueOnce([{ id: 22, url: "https://example.test/first" }]);
    onClick?.({ id: 22, url: "https://example.test/article" });
    await Promise.resolve();
    browser.tabs.query.mockResolvedValueOnce([{ id: 23, url: "https://example.test/second" }]);
    onClick?.({ id: 23, url: "https://example.test/second" });
    await vi.waitFor(() => expect(browser.tabs.query).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    await Promise.resolve();

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(22, "https://example.test/first");
    release?.();
  });

  it("retries through a background message when the status popup intercepts toolbar clicks", async () => {
    let onClick: ((tab: { id?: number; url?: string }) => void) | undefined;
    let onMessage:
      | ((message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean | undefined)
      | undefined;
    let popup = "status.html";
    const browser = {
      action: {
        onClicked: { addListener(listener: (tab: { id?: number; url?: string }) => void) { onClick = listener; } },
        setPopup: vi.fn().mockImplementation(async ({ popup: nextPopup }: { popup: string }) => { popup = nextPopup; }),
      },
      tabs: { query: vi.fn().mockResolvedValue([{ id: 31, url: "https://example.test/retry" }]) },
      runtime: {
        onMessage: {
          addListener(
            listener: (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean | undefined,
          ) {
            onMessage = listener;
          },
        },
      },
    };
    const save = vi.fn().mockResolvedValue(undefined);
    createBackgroundController(browser, { save });

    if (popup === "") onClick?.({ id: 31, url: "https://example.test/retry" });
    expect(save).not.toHaveBeenCalled();
    const sendResponse = vi.fn();
    expect(onMessage?.({ type: "retry_save" }, {}, sendResponse)).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(browser.action.setPopup).toHaveBeenCalledWith({ tabId: 31, popup: "" });
    expect(save).toHaveBeenCalledWith(31, "https://example.test/retry");
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true }));
  });
});

describe("registerExtractionListener", () => {
  it("registers a callback transport that sends the extracted article to Chrome", () => {
    let listener:
      | ((message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean | undefined)
      | undefined;
    const runtime = {
      onMessage: {
        addListener(
          next: (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean | undefined,
        ) {
          listener = next;
        },
      },
    };
    const document = new DOMParser().parseFromString("<article>Article</article>", "text/html");
    const article = { title: "Article" };
    const extract = vi.fn().mockReturnValue(article);
    const sendResponse = vi.fn();
    registerExtractionListener(runtime, document, { href: "https://example.test/rendered#section" }, extract);

    expect(listener?.({ type: "extract_article" }, {}, sendResponse)).toBe(true);
    expect(sendResponse).toHaveBeenCalledWith(article);
    expect(extract).toHaveBeenCalledWith(document, "https://example.test/rendered#section");
  });
});
