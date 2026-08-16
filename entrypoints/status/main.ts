import { browser } from "wxt/browser";

export interface StoredStatus {
  kind: "warning" | "error";
  details: readonly { code: string; message: string }[];
}

export interface StatusDependencies {
  loadStatus(): Promise<unknown>;
}

export interface StatusPage {
  ready: Promise<void>;
}

function statusFrom(value: unknown): StoredStatus | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as { kind?: unknown; details?: unknown };
  if ((candidate.kind !== "warning" && candidate.kind !== "error") || !Array.isArray(candidate.details)) return undefined;
  const details = candidate.details.flatMap((detail) => {
    if (typeof detail !== "object" || detail === null) return [];
    const item = detail as { code?: unknown; message?: unknown };
    if (typeof item.code !== "string" || typeof item.message !== "string") return [];
    return [{ code: item.code, message: item.message }];
  });
  return { kind: candidate.kind, details };
}

/** Renders untrusted local status only through text nodes. */
export function mountStatusPage(document: Document, dependencies: StatusDependencies): StatusPage {
  const details = document.querySelector<HTMLElement>("#status-details");
  if (details === null) throw new Error("Missing required status element: #status-details");

  const ready = dependencies.loadStatus().then((stored) => {
    const status = statusFrom(stored);
    details.replaceChildren();
    if (status === undefined || status.details.length === 0) {
      details.textContent = "No recent save issues.";
      return;
    }
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
      return (await browser.storage.local.get("status")).status;
    },
  }).ready;
}
