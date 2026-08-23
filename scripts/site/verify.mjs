import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));

export function verifyHtml(html, relativePath) {
  const errors = [];

  if (relativePath === "index.html" && !html.includes('href="./privacy/"')) {
    errors.push("index.html: missing privacy route ./privacy/");
  }
  if (relativePath === "index.html" && !html.includes('href="assets/styles.css"')) {
    errors.push("index.html: missing local stylesheet assets/styles.css");
  }
  if (/data-native-install=["']release["']/.test(html)) {
    const releaseUrl = html.match(/data-release-url=["']([^"']*)["']/)?.[1] ?? "";
    const checksum = html.match(/data-release-sha256=["']([^"']*)["']/)?.[1] ?? "";
    if (!releaseUrl || !/^[a-f0-9]{64}$/i.test(checksum)) {
      errors.push(
        "index.html: release installer requires data-release-url and data-release-sha256",
      );
    }
  }

  return errors;
}

export async function verifySite({ outputDir = resolve(scriptDir, "../../.site-dist") } = {}) {
  const errors = [];
  const pages = ["index.html", "privacy/index.html"];

  for (const page of pages) {
    try {
      const html = await readFile(resolve(outputDir, page), "utf8");
      errors.push(...verifyHtml(html, page));
    } catch {
      errors.push(`${page}: missing generated page`);
    }
  }

  try {
    await access(resolve(outputDir, "assets/styles.css"), constants.R_OK);
  } catch {
    errors.push("assets/styles.css: missing compiled stylesheet");
  }

  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = await verifySite();
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  }
}
