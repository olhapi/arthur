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

export interface ExtractionRuntime {
  onMessage: {
    addListener(
      listener: (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean | undefined,
    ): void;
  };
}

/** Registers Chrome's callback transport explicitly so the response crosses the extension boundary. */
export function registerExtractionListener<Result>(
  runtime: ExtractionRuntime,
  document: Document,
  location: LocationLike,
  extract: ArticleExtractor<Result>,
): void {
  runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (typeof message !== "object" || message === null || (message as { type?: unknown }).type !== "extract_article") {
      return undefined;
    }
    sendResponse(extract(document, location.href));
    return true;
  });
}

export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  main() {
    registerExtractionListener<ExtractedArticle>(browser.runtime as unknown as ExtractionRuntime, document, location, extractArticle);
  },
});
