import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FORBIDDEN = ["native/target/", "node_modules/", ".output/", ".wxt/", "coverage/", "dist/", ".turbo/"];
const FORBIDDEN_FILES = ["native/src/bin/arthur-native-acceptance-host.rs"];
const MAX_SOURCE_ARCHIVE_BYTES = 10 * 1024 * 1024;
const MAX_SOURCE_ENTRIES = 500;

function entries(archive) {
  return execFileSync("/usr/bin/unzip", ["-Z1", archive], { encoding: "utf8" })
    .split("\n").filter(Boolean).map((entry) => entry.replaceAll("\\", "/"));
}

export async function validateSourceArchives({ root = path.join(ROOT, ".output") } = {}) {
  const archives = (await fs.readdir(root)).filter((name) => name.endsWith("-sources.zip")).sort();
  if (archives.length !== 1) throw new Error("Expected exactly one bounded WXT source archive.");
  const results = [];
  for (const name of archives) {
    const archive = path.join(root, name);
    const stat = await fs.stat(archive);
    const inventory = entries(archive);
    const forbidden = inventory.find((entry) => FORBIDDEN_FILES.includes(entry) || FORBIDDEN.some((prefix) => entry === prefix.slice(0, -1) || entry.startsWith(prefix) || entry.includes(`/${prefix}`)));
    if (forbidden) throw new Error(`Source archive contains forbidden build/cache path: ${forbidden}`);
    if (stat.size > MAX_SOURCE_ARCHIVE_BYTES || inventory.length > MAX_SOURCE_ENTRIES) throw new Error("Source archive exceeds Arthur's bounded size or inventory.");
    results.push({ name, bytes: stat.size, entries: inventory.length });
  }
  return { sourceArchives: results };
}

async function main() { process.stdout.write(`${JSON.stringify(await validateSourceArchives())}\n`); }
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => { process.stderr.write(`Arthur source archive check failed: ${error.message}\n`); process.exitCode = 1; });
