import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";

import { extractArticle, type ExtractedArticle } from "../src/article/extract.js";

export interface ExtractionRequest {
  type: "extract_article";
}

export interface LocationLike {
  href: string;
}

export type ArticleExtractor<Result> = (document: Document, finalUrl: string) => Result;

/** Creates the content-message seam independently of extension globals. */
export function createExtractionMessageHandler<Result>(
  document: Document,
  location: LocationLike,
  extract: ArticleExtractor<Result>,
): (message: unknown) => Result | undefined {
  return (message: unknown) => {
    if (typeof message !== "object" || message === null || (message as { type?: unknown }).type !== "extract_article") {
      return undefined;
    }
    return extract(document, location.href);
  };
}

export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  main() {
    const handler = createExtractionMessageHandler<ExtractedArticle>(document, location, extractArticle);
    browser.runtime.onMessage.addListener(handler);
  },
});
