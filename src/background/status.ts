export interface StatusDetail {
  code: string;
  message: string;
}

const STATUS_STORAGE_PREFIX = "arthur-status:";

export function statusStorageKey(tabId: number): string {
  return `${STATUS_STORAGE_PREFIX}${tabId}`;
}

export interface StatusBrowserAdapter {
  setBadgeText(details: { tabId: number; text: string }): Promise<void> | void;
  setPopup(details: { tabId: number; popup: string }): Promise<void> | void;
  setLocal(value: { tabId: number; kind: "warning" | "error"; details: readonly StatusDetail[] }): Promise<void> | void;
  clearLocal(tabId: number): Promise<void> | void;
}

export interface SaveStatus {
  saving(tabId: number): Promise<void>;
  success(tabId: number): Promise<void>;
  warning(tabId: number, details: readonly StatusDetail[]): Promise<void>;
  error(tabId: number, detail: StatusDetail): Promise<void>;
}

/** Keeps browser UI state small and stores local detail only when actionable. */
export class StatusController implements SaveStatus {
  constructor(private readonly browser: StatusBrowserAdapter) {}

  private async clearLocalBestEffort(tabId: number): Promise<void> {
    await Promise.resolve(this.browser.clearLocal(tabId)).catch(() => undefined);
  }

  async saving(tabId: number): Promise<void> {
    await this.browser.setBadgeText({ tabId, text: "…" });
    await this.browser.setPopup({ tabId, popup: "" });
    await this.clearLocalBestEffort(tabId);
  }

  async success(tabId: number): Promise<void> {
    await this.browser.setBadgeText({ tabId, text: "✓" });
    await this.browser.setPopup({ tabId, popup: "" });
    await this.clearLocalBestEffort(tabId);
  }

  async warning(tabId: number, details: readonly StatusDetail[]): Promise<void> {
    await this.browser.setBadgeText({ tabId, text: "!" });
    await this.browser.setLocal({ tabId, kind: "warning", details });
    await this.browser.setPopup({ tabId, popup: `status.html?tabId=${tabId}` });
  }

  async error(tabId: number, detail: StatusDetail): Promise<void> {
    await this.browser.setBadgeText({ tabId, text: "!" });
    await this.browser.setLocal({ tabId, kind: "error", details: [detail] });
    await this.browser.setPopup({ tabId, popup: `status.html?tabId=${tabId}` });
  }
}
