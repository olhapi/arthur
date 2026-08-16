import { MEDIA_LIMITS } from "../shared/constants.js";

export type MediaKind = keyof typeof MEDIA_LIMITS;

const STREAM_EXTENSIONS = new Set(["m3u8", "mpd"]);
const IMAGE_EXTENSIONS = new Set(["avif", "gif", "jpeg", "jpg", "png", "svg", "webp"]);
const AUDIO_EXTENSIONS = new Set(["aac", "flac", "m4a", "mp3", "ogg", "opus", "wav", "weba"]);
const VIDEO_EXTENSIONS = new Set(["m4v", "mov", "mp4", "ogv", "webm"]);

function isHttpUrl(value: string, baseUrl?: string): string | undefined {
  try {
    const url = baseUrl === undefined ? new URL(value) : new URL(value, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function extensionFor(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const extension = pathname.split(".").pop();
    return extension?.toLowerCase() ?? "";
  } catch {
    return "";
  }
}

export function classifyMedia(
  url: string,
  tagName: string,
  contentType?: string,
): MediaKind | "stream" | "unsupported" {
  if (isHttpUrl(url) === undefined) {
    return "unsupported";
  }

  const extension = extensionFor(url);
  const normalizedContentType = contentType?.toLowerCase().split(";", 1)[0]?.trim();
  if (
    STREAM_EXTENSIONS.has(extension) ||
    normalizedContentType === "application/vnd.apple.mpegurl" ||
    normalizedContentType === "application/x-mpegurl" ||
    normalizedContentType === "application/dash+xml"
  ) {
    return "stream";
  }

  if (IMAGE_EXTENSIONS.has(extension) || tagName.toUpperCase() === "IMG") {
    return "image";
  }
  if (AUDIO_EXTENSIONS.has(extension) || tagName.toUpperCase() === "AUDIO") {
    return "audio";
  }
  if (VIDEO_EXTENSIONS.has(extension) || tagName.toUpperCase() === "VIDEO") {
    return "video";
  }
  return "unsupported";
}

function materializeAttribute(element: Element, attribute: "src" | "poster", baseUrl: string): void {
  const raw = element.getAttribute(attribute);
  if (raw === null) {
    return;
  }

  const resolved = isHttpUrl(raw, baseUrl);
  if (resolved === undefined) {
    element.removeAttribute(attribute);
    return;
  }
  element.setAttribute(attribute, resolved);
}

function renderedSource(element: HTMLImageElement | HTMLAudioElement | HTMLVideoElement): string | undefined {
  const current = element.currentSrc;
  return current === "" ? undefined : isHttpUrl(current);
}

function replaceIframeWithLink(iframe: HTMLIFrameElement, baseUrl: string): void {
  const source = iframe.getAttribute("src");
  const resolved = source === null ? undefined : isHttpUrl(source, baseUrl);
  if (resolved === undefined) {
    iframe.remove();
    return;
  }

  const link = iframe.ownerDocument.createElement("a");
  link.href = resolved;
  link.textContent = "Embedded content";
  iframe.replaceWith(link);
}

/**
 * Materializes resource URLs on a disposable rendered-document clone. The live
 * page document must never be passed to this function.
 */
export function materializeRenderedResources(document: Document, baseUrl: string): void {
  for (const image of document.querySelectorAll<HTMLImageElement>("img")) {
    const rendered = renderedSource(image);
    if (rendered !== undefined) {
      image.setAttribute("src", rendered);
    } else {
      materializeAttribute(image, "src", baseUrl);
    }
    image.removeAttribute("srcset");
    image.removeAttribute("sizes");
  }

  for (const media of document.querySelectorAll<HTMLAudioElement | HTMLVideoElement>("audio, video")) {
    const rendered = renderedSource(media);
    if (rendered !== undefined) {
      media.setAttribute("src", rendered);
    } else {
      materializeAttribute(media, "src", baseUrl);
    }
    if (media instanceof HTMLVideoElement) {
      materializeAttribute(media, "poster", baseUrl);
    }
  }

  for (const source of document.querySelectorAll<HTMLSourceElement>("source")) {
    materializeAttribute(source, "src", baseUrl);
    source.removeAttribute("srcset");
  }

  for (const iframe of document.querySelectorAll<HTMLIFrameElement>("iframe")) {
    replaceIframeWithLink(iframe, baseUrl);
  }

  for (const link of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const href = link.getAttribute("href");
    const resolved = href === null ? undefined : isHttpUrl(href, baseUrl);
    if (resolved === undefined) {
      link.removeAttribute("href");
    } else {
      link.setAttribute("href", resolved);
    }
  }
}
