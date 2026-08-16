import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { findExistingArticle, serializeNote } from "./frontmatter.js";

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "arthur-frontmatter-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("Arthur note frontmatter", () => {
  it("serializes quoted title and source fields with a separated Markdown body", () => {
    expect(serializeNote('A "title"', "https://example.test/a", "Body\n")).toBe(
      '---\ntitle: "A \\"title\\""\nsource: "https://example.test/a"\n---\n\nBody\n',
    );
  });

  it("escapes newlines in YAML strings instead of allowing field injection", () => {
    expect(serializeNote("A\nsource: forged", "https://example.test/a", "")).toContain(
      'title: "A\\nsource: forged"',
    );
  });

  it("finds only a direct-child Arthur note with the same source", async () => {
    const directory = await makeTemporaryDirectory();
    const source = "https://example.test/article";
    const article = join(directory, "article.md");
    await writeFile(article, serializeNote("Article", source, "Body"));
    await mkdir(join(directory, "nested"));
    await writeFile(join(directory, "nested", "ignored.md"), serializeNote("Article", source, "Body"));

    await expect(findExistingArticle(directory, source)).resolves.toBe(article);
  });

  it("ignores matching notes below the destination folder", async () => {
    const directory = await makeTemporaryDirectory();
    const source = "https://example.test/article";
    await mkdir(join(directory, "nested"));
    await writeFile(join(directory, "nested", "ignored.md"), serializeNote("Article", source, "Body"));

    await expect(findExistingArticle(directory, source)).resolves.toBeUndefined();
  });

  it("ignores malformed or non-Arthur frontmatter", async () => {
    const directory = await makeTemporaryDirectory();
    const source = "https://example.test/article";
    await writeFile(
      join(directory, "extra-field.md"),
      `---\ntitle: "Article"\nsource: "${source}"\ntags: [unsafe]\n---\n\nBody`,
    );
    await writeFile(join(directory, "not-frontmatter.md"), `source: "${source}"`);

    await expect(findExistingArticle(directory, source)).resolves.toBeUndefined();
  });

  it("does not treat the same title with another source as the existing article", async () => {
    const directory = await makeTemporaryDirectory();
    await writeFile(
      join(directory, "other.md"),
      serializeNote("Same title", "https://example.test/other", "Body"),
    );

    await expect(findExistingArticle(directory, "https://example.test/article")).resolves.toBeUndefined();
  });
});
