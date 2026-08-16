import { browser } from "wxt/browser";

export interface StoredStatus {
  tabId: number;
  kind: "warning" | "error";
  details: readonly { code: string; message: string }[];
}

export interface StatusDependencies {
  loadStatus(): Promise<unknown>;
  retrySave(): Promise<void>;
}

export interface StatusPage {
  ready: Promise<void>;
}

export interface StatusPageBrowser {
  tabs: { query(query: { active: boolean; currentWindow: boolean }): Promise<readonly { id?: number }[]> };
  storage: { local: { get(key: string): Promise<Record<string, unknown>> } };
}

export async function loadStatusForActiveTab(browser: StatusPageBrowser): Promise<unknown> {
  const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
  const stored = (await browser.storage.local.get("status")).status;
  if (activeTab?.id === undefined || typeof stored !== "object" || stored === null) return undefined;
  return (stored as { tabId?: unknown }).tabId === activeTab.id ? stored : undefined;
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

  retry.addEventListener("click", async () => {
    retry.disabled = true;
    try {
      await dependencies.retrySave();
    } finally {
      retry.disabled = false;
    }
  });

  const ready = dependencies.loadStatus().then((stored) => {
    const status = statusFrom(stored);
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
  });
  return { ready };
}

if (document.querySelector("#status-details") !== null) {
  void mountStatusPage(document, {
    async loadStatus(): Promise<unknown> {
      return loadStatusForActiveTab(browser as unknown as StatusPageBrowser);
    },
    async retrySave(): Promise<void> {
      await browser.runtime.sendMessage({ type: "retry_save" });
    },
  }).ready;
}
