import { describe, expect, it, vi } from "vitest";

import { createBackgroundController, createStatusBrowserAdapter, registerStatusCleanup } from "./background.js";
import { registerExtractionListener } from "./content.js";
import { StatusController, statusStorageKey } from "../src/background/status.js";

const trustedSender = { id: "arthur-extension", url: "moz-extension://arthur-extension/status.html?tabId=31" };

function retryHarness({
  tab = { id: 31, url: "https://example.test/retry" },
  setPopup = vi.fn().mockResolvedValue(undefined),
  save = vi.fn().mockResolvedValue({ status: "success" }),
}: {
  tab?: { id?: number; url?: string };
  setPopup?: ReturnType<typeof vi.fn>;
  save?: ReturnType<typeof vi.fn>;
} = {}) {
  let onClick: ((tab: { id?: number; url?: string }) => void) | undefined;
  let onMessage:
    | ((message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean | undefined)
    | undefined;
  const browser = {
    action: {
      onClicked: { addListener(listener: (nextTab: { id?: number; url?: string }) => void) { onClick = listener; } },
      setPopup,
    },
    tabs: {
      query: vi.fn().mockResolvedValue([{ id: 99, url: "https://example.test/focused-elsewhere" }]),
      get: vi.fn().mockResolvedValue(tab),
    },
    runtime: {
      id: "arthur-extension",
      getURL: vi.fn().mockReturnValue("moz-extension://arthur-extension/status.html"),
      onMessage: {
        addListener(
          listener: (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean | undefined,
        ) {
          onMessage = listener;
        },
      },
    },
  };
  createBackgroundController(browser, { save });
  const dispatch = async (
    message: unknown = { type: "retry_save", tabId: 31 },
    sender: unknown = trustedSender,
  ): Promise<unknown> => {
    let resolveResponse: ((response: unknown) => void) | undefined;
    const response = new Promise<unknown>((resolve) => { resolveResponse = resolve; });
    expect(onMessage?.(message, sender, (value) => resolveResponse?.(value))).toBe(true);
    return response;
  };
  return { browser, dispatch, get onClick() { return onClick; }, get onMessage() { return onMessage; }, save };
}

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

    expect(browser.tabs.query).not.toHaveBeenCalled();
    expect(browser.action.setPopup).toHaveBeenCalledWith({ tabId: 18, popup: "" });
    expect(save).toHaveBeenCalledWith(18, "https://example.test/article");
  });

  it("registers and saves through Firefox MV2's browserAction-only API", async () => {
    let onClick: ((tab: { id?: number; url?: string }) => void) | undefined;
    const browser = {
      browserAction: {
        onClicked: { addListener(listener: (tab: { id?: number; url?: string }) => void) { onClick = listener; } },
        setPopup: vi.fn().mockResolvedValue(undefined),
      },
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 19, url: "https://example.test/firefox" }]),
      },
      runtime: { onMessage: { addListener: vi.fn() } },
    };
    const save = vi.fn().mockResolvedValue(undefined);

    createBackgroundController(browser, { save });
    onClick?.({ id: 19, url: "https://example.test/firefox" });
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith(19, "https://example.test/firefox"));

    expect(browser.browserAction.setPopup).toHaveBeenCalledWith({ tabId: 19, popup: "" });
  });

  it("saves the exact toolbar-clicked tab without re-querying later focus", async () => {
    const browser = {
      action: { onClicked: { addListener: vi.fn() }, setPopup: vi.fn() },
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 99, url: "https://example.test/later-focus" }]),
        get: vi.fn(),
      },
      runtime: { id: "arthur", getURL: vi.fn(), onMessage: { addListener: vi.fn() } },
    };
    const save = vi.fn().mockResolvedValue({ status: "success" });
    createBackgroundController(browser, { save });

    const listener = browser.action.onClicked.addListener.mock.calls[0]?.[0] as ((tab: { id?: number; url?: string }) => void);
    listener({ id: 18, url: "https://example.test/clicked" });

    await vi.waitFor(() => expect(save).toHaveBeenCalledWith(18, "https://example.test/clicked"));
    expect(browser.tabs.query).not.toHaveBeenCalled();
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

    onClick?.({ id: 22, url: "https://example.test/first" });
    await Promise.resolve();
    onClick?.({ id: 23, url: "https://example.test/second" });
    await Promise.resolve();
    await Promise.resolve();

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(22, "https://example.test/first");
    expect(browser.tabs.query).not.toHaveBeenCalled();
    release?.();
  });

  it("retries the popup's explicit tab even after browser focus changes", async () => {
    const harness = retryHarness();

    await expect(harness.dispatch()).resolves.toEqual({ ok: true });

    expect(harness.browser.tabs.get).toHaveBeenCalledWith(31);
    expect(harness.browser.tabs.query).not.toHaveBeenCalled();
    expect(harness.browser.action.setPopup).toHaveBeenCalledWith({ tabId: 31, popup: "" });
    expect(harness.save).toHaveBeenCalledWith(31, "https://example.test/retry");
  });

  it("rejects retry messages from non-status extension contexts and malformed shapes", () => {
    const harness = retryHarness();
    const sendResponse = vi.fn();

    expect(harness.onMessage?.({ type: "retry_save", tabId: 31 }, {
      id: "arthur-extension",
      url: "https://example.test/article",
    }, sendResponse)).toBeUndefined();
    expect(harness.onMessage?.({ type: "retry_save", tabId: 31, extra: true }, trustedSender, sendResponse)).toBeUndefined();
    expect(harness.onMessage?.({ type: "retry_save", tabId: 31 }, {
      id: "other-extension",
      url: "moz-extension://arthur-extension/status.html",
    }, sendResponse)).toBeUndefined();
    expect(harness.onMessage?.({ type: "retry_save", tabId: 31 }, {
      id: "arthur-extension",
      url: "moz-extension://arthur-extension/status.html?tabId=32",
    }, sendResponse)).toBeUndefined();
    expect(harness.onMessage?.({ type: "retry_save", tabId: 31 }, {
      id: "arthur-extension",
      url: "moz-extension://arthur-extension/status.html?tabId=31&extra=true",
    }, sendResponse)).toBeUndefined();
    expect(harness.browser.tabs.get).not.toHaveBeenCalled();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it.each([
    ["closed tab", { tab: () => Promise.reject(new Error("closed")) }, "tab_unavailable"],
    ["tab without a URL", { tab: () => Promise.resolve({ id: 31 }) }, "tab_unavailable"],
    ["tab with an invalid URL", { tab: () => Promise.resolve({ id: 31, url: "about:config" }) }, "tab_unavailable"],
    ["popup clearing failure", { setPopup: vi.fn().mockRejectedValue(new Error("popup")) }, "save_failed"],
    ["coordinator rejection", { save: vi.fn().mockRejectedValue(new Error("save")) }, "save_failed"],
  ])("responds with a typed failure for %s", async (_name, setup, expectedCode) => {
    const harness = retryHarness({
      ...(setup.tab === undefined ? {} : { tab: undefined }),
      ...(setup.setPopup === undefined ? {} : { setPopup: setup.setPopup }),
      ...(setup.save === undefined ? {} : { save: setup.save }),
    });
    if (setup.tab !== undefined) harness.browser.tabs.get.mockImplementation(setup.tab);

    await expect(harness.dispatch()).resolves.toMatchObject({ ok: false, code: expectedCode });
    if (_name === "tab without a URL" || _name === "tab with an invalid URL") {
      expect(harness.browser.action.setPopup).toHaveBeenCalledWith({ tabId: 31, popup: "" });
    }
  });

  it("responds busy instead of claiming a skipped retry succeeded", async () => {
    let release: (() => void) | undefined;
    const save = vi.fn().mockImplementation(() => new Promise((resolve) => { release = () => resolve({ status: "success" }); }));
    const harness = retryHarness({ save });
    harness.browser.tabs.query.mockResolvedValue([{ id: 22, url: "https://example.test/first" }]);
    harness.onClick?.({ id: 22, url: "https://example.test/first" });
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());

    await expect(harness.dispatch()).resolves.toMatchObject({ ok: false, code: "save_busy" });
    release?.();
  });
});

describe("per-tab status storage", () => {
  it("uses Firefox MV2's browserAction API for status UI", async () => {
    const browserAction = { setBadgeText: vi.fn(), setPopup: vi.fn() };
    const adapter = createStatusBrowserAdapter({
      browserAction,
      storage: { local: { set: vi.fn(), remove: vi.fn() } },
    });

    await adapter.setBadgeText({ tabId: 41, text: "!" });
    await adapter.setPopup({ tabId: 41, popup: "status.html?tabId=41" });

    expect(browserAction.setBadgeText).toHaveBeenCalledWith({ tabId: 41, text: "!" });
    expect(browserAction.setPopup).toHaveBeenCalledWith({ tabId: 41, popup: "status.html?tabId=41" });
  });
  it("writes independent keys for A and B instead of replacing one global record", async () => {
    const storage = { set: vi.fn().mockResolvedValue(undefined), remove: vi.fn().mockResolvedValue(undefined) };
    const adapter = createStatusBrowserAdapter({
      action: { setBadgeText: vi.fn(), setPopup: vi.fn() },
      storage: { local: storage },
    });
    const status = new StatusController(adapter);

    await status.error(41, { code: "tab_a", message: "Status A." });
    await status.error(42, { code: "tab_b", message: "Status B." });

    expect(storage.set).toHaveBeenNthCalledWith(1, {
      [statusStorageKey(41)]: { tabId: 41, kind: "error", details: [{ code: "tab_a", message: "Status A." }] },
    });
    expect(storage.set).toHaveBeenNthCalledWith(2, {
      [statusStorageKey(42)]: { tabId: 42, kind: "error", details: [{ code: "tab_b", message: "Status B." }] },
    });
  });

  it("removes a tab's status key when that tab closes", async () => {
    let onRemoved: ((tabId: number) => void) | undefined;
    const remove = vi.fn().mockResolvedValue(undefined);
    registerStatusCleanup({
      tabs: { onRemoved: { addListener(listener: (tabId: number) => void) { onRemoved = listener; } } },
      storage: { local: { remove } },
    });

    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith("status"));
    onRemoved?.(41);
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith(statusStorageKey(41)));
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
