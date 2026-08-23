import { fileURLToPath } from "node:url";

import { validateChromeStoreBuild } from "./check-builds.mjs";

async function main() {
  const result = await validateChromeStoreBuild();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`Arthur Chrome Web Store smoke failed: ${error.message}\n`); process.exitCode = 1; });
}
