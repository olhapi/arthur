import { describe, expect, it, vi } from "vitest";

import { StatusController, type StatusBrowserAdapter } from "./status.js";

class FakeStatusBrowser implements StatusBrowserAdapter {
  readonly calls: string[] = [];
  readonly details: unknown[] = [];

  async setBadgeText({ tabId, text }: { tabId: number; text: string }): Promise<void> {
    this.calls.push(`badge:${tabId}:${text}`);
  }

  async setIcon({ tabId, path }: { tabId: number; path: Readonly<Record<number, string>> }): Promise<void> {
    this.calls.push(`icon:${tabId}:${path[16]}`);
  }

  async setPopup({ tabId, popup }: { tabId: number; popup: string }): Promise<void> {
    this.calls.push(`popup:${tabId}:${popup}`);
  }

  async setLocal(value: unknown): Promise<void> {
    this.calls.push("local");
    this.details.push(value);
  }

  async clearLocal(tabId: number): Promise<void> {
    this.calls.push(`clear:${tabId}`);
  }
}

describe("StatusController", () => {
  it("renders each status as a full, tab-specific toolbar icon", async () => {
    const browser = new FakeStatusBrowser();
    const status = new StatusController(browser);

    await status.ready(17);
    await status.saving(17);
    await status.success(17);
    await status.warning(17, [{ code: "media_fallback", message: "The original link was retained." }]);
    await status.error(17, { code: "commit_failed", message: "The article could not be committed." });

    expect(browser.calls).toEqual([
      "icon:17:icons/arthur-ready-16.png",
      "popup:17:",
      "clear:17",
      "icon:17:icons/arthur-saving-16.png",
      "popup:17:",
      "clear:17",
      "icon:17:icons/arthur-saved-16.png",
      "popup:17:",
      "clear:17",
      "icon:17:icons/arthur-attention-16.png",
      "local",
      "popup:17:status.html?tabId=17",
      "icon:17:icons/arthur-attention-16.png",
      "local",
      "popup:17:status.html?tabId=17",
    ]);
  });

  it("clears an old popup while saving and marks a successful save", async () => {
    const browser = new FakeStatusBrowser();
    const status = new StatusController(browser);

    await status.saving(17);
    await status.success(17);

    expect(browser.calls).toEqual([
      "icon:17:icons/arthur-saving-16.png",
      "popup:17:",
      "clear:17",
      "icon:17:icons/arthur-saved-16.png",
      "popup:17:",
      "clear:17",
    ]);
    expect(browser.details).toEqual([]);
  });

  it("opens the local status page only for warning and error details", async () => {
    const browser = new FakeStatusBrowser();
    const status = new StatusController(browser);

    await status.warning(17, [{ code: "media_fallback", message: "The original link was retained." }]);
    await status.error(17, { code: "commit_failed", message: "The article could not be committed." });

    expect(browser.calls).toEqual([
      "icon:17:icons/arthur-attention-16.png",
      "local",
      "popup:17:status.html?tabId=17",
      "icon:17:icons/arthur-attention-16.png",
      "local",
      "popup:17:status.html?tabId=17",
    ]);
    expect(browser.details).toEqual([
      { tabId: 17, kind: "warning", details: [{ code: "media_fallback", message: "The original link was retained." }] },
      { tabId: 17, kind: "error", details: [{ code: "commit_failed", message: "The article could not be committed." }] },
    ]);
  });

  it("keeps saving and post-commit success UI when status cleanup rejects", async () => {
    const browser = new FakeStatusBrowser();
    browser.clearLocal = vi.fn().mockRejectedValue(new Error("storage unavailable"));
    const status = new StatusController(browser);

    await expect(status.saving(17)).resolves.toBeUndefined();
    await expect(status.success(17)).resolves.toBeUndefined();

    expect(browser.calls).toEqual([
      "icon:17:icons/arthur-saving-16.png",
      "popup:17:",
      "icon:17:icons/arthur-saved-16.png",
      "popup:17:",
    ]);
  });
});
