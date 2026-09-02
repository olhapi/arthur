import DOMPurify from "dompurify";
import { Readability } from "@mozilla/readability";

import { htmlToMarkdown } from "./markdown.js";
import { classifyMedia, type MediaKind, materializeRenderedResources } from "./resources.js";
import { normalizeSource } from "./source.js";

export interface ExtractedMedia {
  id: string;
  url: string;
  originalName: string;
  kind: MediaKind;
  placeholder: string;
}

export interface ExtractedArticle {
  title: string;
  source: string;
  markdown: string;
  media: ExtractedMedia[];
}

export interface ExtractArticleOptions {
  createMediaId?: () => string;
}

const ALLOWED_TAGS = [
  "a",
  "article",
  "audio",
  "blockquote",
  "br",
  "caption",
  "code",
  "del",
  "div",
  "em",
  "figure",
  "figcaption",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "section",
  "source",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
  "video",
];
const ALLOWED_ATTRIBUTES = ["alt", "class", "colspan", "controls", "href", "poster", "rowspan", "src", "title", "type"];
const FORBIDDEN_TAGS = ["button", "embed", "form", "input", "script", "style", "svg"];
const FORBIDDEN_ATTRIBUTES = ["style"];

function originalName(url: string, kind: MediaKind): string {
  const pathname = new URL(url).pathname;
  const basename = pathname.split("/").filter(Boolean).at(-1);
  if (basename === undefined) {
    return kind;
  }
  try {
    return decodeURIComponent(basename);
  } catch {
    return basename;
  }
}

function remoteLink(document: Document, url: string, label: string): HTMLAnchorElement {
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.textContent = label;
  return link;
}

function mediaUrl(element: HTMLAudioElement | HTMLVideoElement): { url: string; contentType?: string } | undefined {
  const direct = element.getAttribute("src");
  if (direct !== null) {
    return { url: direct };
  }
  const source = element.querySelector<HTMLSourceElement>("source[src]");
  if (source === null) {
    return undefined;
  }
  const type = source.getAttribute("type");
  return type === null ? { url: source.getAttribute("src") ?? "" } : { url: source.getAttribute("src") ?? "", contentType: type };
}

function articleContentDocument(document: Document, content: string): Document {
  const result = document.implementation.createHTMLDocument("");
  result.body.innerHTML = content;
  return result;
}

function applyRenderedSourceSnapshot(source: Document, clone: Document): void {
  const sourceMedia = source.querySelectorAll<HTMLImageElement | HTMLAudioElement | HTMLVideoElement>(
    "img, audio, video",
  );
  const clonedMedia = clone.querySelectorAll<HTMLImageElement | HTMLAudioElement | HTMLVideoElement>(
    "img, audio, video",
  );
  for (const [index, sourceElement] of sourceMedia.entries()) {
    const clonedElement = clonedMedia[index];
    const currentSrc = sourceElement.currentSrc;
    if (clonedElement !== undefined && currentSrc !== "") {
      clonedElement.setAttribute("src", currentSrc);
    }
  }
}

function isSubstackPostTerminator(element: Element): boolean {
  return (
    element.matches("footer") ||
    element.classList.contains("post-footer") ||
    element.classList.contains("post-ufi") ||
    element.classList.contains("single-post-section") ||
    element.classList.contains("comments-section")
  );
}

function normalizeSubstackHeadings(body: HTMLElement): void {
  // Readability treats "header" as boilerplate once an article is large
  // enough to use its normal filtering pass. Substack gives every in-body
  // heading this class, regardless of whether the post has a paywall.
  for (const heading of body.querySelectorAll("h1.header-anchor-post, h2.header-anchor-post, h3.header-anchor-post, h4.header-anchor-post, h5.header-anchor-post, h6.header-anchor-post")) {
    heading.classList.remove("header-anchor-post");
  }
}

/**
 * Substack renders continuation nodes as direct article siblings outside the
 * body Readability chooses. The section heading can precede PaywallToDOM while
 * its paragraphs follow it, so fold the entire continuation range into the
 * disposable article body while leaving post controls and comments out.
 */
function materializeSubstackSubscriberContent(document: Document): void {
  for (const post of document.querySelectorAll<HTMLElement>("article.newsletter-post.post")) {
    const body = post.querySelector<HTMLElement>(".dt-post-body .available-content .body.markup");
    const paywall = post.querySelector<HTMLElement>('[data-component-name="PaywallToDOM"].paywall-jump');
    if (body === null) continue;

    normalizeSubstackHeadings(body);

    if (paywall === null) continue;

    let bodyContainer: HTMLElement = body;
    while (bodyContainer.parentElement !== post) {
      if (bodyContainer.parentElement === null) break;
      bodyContainer = bodyContainer.parentElement;
    }

    let sibling = bodyContainer.nextElementSibling;
    while (sibling !== null && !isSubstackPostTerminator(sibling)) {
      const next = sibling.nextElementSibling;
      if (sibling === paywall) sibling.remove();
      else body.append(sibling);
      sibling = next;
    }
    paywall.remove();
    normalizeSubstackHeadings(body);
  }
}

function numericAttribute(element: Element, name: "width" | "height"): number | undefined {
  const raw = element.getAttribute(name);
  if (raw === null || !/^\d+(?:\.\d+)?$/.test(raw.trim())) return undefined;
  return Number(raw);
}

function isHidden(element: Element): boolean {
  if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") return true;
  const style = element.getAttribute("style")?.toLowerCase() ?? "";
  return /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0)(?:;|$)/.test(style);
}

/** Removes telemetry-only markup from the disposable DOM before URL handling. */
function removeTrackingElements(document: Document): void {
  for (const element of document.querySelectorAll("img, picture, audio, video, iframe")) {
    const width = numericAttribute(element, "width");
    const height = numericAttribute(element, "height");
    const source = [element.getAttribute("src"), element.getAttribute("data-src"), element.id, element.className]
      .filter((value): value is string => typeof value === "string")
      .join(" ")
      .toLowerCase();
    const trackingMarkup = [...element.attributes].some((attribute) => /(?:track|analytics|beacon|pixel)/i.test(attribute.name));
    const explicitTrackingMarker = [...element.attributes].some((attribute) =>
      /^(?:data-)?(?:track(?:ing)?|analytics|beacon|pixel)$/i.test(attribute.name) &&
      /^(?:|1|true|yes)$/i.test(attribute.value.trim()),
    );
    const tiny = width !== undefined && height !== undefined && width <= 2 && height <= 2;
    const trackingName = /(?:track(?:ing)?|analytics|beacon|pixel)/.test(source);
    if (isHidden(element) || tiny || explicitTrackingMarker || (trackingMarkup && trackingName)) element.remove();
  }
}

function replaceMediaWithPlaceholders(document: Document, createMediaId: () => string): ExtractedMedia[] {
  const media: ExtractedMedia[] = [];
  const byUrl = new Map<string, ExtractedMedia>();

  const placeholderFor = (url: string, tagName: string, contentType?: string): ExtractedMedia | undefined => {
    let normalized: string;
    try {
      normalized = normalizeSource(url);
    } catch {
      return undefined;
    }
    const classification = classifyMedia(normalized, tagName, contentType);
    if (classification === "stream" || classification === "unsupported") {
      return undefined;
    }
    const existing = byUrl.get(normalized);
    if (existing !== undefined) {
      return existing;
    }
    const item: ExtractedMedia = {
      id: createMediaId(),
      url: normalized,
      originalName: originalName(normalized, classification),
      kind: classification,
      placeholder: "",
    };
    item.placeholder = `arthur-media://${item.id}`;
    media.push(item);
    byUrl.set(normalized, item);
    return item;
  };

  const placeholderNode = (item: ExtractedMedia): HTMLSpanElement => {
    const placeholder = document.createElement("span");
    placeholder.textContent = item.placeholder;
    return placeholder;
  };
  const replaceWithPlaceholder = (element: Element, item: ExtractedMedia): void => {
    const link = element.closest("a");
    if (
      link !== null &&
      link.querySelectorAll("img").length === 1 &&
      link.querySelector("img") === element &&
      (link.textContent ?? "").trim() === ""
    ) {
      link.replaceWith(placeholderNode(item));
      return;
    }
    element.replaceWith(placeholderNode(item));
  };

  for (const image of document.querySelectorAll<HTMLImageElement>("img[src]")) {
    const url = image.getAttribute("src");
    if (url === null) {
      continue;
    }
    const item = placeholderFor(url, image.tagName);
    if (item === undefined) {
      image.replaceWith(remoteLink(document, url, image.alt || "Image"));
    } else {
      replaceWithPlaceholder(image, item);
    }
  }

  for (const element of document.querySelectorAll<HTMLAudioElement | HTMLVideoElement>("audio, video")) {
    const replacements: Node[] = [];
    if (element instanceof HTMLVideoElement) {
      const poster = element.getAttribute("poster");
      if (poster !== null) {
        const posterItem = placeholderFor(poster, "IMG");
        if (posterItem === undefined) {
          replacements.push(remoteLink(document, poster, "Video poster"));
        } else {
          replacements.push(placeholderNode(posterItem));
        }
      }
    }
    const source = mediaUrl(element);
    if (source === undefined) {
      element.replaceWith(...replacements);
      continue;
    }
    const item = placeholderFor(source.url, element.tagName, source.contentType);
    if (item === undefined) {
      replacements.push(remoteLink(document, source.url, element.tagName === "AUDIO" ? "Audio" : "Video"));
    } else {
      replacements.push(placeholderNode(item));
    }
    element.replaceWith(...replacements);
  }

  return media;
}

export function extractArticle(
  document: Document,
  finalUrl: string,
  { createMediaId = () => crypto.randomUUID() }: ExtractArticleOptions = {},
): ExtractedArticle {
  const source = normalizeSource(finalUrl);
  const renderedClone = document.cloneNode(true) as Document;
  applyRenderedSourceSnapshot(document, renderedClone);
  materializeSubstackSubscriberContent(renderedClone);
  removeTrackingElements(renderedClone);
  materializeRenderedResources(renderedClone, source);

  const extracted = new Readability(renderedClone, {
    charThreshold: 0,
    keepClasses: true,
  }).parse();
  if (extracted?.title === null || extracted?.title === undefined || extracted.content === null || extracted.content === undefined) {
    throw new Error("Could not extract a readable article");
  }
  const title = extracted.title.trim();
  const content = extracted.content.trim();
  if (title === "" || content === "" || (extracted.textContent?.trim() ?? "") === "") {
    throw new Error("Could not extract a readable article");
  }

  const sanitized = DOMPurify.sanitize(content, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ALLOWED_ATTRIBUTES,
    FORBID_TAGS: FORBIDDEN_TAGS,
    FORBID_ATTR: FORBIDDEN_ATTRIBUTES,
    ALLOW_DATA_ATTR: false,
  });
  const outputDocument = articleContentDocument(renderedClone, sanitized);
  const media = replaceMediaWithPlaceholders(outputDocument, createMediaId);

  return {
    title,
    source,
    markdown: htmlToMarkdown(outputDocument.body.innerHTML),
    media,
  };
}
