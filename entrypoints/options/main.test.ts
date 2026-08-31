// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

import { chooseNativeDestination, mountOptionsPage, testNativeConnection } from "./main.js";

function optionsDocument(): Document {
  document.body.innerHTML = `
    <main>
      <form id="options-form">
        <label for="destination">Destination folder</label>
        <input id="destination" name="destination" type="text" required>
        <button id="choose-destination" type="button">Choose article folder</button>
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

  it("stores the folder selected by the native picker", async () => {
    const storage = {
      getSettings: vi.fn().mockResolvedValue(undefined),
      saveSettings: vi.fn().mockResolvedValue(undefined),
    };
    const chooseDestination = vi.fn().mockResolvedValue("/Users/olhapi/Library/Mobile Documents/iCloud~md~obsidian/Documents/engineering");
    const page = mountOptionsPage(optionsDocument(), {
      storage,
      testConnection: vi.fn(),
      chooseDestination,
    });
    await page.ready;

    document.querySelector<HTMLButtonElement>("#choose-destination")!.click();

    await vi.waitFor(() =>
      expect(storage.saveSettings).toHaveBeenCalledWith({
        destination: "/Users/olhapi/Library/Mobile Documents/iCloud~md~obsidian/Documents/engineering",
      }),
    );
    expect(document.querySelector<HTMLInputElement>("#destination")?.value).toBe(
      "/Users/olhapi/Library/Mobile Documents/iCloud~md~obsidian/Documents/engineering",
    );
    expect(document.querySelector("#folder-status")?.textContent).toBe("Settings saved.");
  });

  it("reports a native picker failure instead of leaving the button silent", async () => {
    const page = mountOptionsPage(optionsDocument(), {
      storage: { getSettings: vi.fn().mockResolvedValue(undefined), saveSettings: vi.fn() },
      testConnection: vi.fn(),
      chooseDestination: vi.fn().mockRejectedValue(new Error("native host unavailable")),
    });
    await page.ready;

    document.querySelector<HTMLButtonElement>("#choose-destination")!.click();

    await vi.waitFor(() =>
      expect(document.querySelector("#folder-status")?.textContent).toBe("Folder picker could not be opened."),
    );
    expect(document.querySelector("#host-status")?.textContent).toBe("Native helper is unavailable.");
    expect(document.querySelector<HTMLButtonElement>("#choose-destination")?.disabled).toBe(false);
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

  it("clears custom validity while editing so a corrected requestSubmit saves", async () => {
    const storage = {
      getSettings: vi.fn().mockResolvedValue(undefined),
      saveSettings: vi.fn().mockResolvedValue(undefined),
    };
    const page = mountOptionsPage(optionsDocument(), { storage, testConnection: vi.fn() });
    await page.ready;
    const input = document.querySelector<HTMLInputElement>("#destination")!;
    const form = document.querySelector<HTMLFormElement>("#options-form")!;

    input.value = "relative/clippings";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(input.validationMessage).toBe("Destination must be an absolute path.");

    input.value = "/Vault/Corrected";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(input.validationMessage).toBe("");
    form.requestSubmit();
    await vi.waitFor(() => expect(storage.saveSettings).toHaveBeenCalledWith({ destination: "/Vault/Corrected" }));
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

describe("testNativeConnection", () => {
  it("keeps the host available when only destination testing fails", async () => {
    const client = {
      hello: vi.fn().mockResolvedValue({ type: "hello_result" }),
      request: vi.fn().mockRejectedValue(new Error("destination denied")),
      close: vi.fn(),
    };

    await expect(testNativeConnection("/Vault/Denied", () => client)).resolves.toEqual({
      host: { kind: "success", message: "Native host available." },
      folder: { kind: "error", message: "Destination could not be checked." },
    });
    expect(client.close).toHaveBeenCalledOnce();
  });
});

describe("chooseNativeDestination", () => {
  it("returns the absolute folder supplied by the native picker", async () => {
    const client = {
      hello: vi.fn().mockResolvedValue({ type: "hello_result" }),
      request: vi.fn().mockResolvedValue({
        type: "choose_destination_result",
        requestId: "picker-1",
        destination: "/Users/olhapi/Library/Mobile Documents/iCloud~md~obsidian/Documents/engineering",
      }),
      close: vi.fn(),
    };

    await expect(chooseNativeDestination(() => client)).resolves.toBe(
      "/Users/olhapi/Library/Mobile Documents/iCloud~md~obsidian/Documents/engineering",
    );
    expect(client.close).toHaveBeenCalledOnce();
  });
});
