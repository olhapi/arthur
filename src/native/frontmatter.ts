import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const JSON_STRING = String.raw`"(?:[^"\\\r\n]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"`;
const ARTHUR_FRONTMATTER = new RegExp(
  String.raw`^---\r?\ntitle: (${JSON_STRING})\r?\nsource: (${JSON_STRING})\r?\n---\r?\n(?:\r?\n|$)`,
);

function parseArthurFrontmatter(markdown: string): { source: string } | undefined {
  const match = ARTHUR_FRONTMATTER.exec(markdown);
  if (match === null) {
    return undefined;
  }

  try {
    const title = JSON.parse(match[1] ?? "") as unknown;
    const source = JSON.parse(match[2] ?? "") as unknown;
    return typeof title === "string" && typeof source === "string" ? { source } : undefined;
  } catch {
    return undefined;
  }
}

export function serializeNote(title: string, source: string, markdown: string): string {
  return `---\ntitle: ${JSON.stringify(title)}\nsource: ${JSON.stringify(source)}\n---\n\n${markdown}`;
}

export async function findExistingArticle(
  destination: string,
  source: string,
): Promise<string | undefined> {
  const entries = await readdir(destination, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }

    const path = join(destination, entry.name);
    let contents: string;
    try {
      contents = await readFile(path, "utf8");
    } catch {
      continue;
    }
    if (parseArthurFrontmatter(contents)?.source === source) {
      return path;
    }
  }

  return undefined;
}
