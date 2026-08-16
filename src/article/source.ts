export function normalizeSource(raw: string): string {
  const source = new URL(raw);
  if (source.protocol !== "http:" && source.protocol !== "https:") {
    throw new TypeError("Article source must be an HTTP(S) URL");
  }

  source.hash = "";
  return source.href;
}
