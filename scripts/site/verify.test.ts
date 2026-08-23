import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { buildSite } from "./build.mjs";
import { verifyHtml } from "./verify.mjs";

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
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
