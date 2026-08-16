// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

import { loadStatusForActiveTab, mountStatusPage } from "./main.js";

describe("mountStatusPage", () => {
  it("renders stored warning details as text rather than HTML", async () => {
    document.body.innerHTML = '<main><div id="status-details" aria-live="polite"></div><button id="retry-save">Retry save</button></main>';
    const page = mountStatusPage(document, {
      retrySave: vi.fn(),
      loadStatus: vi.fn().mockResolvedValue({
        tabId: 17,
        kind: "warning",
        details: [{ code: "media_fallback", message: '<img src=x onerror="alert(1)"> Kept as a link.' }],
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
        kind: "error",
        details: [{ code: "destination_unconfigured", message: "Choose an absolute destination before saving." }],
      }),
    });

    await page.ready;

    expect(document.querySelector("#status-details")?.textContent).toBe(
      "destination_unconfigured: Choose an absolute destination before saving.",
    );
  });

  it("offers an intentional retry that delegates to the background save flow", async () => {
    document.body.innerHTML = '<main><div id="status-details" aria-live="polite"></div><button id="retry-save">Retry save</button></main>';
    const retrySave = vi.fn().mockResolvedValue(undefined);
    const page = mountStatusPage(document, {
      loadStatus: vi.fn().mockResolvedValue({ tabId: 17, kind: "error", details: [{ code: "save_failed", message: "Retry." }] }),
      retrySave,
    });
    await page.ready;

    document.querySelector<HTMLButtonElement>("#retry-save")!.click();
    await Promise.resolve();

    expect(retrySave).toHaveBeenCalledOnce();
  });

  it("does not render status details that belong to another tab", async () => {
    document.body.innerHTML = '<main><div id="status-details" aria-live="polite"></div><button id="retry-save">Retry save</button></main>';
    const browser = {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({
            status: { tabId: 41, kind: "error", details: [{ code: "wrong_tab", message: "Private tab detail." }] },
          }),
        },
      },
    };
    const page = mountStatusPage(document, {
      loadStatus: () => loadStatusForActiveTab(browser),
      retrySave: vi.fn(),
    });
    await page.ready;

    expect(document.querySelector("#status-details")?.textContent).toBe("No recent save issues.");
    expect(document.body.textContent).not.toContain("Private tab detail.");
  });
});
