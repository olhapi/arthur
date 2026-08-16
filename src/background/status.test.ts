import { describe, expect, it } from "vitest";

import { StatusController, type StatusBrowserAdapter } from "./status.js";

class FakeStatusBrowser implements StatusBrowserAdapter {
  readonly calls: string[] = [];
  readonly details: unknown[] = [];

  async setBadgeText({ tabId, text }: { tabId: number; text: string }): Promise<void> {
    this.calls.push(`badge:${tabId}:${text}`);
  }

  async setPopup({ tabId, popup }: { tabId: number; popup: string }): Promise<void> {
    this.calls.push(`popup:${tabId}:${popup}`);
  }

  async setLocal(value: unknown): Promise<void> {
    this.calls.push("local");
    this.details.push(value);
  }
}

describe("StatusController", () => {
  it("clears an old popup while saving and marks a successful save", async () => {
    const browser = new FakeStatusBrowser();
    const status = new StatusController(browser);

    await status.saving(17);
    await status.success(17);

    expect(browser.calls).toEqual(["badge:17:…", "popup:17:", "badge:17:✓", "popup:17:"]);
    expect(browser.details).toEqual([]);
  });

  it("opens the local status page only for warning and error details", async () => {
    const browser = new FakeStatusBrowser();
    const status = new StatusController(browser);

    await status.warning(17, [{ code: "media_fallback", message: "The original link was retained." }]);
    await status.error(17, { code: "commit_failed", message: "The article could not be committed." });

    expect(browser.calls).toEqual([
      "badge:17:!",
      "local",
      "popup:17:status.html",
      "badge:17:!",
      "local",
      "popup:17:status.html",
    ]);
    expect(browser.details).toEqual([
      { tabId: 17, kind: "warning", details: [{ code: "media_fallback", message: "The original link was retained." }] },
      { tabId: 17, kind: "error", details: [{ code: "commit_failed", message: "The article could not be committed." }] },
    ]);
  });
});
