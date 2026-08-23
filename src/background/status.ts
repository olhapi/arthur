export interface StatusDetail {
  code: string;
  message: string;
}

const STATUS_STORAGE_PREFIX = "arthur-status:";

export type StatusIcon = "ready" | "saving" | "saved" | "attention";

const STATUS_ICON_PATHS: Readonly<Record<StatusIcon, Readonly<Record<number, string>>>> = {
  ready: { 16: "icons/arthur-ready-16.png", 32: "icons/arthur-ready-32.png", 48: "icons/arthur-ready-48.png", 128: "icons/arthur-ready-128.png" },
  saving: { 16: "icons/arthur-saving-16.png", 32: "icons/arthur-saving-32.png", 48: "icons/arthur-saving-48.png", 128: "icons/arthur-saving-128.png" },
  saved: { 16: "icons/arthur-saved-16.png", 32: "icons/arthur-saved-32.png", 48: "icons/arthur-saved-48.png", 128: "icons/arthur-saved-128.png" },
  attention: { 16: "icons/arthur-attention-16.png", 32: "icons/arthur-attention-32.png", 48: "icons/arthur-attention-48.png", 128: "icons/arthur-attention-128.png" },
};

export function statusStorageKey(tabId: number): string {
  return `${STATUS_STORAGE_PREFIX}${tabId}`;
}

export interface StatusBrowserAdapter {
  setIcon(details: { tabId: number; path: Readonly<Record<number, string>> }): Promise<void> | void;
  setPopup(details: { tabId: number; popup: string }): Promise<void> | void;
  setLocal(value: { tabId: number; kind: "warning" | "error"; details: readonly StatusDetail[] }): Promise<void> | void;
  clearLocal(tabId: number): Promise<void> | void;
}

export interface SaveStatus {
  ready(tabId: number): Promise<void>;
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

  private async setIcon(tabId: number, icon: StatusIcon): Promise<void> {
    await this.browser.setIcon({ tabId, path: STATUS_ICON_PATHS[icon] });
  }

  async ready(tabId: number): Promise<void> {
    await this.setIcon(tabId, "ready");
    await this.browser.setPopup({ tabId, popup: "" });
    await this.clearLocalBestEffort(tabId);
  }

  async saving(tabId: number): Promise<void> {
    await this.setIcon(tabId, "saving");
    await this.browser.setPopup({ tabId, popup: "" });
    await this.clearLocalBestEffort(tabId);
  }

  async success(tabId: number): Promise<void> {
    await this.setIcon(tabId, "saved");
    await this.browser.setPopup({ tabId, popup: "" });
    await this.clearLocalBestEffort(tabId);
  }

  async warning(tabId: number, details: readonly StatusDetail[]): Promise<void> {
    await this.setIcon(tabId, "attention");
    await this.browser.setLocal({ tabId, kind: "warning", details });
    await this.browser.setPopup({ tabId, popup: `status.html?tabId=${tabId}` });
  }

  async error(tabId: number, detail: StatusDetail): Promise<void> {
    await this.setIcon(tabId, "attention");
    await this.browser.setLocal({ tabId, kind: "error", details: [detail] });
    await this.browser.setPopup({ tabId, popup: `status.html?tabId=${tabId}` });
  }
}
