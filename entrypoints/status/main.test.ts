// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

import { mountStatusPage } from "./main.js";

describe("mountStatusPage", () => {
  it("renders stored warning details as text rather than HTML", async () => {
    document.body.innerHTML = '<main><div id="status-details" aria-live="polite"></div></main>';
    const page = mountStatusPage(document, {
      loadStatus: vi.fn().mockResolvedValue({
        kind: "warning",
        details: [{ code: "media_fallback", message: '<img src=x onerror="alert(1)"> Kept as a link.' }],
      }),
    });

    await page.ready;

    expect(document.querySelector("#status-details")?.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(document.querySelector("#status-details img")).toBeNull();
  });

  it("renders typed error details from local storage", async () => {
    document.body.innerHTML = '<main><div id="status-details" aria-live="polite"></div></main>';
    const page = mountStatusPage(document, {
      loadStatus: vi.fn().mockResolvedValue({
        kind: "error",
        details: [{ code: "destination_unconfigured", message: "Choose an absolute destination before saving." }],
      }),
    });

    await page.ready;

    expect(document.querySelector("#status-details")?.textContent).toBe(
      "destination_unconfigured: Choose an absolute destination before saving.",
    );
  });
});
