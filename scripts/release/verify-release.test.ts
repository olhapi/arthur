import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "scripts/release/verify-release.mjs");
const REQUIRED_ENV = {
  CHROME_EXTENSION_ID: "bfcgihgadankhhijhhdlkekecfmbihef",
  CHROME_PUBLISHER_ID: "publisher-id",
  CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL: "arthur-publisher@example.iam.gserviceaccount.com",
  CHROME_SERVICE_ACCOUNT_PRIVATE_KEY: "private-key-value",
  FIREFOX_EXTENSION_ID: "arthur@olhapi.com",
  FIREFOX_JWT_ISSUER: "firefox-issuer",
  FIREFOX_JWT_SECRET: "firefox-secret-value",
};

function runGit(repository: string, args: string[]) {
  const result = spawnSync("git", ["-C", repository, ...args], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
}

async function runReleaseGuard(
  tag: string,
  env: Record<string, string> = REQUIRED_ENV,
  { branchOnly = false, advanceHead = false } = {},
) {
  const directory = await mkdtemp(path.join(tmpdir(), "arthur-release-guard-"));
  const packagePath = path.join(directory, "package.json");
  await writeFile(packagePath, JSON.stringify({ version: "0.1.1" }));
  runGit(directory, ["init", "--quiet"]);
  runGit(directory, ["config", "user.name", "Arthur Release Test"]);
  runGit(directory, ["config", "user.email", "release-test@example.com"]);
  runGit(directory, ["add", "package.json"]);
  runGit(directory, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"]);
  if (/^v\d+\.\d+\.\d+$/.test(tag)) {
    runGit(directory, [branchOnly ? "branch" : "tag", tag]);
  }
  if (advanceHead) {
    await writeFile(path.join(directory, "after-tag.txt"), "newer commit");
    runGit(directory, ["add", "after-tag.txt"]);
    runGit(directory, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "after tag"]);
  }

  return spawnSync(
    process.execPath,
    [SCRIPT, "--tag", tag, "--package", packagePath, "--repository", directory],
    {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
    },
  );
}

describe("store release guard", () => {
  it("accepts the exact version tag when every store credential is present", async () => {
    const result = await runReleaseGuard("v0.1.1");

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ tag: "v0.1.1", version: "0.1.1" });
    expect(result.stderr).toBe("");
  });

  it("rejects a tag that does not match the package version", async () => {
    const result = await runReleaseGuard("v0.1.2");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not match package version 0.1.1");
  });

  it("rejects a non-version release ref", async () => {
    const result = await runReleaseGuard("main");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be an exact vMAJOR.MINOR.PATCH tag");
  });

  it("reports missing credential names without printing secret values", async () => {
    const env = Object.fromEntries(Object.keys(REQUIRED_ENV).map((name) => [name, ""]));
    const result = await runReleaseGuard("v0.1.1", env);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CHROME_PUBLISHER_ID");
    expect(result.stderr).toContain("FIREFOX_JWT_SECRET");
    expect(result.stderr).not.toContain("private-key-value");
    expect(result.stderr).not.toContain("firefox-secret-value");
  });

  it("rejects a tag-shaped branch when the matching tag does not exist", async () => {
    const result = await runReleaseGuard("v0.1.1", REQUIRED_ENV, { branchOnly: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refs/tags/v0.1.1 does not exist");
  });

  it("rejects a checkout whose HEAD is newer than the release tag", async () => {
    const result = await runReleaseGuard("v0.1.1", REQUIRED_ENV, { advanceHead: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("HEAD does not match refs/tags/v0.1.1");
  });
});
