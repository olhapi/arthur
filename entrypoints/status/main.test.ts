// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

import { loadStatusForActiveTab, mountStatusPage } from "./main.js";
import { statusStorageKey } from "../../src/background/status.js";

describe("mountStatusPage", () => {
  it("renders stored warning details as text rather than HTML", async () => {
    document.body.innerHTML = '<main><div id="status-details" aria-live="polite"></div><button id="retry-save">Retry save</button></main>';
    const page = mountStatusPage(document, {
      retrySave: vi.fn(),
      loadStatus: vi.fn().mockResolvedValue({
        tabId: 17,
        status: {
          tabId: 17,
          kind: "warning",
          details: [{ code: "media_fallback", message: '<img src=x onerror="alert(1)"> Kept as a link.' }],
        },
      }),
    });

    await page.ready;

    expect(document.querySelector("#status-details")?.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(document.querySelector("#status-details img")).toBeNull();
  });

  it("renders typed error details from local storage", async () => {
    document.body.innerHTML = '<main><div id="status-details" aria-live="polite"></div><button id="retry-save">Retry save</button></main>';
    const page = mountStatusPage(document, {
      retrySave: vi.fn(),
      loadStatus: vi.fn().mockResolvedValue({
        tabId: 17,
        status: {
          tabId: 17,
          kind: "error",
          details: [{ code: "destination_unconfigured", message: "Choose an absolute destination before saving." }],
        },
      }),
    });

    await page.ready;

    expect(document.querySelector("#status-details")?.textContent).toBe(
      "destination_unconfigured: Choose an absolute destination before saving.",
    );
  });

  it("retries the captured popup tab and re-enables the button after success", async () => {
    document.body.innerHTML = '<main><div id="status-details" aria-live="polite"></div><button id="retry-save">Retry save</button></main>';
    const retrySave = vi.fn().mockResolvedValue({ ok: true });
    const page = mountStatusPage(document, {
      loadStatus: vi.fn().mockResolvedValue({
        tabId: 17,
        status: { tabId: 17, kind: "error", details: [{ code: "save_failed", message: "Retry." }] },
      }),
      retrySave,
    });
    await page.ready;

    document.querySelector<HTMLButtonElement>("#retry-save")!.click();
    await vi.waitFor(() => expect(retrySave).toHaveBeenCalledWith(17));

    expect(document.querySelector<HTMLButtonElement>("#retry-save")?.disabled).toBe(false);
  });

  it("renders a typed retry failure and always re-enables the button", async () => {
    document.body.innerHTML = '<main><div id="status-details" aria-live="polite"></div><button id="retry-save">Retry save</button></main>';
    const page = mountStatusPage(document, {
      loadStatus: vi.fn().mockResolvedValue({
        tabId: 17,
        status: { tabId: 17, kind: "error", details: [{ code: "save_failed", message: "Retry." }] },
      }),
      retrySave: vi.fn().mockResolvedValue({
        ok: false,
        code: "save_busy",
        message: "Another article save is already in progress.",
      }),
    });
    await page.ready;

    const button = document.querySelector<HTMLButtonElement>("#retry-save")!;
    button.click();
    await vi.waitFor(() => expect(button.disabled).toBe(false));

    expect(document.querySelector("#status-details")?.textContent).toBe(
      "Retry failed: Another article save is already in progress.",
    );
  });

  it("loads the exact per-tab key so A still sees its status after B writes", async () => {
    document.body.innerHTML = '<main><div id="status-details" aria-live="polite"></div><button id="retry-save">Retry save</button></main>';
    const records: Record<string, unknown> = {};
    records[statusStorageKey(41)] = {
      tabId: 41,
      kind: "error",
      details: [{ code: "tab_a", message: "Status for A." }],
    };
    records[statusStorageKey(42)] = {
      tabId: 42,
      kind: "error",
      details: [{ code: "tab_b", message: "Status for B." }],
    };
    const browser = {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 41 }]) },
      storage: {
        local: {
          get: vi.fn().mockImplementation(async (key: string) => ({ [key]: records[key] })),
        },
      },
    };
    const page = mountStatusPage(document, {
      loadStatus: () => loadStatusForActiveTab(browser),
      retrySave: vi.fn(),
    });
    await page.ready;

    expect(browser.storage.local.get).toHaveBeenCalledWith(statusStorageKey(41));
    expect(document.querySelector("#status-details")?.textContent).toBe("tab_a: Status for A.");
    expect(document.body.textContent).not.toContain("Status for B.");
  });
});
