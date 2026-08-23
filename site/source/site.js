import { SITE_CONFIG } from "./site-config.js";

const STORE_LABELS = Object.freeze({
  chrome: "Chrome",
  firefox: "Firefox",
});

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function isNativeRelease(value) {
  if (!value || typeof value !== "object") return false;
  const { version, url, sha256, sourceUrl } = value;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) return false;
  if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(sha256)) return false;
  if (!isHttpsUrl(sourceUrl) || !isHttpsUrl(url)) return false;

  const releasePath = `/olhapi/arthur/releases/download/v${version}/`;
  return new URL(url).hostname === "github.com" && new URL(url).pathname.startsWith(releasePath);
}

export function renderAvailability(config, documentRef) {
  for (const element of documentRef.querySelectorAll("[data-store]")) {
    const store = element.dataset.store;
    const url = config.stores[store];
    const label = STORE_LABELS[store] ?? store;

    if (!isHttpsUrl(url)) {
      element.removeAttribute("href");
      element.removeAttribute("target");
      element.setAttribute("aria-disabled", "true");
      element.textContent = `${label} — coming soon`;
      continue;
    }

    element.href = url;
    element.target = "_blank";
    element.rel = "noreferrer";
    element.removeAttribute("aria-disabled");
  }
}

export async function copyInstallCommand(button, clipboard, documentRef) {
  const selector = button?.dataset.copyCommand;
  const command = selector ? documentRef.querySelector(selector)?.textContent?.trim() : "";
  const status = documentRef.querySelector("[data-copy-status]");

  if (!command || !status) return;

  try {
    await clipboard.writeText(command);
    status.textContent = "Copied";
  } catch {
    status.textContent = "Select and copy the command";
  }
}

function initialise(documentRef) {
  renderAvailability(SITE_CONFIG, documentRef);
  for (const button of documentRef.querySelectorAll("[data-copy-command]")) {
    button.addEventListener("click", () => copyInstallCommand(button, navigator.clipboard, documentRef));
  }
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => initialise(document));
  } else {
    initialise(document);
  }
}
