import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const CHROME_EXTENSION_ID = "bfcgihgadankhhijhhdlkekecfmbihef";
const FIREFOX_EXTENSION_ID = "arthur@olhapi.com";
const REQUIRED_ENVIRONMENT = [
  "CHROME_EXTENSION_ID",
  "CHROME_PUBLISHER_ID",
  "CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL",
  "CHROME_SERVICE_ACCOUNT_PRIVATE_KEY",
  "FIREFOX_EXTENSION_ID",
  "FIREFOX_JWT_ISSUER",
  "FIREFOX_JWT_SECRET",
];

function parseArguments(argv) {
  if (
    argv.length !== 6
    || argv[0] !== "--tag"
    || argv[2] !== "--package"
    || argv[4] !== "--repository"
  ) {
    throw new Error(
      "Usage: verify-release.mjs --tag vMAJOR.MINOR.PATCH --package package.json --repository .",
    );
  }
  return { tag: argv[1], packagePath: argv[3], repository: argv[5] };
}

function validateEnvironment(environment) {
  const missing = REQUIRED_ENVIRONMENT.filter((name) => !environment[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing store publishing environment variables: ${missing.join(", ")}`);
  }
  if (environment.CHROME_EXTENSION_ID !== CHROME_EXTENSION_ID) {
    throw new Error(`CHROME_EXTENSION_ID must be ${CHROME_EXTENSION_ID}`);
  }
  if (environment.FIREFOX_EXTENSION_ID !== FIREFOX_EXTENSION_ID) {
    throw new Error(`FIREFOX_EXTENSION_ID must be ${FIREFOX_EXTENSION_ID}`);
  }
}

async function main() {
  const { tag, packagePath, repository } = parseArguments(process.argv.slice(2));
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error("Release ref must be an exact vMAJOR.MINOR.PATCH tag");
  }

  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  const expectedTag = `v${packageJson.version}`;
  if (tag !== expectedTag) {
    throw new Error(`Release tag ${tag} does not match package version ${packageJson.version}`);
  }

  const tagRef = `refs/tags/${tag}`;
  let tagCommit;
  try {
    tagCommit = execFileSync(
      "git",
      ["-C", repository, "rev-parse", "--verify", `${tagRef}^{commit}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    throw new Error(`${tagRef} does not exist`);
  }
  const headCommit = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (headCommit !== tagCommit) {
    throw new Error(`HEAD does not match ${tagRef}`);
  }

  validateEnvironment(process.env);
  process.stdout.write(`${JSON.stringify({ tag, version: packageJson.version })}\n`);
}

main().catch((error) => {
  process.stderr.write(`Store release verification failed: ${error.message}\n`);
  process.exitCode = 1;
});
