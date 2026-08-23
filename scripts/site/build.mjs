import { cp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));

export function buildSite({
  rootDir = resolve(scriptDir, "../.."),
  outputDir = resolve(rootDir, ".site-dist"),
  run = execFileSync,
} = {}) {
  const expectedOutput = resolve(rootDir, ".site-dist");
  if (resolve(outputDir) !== expectedOutput) {
    throw new Error("Site output must be .site-dist inside the repository root");
  }

  return (async () => {
    await rm(outputDir, { recursive: true, force: true });
    await mkdir(outputDir, { recursive: true });
    await cp(resolve(rootDir, "site/source"), outputDir, { recursive: true });
    await rm(resolve(outputDir, "site.test.ts"), { force: true });

    const cliPackage = require.resolve("@tailwindcss/cli/package.json");
    const cliPath = resolve(dirname(cliPackage), "dist/index.mjs");
    await mkdir(resolve(outputDir, "assets"), { recursive: true });
    run(process.execPath, [cliPath, "-i", "styles.css", "-o", "assets/styles.css", "--minify"], {
      cwd: outputDir,
      stdio: "inherit",
    });
    await rm(resolve(outputDir, "styles.css"));
  })();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildSite();
}
