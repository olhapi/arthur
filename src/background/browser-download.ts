import type { ExtractedArticle } from "../article/extract.js";

export interface BrowserDownloadAdapter {
  download(details: { url: string; filename: string }): Promise<number>;
  createObjectURL(value: Blob): string;
  revokeObjectURL(url: string): void;
}

function filename(title: string): string {
  const safeTitle = title
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 120);
  return `${safeTitle === "" ? "Article" : safeTitle}.md`;
}

function quoteFrontmatter(value: string): string {
  return JSON.stringify(value);
}

export function markdownDownload(article: ExtractedArticle): { filename: string; contents: string } {
  let markdown = article.markdown;
  for (const media of article.media) markdown = markdown.split(media.placeholder).join(`<${media.url}>`);
  return {
    filename: filename(article.title),
    contents: `---\ntitle: ${quoteFrontmatter(article.title)}\nsource: ${quoteFrontmatter(article.source)}\n---\n\n${markdown}`,
  };
}

/** Saves a self-contained Markdown fallback when the native host is absent. */
export async function downloadArticle(article: ExtractedArticle, browser: BrowserDownloadAdapter): Promise<string> {
  const file = markdownDownload(article);
  const url = browser.createObjectURL(new Blob([file.contents], { type: "text/markdown;charset=utf-8" }));
  try {
    await browser.download({ url, filename: file.filename });
    return file.filename;
  } finally {
    browser.revokeObjectURL(url);
  }
}
