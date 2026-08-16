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
}

export interface SaveCoordinatorFacade {
  save(tabId: number, tabUrl: string): Promise<unknown>;
}

/** Wires toolbar clicks while keeping per-tab save serialization at the entrypoint boundary. */
export function createBackgroundController(
  browser: BackgroundBrowserFacade,
  coordinator: SaveCoordinatorFacade,
): void {
  const savingTabs = new Set<number>();

  browser.action.onClicked.addListener((clickedTab) => {
    void (async () => {
      const activeTabs = await browser.tabs.query({ active: true, currentWindow: true });
      const activeTab = activeTabs[0] ?? clickedTab;
      if (activeTab.id === undefined || activeTab.url === undefined || savingTabs.has(activeTab.id)) return;

      savingTabs.add(activeTab.id);
      try {
        await browser.action.setPopup({ tabId: activeTab.id, popup: "" });
        await coordinator.save(activeTab.id, activeTab.url);
      } finally {
        savingTabs.delete(activeTab.id);
      }
    })();
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
