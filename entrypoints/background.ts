import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";

import type { ExtractedArticle } from "../src/article/extract.js";
import { SaveCoordinator } from "../src/background/save-coordinator.js";
import { connectNativeClient } from "../src/background/native-client.js";
import { StatusController } from "../src/background/status.js";

export interface ActiveTab {
  id?: number;
  url?: string;
}

export interface BackgroundBrowserFacade {
  action: {
    onClicked: { addListener(listener: (tab: ActiveTab) => void): void };
    setPopup(details: { tabId: number; popup: string }): Promise<void> | void;
  };
  tabs: {
    query(query: { active: boolean; currentWindow: boolean }): Promise<readonly ActiveTab[]>;
  };
  runtime: {
    onMessage: {
      addListener(
        listener: (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean | undefined,
      ): void;
    };
  };
}

export interface SaveCoordinatorFacade {
  save(tabId: number, tabUrl: string): Promise<unknown>;
}

/** Wires toolbar clicks while serializing access to the coordinator's one native client. */
export function createBackgroundController(
  browser: BackgroundBrowserFacade,
  coordinator: SaveCoordinatorFacade,
): void {
  let saving = false;

  const saveActiveTab = async (clickedTab: ActiveTab = {}): Promise<void> => {
    const activeTabs = await browser.tabs.query({ active: true, currentWindow: true });
    const activeTab = activeTabs[0] ?? clickedTab;
    if (activeTab.id === undefined || activeTab.url === undefined || saving) return;

    saving = true;
    try {
      await browser.action.setPopup({ tabId: activeTab.id, popup: "" });
      await coordinator.save(activeTab.id, activeTab.url);
    } finally {
      saving = false;
    }
  };

  browser.action.onClicked.addListener((clickedTab) => {
    void saveActiveTab(clickedTab);
  });
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (typeof message !== "object" || message === null || (message as { type?: unknown }).type !== "retry_save") {
      return undefined;
    }
    void saveActiveTab().then(() => sendResponse({ ok: true }));
    return true;
  });
}

function createProductionCoordinator(): SaveCoordinator {
  const status = new StatusController({
    setBadgeText: (details) => browser.action.setBadgeText(details),
    setPopup: (details) => browser.action.setPopup(details),
    setLocal: async (value) => {
      await browser.storage.local.set({ status: value });
    },
  });
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
  createBackgroundController(browser as unknown as BackgroundBrowserFacade, createProductionCoordinator());
});
