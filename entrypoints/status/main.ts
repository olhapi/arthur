import { browser } from "wxt/browser";

import { statusStorageKey } from "../../src/background/status.js";
import type { RetrySaveResult } from "../background.js";

export interface StoredStatus {
  tabId: number;
  kind: "warning" | "error";
  details: readonly { code: string; message: string }[];
}

export interface StatusDependencies {
  loadStatus(): Promise<{ tabId: number; status: unknown } | undefined>;
  retrySave(tabId: number): Promise<RetrySaveResult>;
  tabIdHint?: number | undefined;
  clearPopup?(tabId: number | undefined): Promise<void>;
}

export interface StatusPage {
  ready: Promise<void>;
}

export interface StatusPageBrowser {
  tabs: { query(query: { active: boolean; currentWindow: boolean }): Promise<readonly { id?: number }[]> };
  storage: { local: { get(key: string): Promise<Record<string, unknown>> } };
}

interface StatusActionFacade {
  setPopup(details: { tabId?: number; popup: string }): Promise<void> | void;
}

interface StatusPopupBrowser extends StatusPageBrowser {
  action?: StatusActionFacade;
  browserAction?: StatusActionFacade;
}

export function tabIdHintFromUrl(value: string): number | undefined {
  try {
    const url = new URL(value);
    if (url.searchParams.size !== 1) return undefined;
    const raw = url.searchParams.get("tabId");
    if (raw === null || !/^\d+$/.test(raw)) return undefined;
    const tabId = Number(raw);
    return Number.isSafeInteger(tabId) ? tabId : undefined;
  } catch {
    return undefined;
  }
}

export async function loadStatusForActiveTab(
  browser: StatusPageBrowser,
): Promise<{ tabId: number; status: unknown } | undefined> {
  const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.id === undefined) return undefined;
  const key = statusStorageKey(activeTab.id);
  const stored = (await browser.storage.local.get(key))[key];
  return { tabId: activeTab.id, status: stored };
}

function statusFrom(value: unknown): StoredStatus | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as { tabId?: unknown; kind?: unknown; details?: unknown };
  if (
    typeof candidate.tabId !== "number" ||
    (candidate.kind !== "warning" && candidate.kind !== "error") ||
    !Array.isArray(candidate.details)
  ) return undefined;
  const details = candidate.details.flatMap((detail) => {
    if (typeof detail !== "object" || detail === null) return [];
    const item = detail as { code?: unknown; message?: unknown };
    if (typeof item.code !== "string" || typeof item.message !== "string") return [];
    return [{ code: item.code, message: item.message }];
  });
  return { tabId: candidate.tabId, kind: candidate.kind, details };
}

/** Renders untrusted local status only through text nodes. */
export function mountStatusPage(document: Document, dependencies: StatusDependencies): StatusPage {
  const details = document.querySelector<HTMLElement>("#status-details");
  if (details === null) throw new Error("Missing required status element: #status-details");
  const retry = document.querySelector<HTMLButtonElement>("#retry-save");
  if (retry === null) throw new Error("Missing required status element: #retry-save");

  let retryTabId: number | undefined;
  const renderRetryFailure = (message: string): void => {
    details.dataset.kind = "error";
    details.textContent = `Retry failed: ${message}`;
  };

  retry.addEventListener("click", async () => {
    retry.disabled = true;
    try {
      if (retryTabId === undefined) {
        renderRetryFailure("The original tab is no longer available.");
        return;
      }
      const result = await dependencies.retrySave(retryTabId);
      if (!result.ok) renderRetryFailure(result.message);
    } catch {
      renderRetryFailure("The article could not be saved.");
    } finally {
      retry.disabled = false;
    }
  });

  const ready = dependencies.loadStatus().then(
    (loaded) => {
      retryTabId = loaded?.tabId;
      const candidate = statusFrom(loaded?.status);
      const status = candidate?.tabId === loaded?.tabId ? candidate : undefined;
      details.replaceChildren();
      if (status === undefined || status.details.length === 0) {
        details.textContent = "No recent save issues.";
        return;
      }
      details.dataset.kind = status.kind;
      const list = document.createElement("ul");
      for (const detail of status.details) {
        const item = document.createElement("li");
        item.textContent = `${detail.code}: ${detail.message}`;
        list.append(item);
      }
      details.append(list);
    },
    async () => {
      details.dataset.kind = "error";
      details.textContent = "Status unavailable: Arthur could not load this tab's status.";
      retry.disabled = true;
      await dependencies.clearPopup?.(dependencies.tabIdHint).catch(() => undefined);
    },
  );
  return { ready };
}

if (document.querySelector("#status-details") !== null) {
  const popupBrowser = browser as unknown as StatusPopupBrowser;
  void mountStatusPage(document, {
    tabIdHint: tabIdHintFromUrl(location.href),
    async clearPopup(tabId: number | undefined): Promise<void> {
      const action = popupBrowser.action ?? popupBrowser.browserAction;
      if (action === undefined) return;
      await action.setPopup(tabId === undefined ? { popup: "" } : { tabId, popup: "" });
    },
    async loadStatus(): Promise<{ tabId: number; status: unknown } | undefined> {
      return loadStatusForActiveTab(browser as unknown as StatusPageBrowser);
    },
    async retrySave(tabId: number): Promise<RetrySaveResult> {
      const response: unknown = await browser.runtime.sendMessage({ type: "retry_save", tabId });
      if (typeof response !== "object" || response === null) {
        return { ok: false, code: "save_failed", message: "The article could not be saved." };
      }
      const candidate = response as { ok?: unknown; code?: unknown; message?: unknown };
      if (Object.keys(response).length === 1 && candidate.ok === true) return { ok: true };
      if (
        Object.keys(response).length === 3 &&
        candidate.ok === false &&
        (candidate.code === "save_busy" || candidate.code === "tab_unavailable" || candidate.code === "save_failed") &&
        typeof candidate.message === "string" &&
        candidate.message !== ""
      ) {
        return { ok: false, code: candidate.code, message: candidate.message };
      }
      return { ok: false, code: "save_failed", message: "The article could not be saved." };
    },
  }).ready;
}
