import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";

import type { ExtractedArticle } from "../src/article/extract.js";
import { SaveCoordinator } from "../src/background/save-coordinator.js";
import { connectNativeClient } from "../src/background/native-client.js";
import {
  StatusController,
  statusStorageKey,
  type StatusBrowserAdapter,
} from "../src/background/status.js";

export interface ActiveTab {
  id?: number;
  url?: string;
}

export interface ToolbarActionFacade {
  onClicked: { addListener(listener: (tab: ActiveTab) => void): void };
  setPopup(details: { tabId: number; popup: string }): Promise<void> | void;
}

export interface BackgroundBrowserFacade {
  action?: ToolbarActionFacade;
  browserAction?: ToolbarActionFacade;
  tabs: {
    query(query: { active: boolean; currentWindow: boolean }): Promise<readonly ActiveTab[]>;
    get(tabId: number): Promise<ActiveTab>;
  };
  runtime: {
    id: string;
    getURL(path: string): string;
    onMessage: {
      addListener(
        listener: (
          message: unknown,
          sender: { id?: string; url?: string },
          sendResponse: (response: unknown) => void,
        ) => boolean | undefined,
      ): void;
    };
  };
}

export interface SaveCoordinatorFacade {
  save(tabId: number, tabUrl: string): Promise<{ status: "success" | "warning" | "error" } | unknown>;
}

export type RetrySaveResult =
  | { ok: true }
  | { ok: false; code: "save_busy" | "tab_unavailable" | "save_failed"; message: string };

export interface StatusBrowserFacade {
  action?: {
    setBadgeText(details: { tabId: number; text: string }): Promise<void> | void;
    setPopup(details: { tabId: number; popup: string }): Promise<void> | void;
  };
  browserAction?: {
    setBadgeText(details: { tabId: number; text: string }): Promise<void> | void;
    setPopup(details: { tabId: number; popup: string }): Promise<void> | void;
  };
  storage: {
    local: {
      set(values: Record<string, unknown>): Promise<void> | void;
      remove(key: string): Promise<void> | void;
    };
  };
}

export function createStatusBrowserAdapter(browser: StatusBrowserFacade): StatusBrowserAdapter {
  const action = browser.action ?? browser.browserAction;
  if (action === undefined) throw new Error("Arthur requires a browser action API.");
  return {
    setBadgeText: (details) => action.setBadgeText(details),
    setPopup: (details) => action.setPopup(details),
    setLocal: async (value) => {
      await browser.storage.local.set({ [statusStorageKey(value.tabId)]: value });
    },
    clearLocal: async (tabId) => {
      await browser.storage.local.remove(statusStorageKey(tabId));
    },
  };
}

export interface StatusCleanupBrowser {
  tabs: { onRemoved: { addListener(listener: (tabId: number) => void): void } };
  storage: { local: { remove(key: string): Promise<void> | void } };
}

export function registerStatusCleanup(browser: StatusCleanupBrowser): void {
  void Promise.resolve(browser.storage.local.remove("status")).catch(() => undefined);
  browser.tabs.onRemoved.addListener((tabId) => {
    void Promise.resolve(browser.storage.local.remove(statusStorageKey(tabId))).catch(() => undefined);
  });
}

function isRetrySaveMessage(message: unknown): message is { type: "retry_save"; tabId: number } {
  if (typeof message !== "object" || message === null) return false;
  const candidate = message as { type?: unknown; tabId?: unknown };
  return (
    Object.keys(message).length === 2 &&
    candidate.type === "retry_save" &&
    typeof candidate.tabId === "number" &&
    Number.isInteger(candidate.tabId) &&
    candidate.tabId >= 0
  );
}

function isTrustedStatusSender(
  sender: { id?: string; url?: string },
  runtime: Pick<BackgroundBrowserFacade["runtime"], "id" | "getURL">,
  tabId: number,
): boolean {
  if (sender.id !== runtime.id || sender.url === undefined) return false;
  try {
    const senderUrl = new URL(sender.url);
    const statusUrl = new URL(runtime.getURL("status.html"));
    return (
      senderUrl.origin === statusUrl.origin &&
      senderUrl.pathname === statusUrl.pathname &&
      senderUrl.hash === "" &&
      senderUrl.searchParams.size === 1 &&
      senderUrl.searchParams.get("tabId") === String(tabId)
    );
  } catch {
    return false;
  }
}

function isSavableTabUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** Wires toolbar clicks while serializing access to the coordinator's one native client. */
export function createBackgroundController(
  browser: BackgroundBrowserFacade,
  coordinator: SaveCoordinatorFacade,
): void {
  const action = browser.action ?? browser.browserAction;
  if (action === undefined) throw new Error("Arthur requires a browser action API.");
  let saving = false;

  const saveTab = async (tab: Required<Pick<ActiveTab, "id" | "url">>): Promise<RetrySaveResult> => {
    if (saving) {
      return { ok: false, code: "save_busy", message: "Another article save is already in progress." };
    }
    saving = true;
    try {
      await action.setPopup({ tabId: tab.id, popup: "" });
      const outcome = await coordinator.save(tab.id, tab.url);
      if (typeof outcome === "object" && outcome !== null && (outcome as { status?: unknown }).status === "error") {
        return { ok: false, code: "save_failed", message: "The article could not be saved." };
      }
      return { ok: true };
    } catch {
      return { ok: false, code: "save_failed", message: "The article could not be saved." };
    } finally {
      saving = false;
    }
  };

  const saveActiveTab = async (clickedTab: ActiveTab = {}): Promise<void> => {
    let activeTab: ActiveTab;
    try {
      const activeTabs = await browser.tabs.query({ active: true, currentWindow: true });
      activeTab = activeTabs[0] ?? clickedTab;
    } catch {
      return;
    }
    if (activeTab.id === undefined || activeTab.url === undefined) return;
    await saveTab({ id: activeTab.id, url: activeTab.url });
  };

  const retryTab = async (tabId: number): Promise<RetrySaveResult> => {
    if (saving) {
      return { ok: false, code: "save_busy", message: "Another article save is already in progress." };
    }
    let tab: ActiveTab;
    try {
      tab = await browser.tabs.get(tabId);
    } catch {
      return { ok: false, code: "tab_unavailable", message: "The original tab is no longer available." };
    }
    if (tab.id !== tabId || typeof tab.url !== "string" || !isSavableTabUrl(tab.url)) {
      await Promise.resolve(action.setPopup({ tabId, popup: "" })).catch(() => undefined);
      return { ok: false, code: "tab_unavailable", message: "The original tab is no longer available." };
    }
    return saveTab({ id: tabId, url: tab.url });
  };

  action.onClicked.addListener((clickedTab) => {
    void saveActiveTab(clickedTab);
  });
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isRetrySaveMessage(message) || !isTrustedStatusSender(sender, browser.runtime, message.tabId)) {
      return undefined;
    }
    void retryTab(message.tabId).then(sendResponse);
    return true;
  });
}

function createProductionCoordinator(): SaveCoordinator {
  const status = new StatusController(createStatusBrowserAdapter(browser as unknown as StatusBrowserFacade));
  return new SaveCoordinator({
    loadSettings: async () => (await browser.storage.local.get("settings")).settings,
    extract: async (tabId): Promise<ExtractedArticle> =>
      (await browser.tabs.sendMessage(tabId, { type: "extract_article" })) as ExtractedArticle,
    fetcher: fetch,
    nativeClient: connectNativeClient((hostName) => browser.runtime.connectNative(hostName)),
    status,
  });
}

export default defineBackground(() => {
  registerStatusCleanup(browser as unknown as StatusCleanupBrowser);
  createBackgroundController(browser as unknown as BackgroundBrowserFacade, createProductionCoordinator());
});
