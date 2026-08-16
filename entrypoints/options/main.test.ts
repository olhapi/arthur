// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

import { mountOptionsPage } from "./main.js";

function optionsDocument(): Document {
  document.body.innerHTML = `
    <main>
      <form id="options-form">
        <label for="destination">Destination folder</label>
        <input id="destination" name="destination" type="text" required>
        <button type="submit">Save settings</button>
      </form>
      <button id="test-connection" type="button">Test connection</button>
      <p id="host-status" aria-live="polite"></p>
      <p id="folder-status" aria-live="polite"></p>
    </main>`;
  return document;
}

describe("mountOptionsPage", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("loads saved settings and saves a valid absolute destination", async () => {
    const storage = {
      getSettings: vi.fn().mockResolvedValue({ destination: "/Vault/Existing" }),
      saveSettings: vi.fn().mockResolvedValue(undefined),
    };

    const page = mountOptionsPage(optionsDocument(), {
      storage,
      testConnection: vi.fn(),
    });
    await page.ready;

    const input = document.querySelector<HTMLInputElement>("#destination");
    const form = document.querySelector<HTMLFormElement>("#options-form");
    expect(input?.value).toBe("/Vault/Existing");

    input!.value = "/Vault/Clippings";
    form!.dispatchEvent(new Event("submit", { cancelable: true }));
    await Promise.resolve();

    expect(storage.saveSettings).toHaveBeenCalledWith({ destination: "/Vault/Clippings" });
    expect(document.querySelector("#folder-status")?.textContent).toBe("Settings saved.");
  });

  it("rejects empty and relative destinations without saving", async () => {
    const storage = {
      getSettings: vi.fn().mockResolvedValue(undefined),
      saveSettings: vi.fn(),
    };
    const page = mountOptionsPage(optionsDocument(), { storage, testConnection: vi.fn() });
    await page.ready;

    const input = document.querySelector<HTMLInputElement>("#destination");
    const form = document.querySelector<HTMLFormElement>("#options-form");
    for (const value of ["", "relative/clippings"]) {
      input!.value = value;
      form!.dispatchEvent(new Event("submit", { cancelable: true }));
      expect(storage.saveSettings).not.toHaveBeenCalled();
      expect(document.querySelector("#folder-status")?.textContent).toBe("Destination must be an absolute path.");
    }
  });

  it("tests native-host and destination access with the entered absolute path", async () => {
    const testConnection = vi.fn().mockResolvedValue({
      host: { kind: "success", message: "Native host available." },
      folder: { kind: "success", message: "Destination is writable." },
    });
    const page = mountOptionsPage(optionsDocument(), {
      storage: { getSettings: vi.fn().mockResolvedValue(undefined), saveSettings: vi.fn() },
      testConnection,
    });
    await page.ready;

    const input = document.querySelector<HTMLInputElement>("#destination");
    input!.value = "/Vault/Clippings";
    document.querySelector<HTMLButtonElement>("#test-connection")!.click();
    await Promise.resolve();

    expect(testConnection).toHaveBeenCalledWith("/Vault/Clippings");
    expect(document.querySelector("#host-status")?.textContent).toBe("Native host available.");
    expect(document.querySelector("#folder-status")?.textContent).toBe("Destination is writable.");
  });
});
