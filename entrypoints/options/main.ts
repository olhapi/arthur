import { browser } from "wxt/browser";

import { connectNativeClient } from "../../src/background/native-client.js";
import { ArthurSettingsSchema, type ArthurSettings } from "../../src/shared/settings.js";

export interface OptionsStorage {
  getSettings(): Promise<unknown>;
  saveSettings(settings: ArthurSettings): Promise<void>;
}

export interface ConnectionStatus {
  kind: "success" | "error";
  message: string;
}

export interface ConnectionResult {
  host: ConnectionStatus;
  folder: ConnectionStatus;
}

export interface OptionsDependencies {
  storage: OptionsStorage;
  testConnection(destination: string): Promise<ConnectionResult>;
  chooseDestination?(): Promise<string | undefined>;
}

export interface OptionsPage {
  ready: Promise<void>;
}

function requiredElement<ElementType extends Element>(document: Document, selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (element === null) throw new Error(`Missing required options element: ${selector}`);
  return element;
}

function renderStatus(element: HTMLElement, status: ConnectionStatus): void {
  element.dataset.kind = status.kind;
  const copy = element.querySelector<HTMLElement>(".status-copy");
  if (copy === null) element.textContent = status.message;
  else copy.textContent = status.message;
}

function validateDestination(value: string): ArthurSettings | undefined {
  const parsed = ArthurSettingsSchema.safeParse({ destination: value });
  return parsed.success ? parsed.data : undefined;
}

/** Mounts the options UI with browser operations supplied at its boundary. */
export function mountOptionsPage(document: Document, dependencies: OptionsDependencies): OptionsPage {
  const form = requiredElement<HTMLFormElement>(document, "#options-form");
  const destination = requiredElement<HTMLInputElement>(document, "#destination");
  const chooseDestination = requiredElement<HTMLButtonElement>(document, "#choose-destination");
  const testConnection = requiredElement<HTMLButtonElement>(document, "#test-connection");
  const hostStatus = requiredElement<HTMLElement>(document, "#host-status");
  const folderStatus = requiredElement<HTMLElement>(document, "#folder-status");

  const invalidDestination = (): void => {
    destination.setCustomValidity("Destination must be an absolute path.");
    renderStatus(folderStatus, { kind: "error", message: "Destination must be an absolute path." });
  };
  const parseInput = (): ArthurSettings | undefined => {
    const settings = validateDestination(destination.value);
    if (settings === undefined) invalidDestination();
    else destination.setCustomValidity("");
    return settings;
  };

  destination.addEventListener("input", () => destination.setCustomValidity(""));

  chooseDestination.addEventListener("click", async () => {
    if (dependencies.chooseDestination === undefined) return;
    chooseDestination.disabled = true;
    renderStatus(folderStatus, { kind: "success", message: "Opening folder picker…" });
    try {
      const selected = await dependencies.chooseDestination();
      if (selected === undefined) {
        renderStatus(folderStatus, { kind: "error", message: "No folder was selected." });
        return;
      }
      destination.value = selected;
      const settings = parseInput();
      if (settings === undefined) return;
      await dependencies.storage.saveSettings(settings);
      renderStatus(folderStatus, { kind: "success", message: "Settings saved." });
    } catch {
      renderStatus(hostStatus, { kind: "error", message: "Native helper is unavailable." });
      renderStatus(folderStatus, { kind: "error", message: "Folder picker could not be opened." });
    } finally {
      chooseDestination.disabled = false;
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const settings = parseInput();
    if (settings === undefined) return;
    await dependencies.storage.saveSettings(settings);
    renderStatus(folderStatus, { kind: "success", message: "Settings saved." });
  });

  testConnection.addEventListener("click", async () => {
    const settings = parseInput();
    if (settings === undefined) return;
    testConnection.disabled = true;
    try {
      const result = await dependencies.testConnection(settings.destination);
      renderStatus(hostStatus, result.host);
      renderStatus(folderStatus, result.folder);
    } catch {
      renderStatus(hostStatus, { kind: "error", message: "Native host is unavailable." });
      renderStatus(folderStatus, { kind: "error", message: "Destination could not be checked." });
    } finally {
      testConnection.disabled = false;
    }
  });

  const ready = dependencies.storage.getSettings().then((stored) => {
    const settings = ArthurSettingsSchema.safeParse(stored);
    if (settings.success) destination.value = settings.data.destination;
  });
  return { ready };
}

function browserStorage(): OptionsStorage {
  return {
    async getSettings(): Promise<unknown> {
      return (await browser.storage.local.get("settings")).settings;
    },
    async saveSettings(settings: ArthurSettings): Promise<void> {
      await browser.storage.local.set({ settings });
    },
  };
}

export interface NativeTestClient {
  hello(): Promise<unknown>;
  request(
    message:
      | { type: "test_destination"; requestId: string; destination: string }
      | { type: "choose_destination"; requestId: string },
  ): Promise<unknown>;
  close(): void;
}

export async function chooseNativeDestination(
  createClient: () => NativeTestClient = () =>
    connectNativeClient((hostName) => browser.runtime.connectNative(hostName)),
): Promise<string | undefined> {
  let client: NativeTestClient | undefined;
  try {
    client = createClient();
    await client.hello();
    const response = await client.request({ type: "choose_destination", requestId: crypto.randomUUID() });
    const settings = ArthurSettingsSchema.safeParse(
      typeof response === "object" && response !== null && (response as { type?: unknown }).type === "choose_destination_result"
        ? { destination: (response as { destination?: unknown }).destination }
        : undefined,
    );
    return settings.success ? settings.data.destination : undefined;
  } finally {
    client?.close();
  }
}

export async function testNativeConnection(
  destination: string,
  createClient: () => NativeTestClient = () =>
    connectNativeClient((hostName) => browser.runtime.connectNative(hostName)),
): Promise<ConnectionResult> {
  let client: NativeTestClient | undefined;
  try {
    client = createClient();
    await client.hello();
  } catch {
    client?.close();
    return {
      host: { kind: "error", message: "Native host is unavailable." },
      folder: { kind: "error", message: "Destination could not be checked." },
    };
  }

  try {
    const response = await client.request({
      type: "test_destination",
      requestId: crypto.randomUUID(),
      destination,
    });
    if (
      typeof response !== "object" ||
      response === null ||
      (response as { type?: unknown }).type !== "test_destination_result" ||
      typeof (response as { writable?: unknown }).writable !== "boolean"
    ) {
      return {
        host: { kind: "success", message: "Native host available." },
        folder: { kind: "error", message: "Destination could not be checked." },
      };
    }
    return {
      host: { kind: "success", message: "Native host available." },
      folder: (response as { writable: boolean }).writable
        ? { kind: "success", message: "Destination is writable." }
        : { kind: "error", message: "Destination is not writable." },
    };
  } catch {
    return {
      host: { kind: "success", message: "Native host available." },
      folder: { kind: "error", message: "Destination could not be checked." },
    };
  } finally {
    client?.close();
  }
}

if (document.querySelector("#options-form") !== null) {
  void mountOptionsPage(document, {
    storage: browserStorage(),
    testConnection: testNativeConnection,
    chooseDestination: chooseNativeDestination,
  }).ready;
}
