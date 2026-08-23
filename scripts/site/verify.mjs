import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const GOOGLE_VERIFICATION_FILE = "googlea59ef01bb1d170e1.html";
const GOOGLE_VERIFICATION_CONTENT = `google-site-verification: ${GOOGLE_VERIFICATION_FILE}`;

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

  try {
    const verificationContent = await readFile(resolve(outputDir, GOOGLE_VERIFICATION_FILE), "utf8");
    if (verificationContent !== GOOGLE_VERIFICATION_CONTENT) {
      errors.push(`${GOOGLE_VERIFICATION_FILE}: invalid Google Search Console verification content`);
    }
  } catch {
    errors.push(`${GOOGLE_VERIFICATION_FILE}: missing Google Search Console verification file`);
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
