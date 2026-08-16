export interface StatusDetail {
  code: string;
  message: string;
}

export interface StatusBrowserAdapter {
  setBadgeText(details: { tabId: number; text: string }): Promise<void> | void;
  setPopup(details: { tabId: number; popup: string }): Promise<void> | void;
  setLocal(value: { kind: "warning" | "error"; details: readonly StatusDetail[] }): Promise<void> | void;
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

  async saving(tabId: number): Promise<void> {
    await this.browser.setBadgeText({ tabId, text: "…" });
    await this.browser.setPopup({ tabId, popup: "" });
  }

  async success(tabId: number): Promise<void> {
    await this.browser.setBadgeText({ tabId, text: "✓" });
    await this.browser.setPopup({ tabId, popup: "" });
  }

  async warning(tabId: number, details: readonly StatusDetail[]): Promise<void> {
    await this.browser.setBadgeText({ tabId, text: "!" });
    await this.browser.setLocal({ kind: "warning", details });
    await this.browser.setPopup({ tabId, popup: "status.html" });
  }

  async error(tabId: number, detail: StatusDetail): Promise<void> {
    await this.browser.setBadgeText({ tabId, text: "!" });
    await this.browser.setLocal({ kind: "error", details: [detail] });
    await this.browser.setPopup({ tabId, popup: "status.html" });
  }
}
