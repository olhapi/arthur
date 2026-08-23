import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { buildSite } from "./build.mjs";
import { verifyHtml, verifySite } from "./verify.mjs";

describe("verifyHtml", () => {
  it("rejects a product page that cannot lead users to the privacy policy", () => {
    expect(verifyHtml("<main></main>", "index.html")).toContain(
      "index.html: missing privacy route ./privacy/",
    );
  });

  it("accepts the relative privacy route used by a GitHub Pages project site", () => {
    expect(verifyHtml('<a href="./privacy/"></a><link href="assets/styles.css">', "index.html")).toEqual([]);
  });

  it("rejects a visible release installer without immutable release metadata", () => {
    const html = '<code data-native-install="release">curl -fsSL example | sh</code>';

    expect(verifyHtml(html, "index.html")).toContain(
      "index.html: release installer requires data-release-url and data-release-sha256",
    );
  });
});

describe("buildSite", () => {
  it("writes compiled CSS to a different file than the copied Tailwind source", async () => {
    const rootDir = await mkdtemp(resolve(tmpdir(), "arthur-site-"));
    const calls: string[][] = [];

    try {
      await mkdir(resolve(rootDir, "site/source"), { recursive: true });
      await writeFile(resolve(rootDir, "site/source/styles.css"), '@import "tailwindcss";');
      await writeFile(resolve(rootDir, "site/source/site.test.ts"), "test fixture");
      await writeFile(
        resolve(rootDir, "site/source/googlea59ef01bb1d170e1.html"),
        "google-site-verification: googlea59ef01bb1d170e1.html\n",
      );

      await buildSite({
        rootDir,
        run: (_command: string, args: string[]) => calls.push(args),
      });

      expect(calls).toHaveLength(1);
      const args = calls[0];
      if (!args) throw new Error("Tailwind CLI was not invoked");
      expect(args).toContain("-i");
      expect(args.at(args.indexOf("-i") + 1)).not.toBe(args.at(args.indexOf("-o") + 1));
      await expect(access(resolve(rootDir, ".site-dist/site.test.ts"))).rejects.toThrow();
      await expect(readFile(resolve(rootDir, ".site-dist/googlea59ef01bb1d170e1.html"), "utf8")).resolves.toBe(
        "google-site-verification: googlea59ef01bb1d170e1.html",
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

describe("verifySite", () => {
  it("requires the Google Search Console verification file at the site root", async () => {
    const outputDir = await mkdtemp(resolve(tmpdir(), "arthur-site-output-"));

    try {
      await mkdir(resolve(outputDir, "privacy"), { recursive: true });
      await mkdir(resolve(outputDir, "assets"), { recursive: true });
      await writeFile(resolve(outputDir, "index.html"), '<a href="./privacy/"></a><link href="assets/styles.css">');
      await writeFile(resolve(outputDir, "privacy/index.html"), "privacy");
      await writeFile(resolve(outputDir, "assets/styles.css"), "body {}");

      await expect(verifySite({ outputDir })).resolves.toContain(
        "googlea59ef01bb1d170e1.html: missing Google Search Console verification file",
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("requires the exact Google Search Console verification content", async () => {
    const outputDir = await mkdtemp(resolve(tmpdir(), "arthur-site-output-"));

    try {
      await mkdir(resolve(outputDir, "privacy"), { recursive: true });
      await mkdir(resolve(outputDir, "assets"), { recursive: true });
      await writeFile(resolve(outputDir, "index.html"), '<a href="./privacy/"></a><link href="assets/styles.css">');
      await writeFile(resolve(outputDir, "privacy/index.html"), "privacy");
      await writeFile(resolve(outputDir, "assets/styles.css"), "body {}");
      await writeFile(resolve(outputDir, "googlea59ef01bb1d170e1.html"), "wrong");

      await expect(verifySite({ outputDir })).resolves.toContain(
        "googlea59ef01bb1d170e1.html: invalid Google Search Console verification content",
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
