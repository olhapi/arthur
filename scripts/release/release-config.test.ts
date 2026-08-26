import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("store release automation", () => {
  it("publishes exact version tags with pinned actions and store-only secrets", async () => {
    const workflow = await readFile(path.join(ROOT, ".github/workflows/publish-stores.yml"), "utf8");
    const actionReferences = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#\s*(.+))?$/gm)];

    expect(workflow).toMatch(/push:\s*\n\s*tags:\s*\["v\*\.\*\.\*"\]/);
    expect(workflow).toMatch(/workflow_dispatch:[\s\S]*release_tag:[\s\S]*required:\s*true/);
    expect(workflow).toContain("ref: refs/tags/${{ env.RELEASE_TAG }}");
    expect(workflow).toContain("node scripts/release/verify-release.mjs --tag \"$RELEASE_TAG\" --package package.json --repository .");
    expect(workflow).toContain("pnpm build:chrome");
    expect(workflow).toContain("pnpm build:firefox");
    expect(workflow).toContain("pnpm smoke");
    expect(workflow).toContain("pnpm release:stores");
    expect(workflow).not.toContain("release:stores:dry-run");
    expect(workflow).toContain("CHROME_SERVICE_ACCOUNT_PRIVATE_KEY: ${{ secrets.CHROME_SERVICE_ACCOUNT_PRIVATE_KEY }}");
    expect(workflow).toContain("FIREFOX_JWT_SECRET: ${{ secrets.FIREFOX_JWT_SECRET }}");
    expect(actionReferences.map((match) => match[1])).toEqual([
      "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd",
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    ]);
    expect(actionReferences.every((match) => /^v\d+\.\d+\.\d+$/.test(match[2] ?? ""))).toBe(true);
    const nativeBuild = workflow.indexOf("cargo +1.97.1 build --release --manifest-path native/Cargo.toml --locked");
    const tests = workflow.indexOf("pnpm test");
    expect(workflow).toContain("rustup toolchain install 1.97.1 --profile minimal");
    expect(nativeBuild).toBeGreaterThan(-1);
    expect(tests).toBeGreaterThan(nativeBuild);
  });

  it("ignores local browser tooling and macOS metadata throughout the repository", () => {
    const paths = [
      ".DS_Store",
      "store-assets/.DS_Store",
      ".superpowers/brainstorm/state",
      ".pnpm-store/index.json",
      ".playwright-cli/page.png",
    ];
    const result = spawnSync("git", ["check-ignore", "--stdin"], {
      cwd: ROOT,
      encoding: "utf8",
      input: `${paths.join("\n")}\n`,
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(paths);
  });

  it("prepares the store-specific Chrome and Firefox source artifacts before submission", async () => {
    const packageJson = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
    expect(packageJson.scripts["release:stores:prepare"]).toContain("zip:chrome:store");
    expect(packageJson.scripts["release:stores:prepare"]).toContain("wxt zip -b firefox");
    expect(packageJson.scripts["release:stores:prepare"]).toContain("check-builds.mjs --store-zips");
    expect(packageJson.scripts["release:stores:prepare"]).toContain("check-zips.mjs");
  });

  it("dry-runs and submits exact versioned artifacts with automatic Chrome publishing", async () => {
    const packageJson = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
    const dryRun = packageJson.scripts["release:stores:dry-run"];
    const submit = packageJson.scripts["release:stores"];
    for (const command of [dryRun, submit]) {
      expect(command).toContain("release:stores:prepare");
      expect(command).toContain("--chrome-api-version v2");
      expect(command).toContain("--chrome-publish-type DEFAULT_PUBLISH");
      expect(command).toContain("--firefox-channel listed");
      expect(command).not.toContain("STAGED_PUBLISH");
      expect(command).toContain(".output/arthur-$npm_package_version-chrome-store.zip");
      expect(command).toContain(".output/arthur-$npm_package_version-firefox.zip");
      expect(command).toContain(".output/arthur-$npm_package_version-sources.zip");
    }
    expect(dryRun).toContain("--dry-run");
    expect(submit).not.toContain("--dry-run");
  });

  it("keeps submit credentials local while documenting every required variable", async () => {
    const [gitignore, template] = await Promise.all([
      readFile(path.join(ROOT, ".gitignore"), "utf8"),
      readFile(path.join(ROOT, ".env.submit.example"), "utf8"),
    ]);
    expect(gitignore).toContain(".env.submit");
    for (const variable of [
      "CHROME_EXTENSION_ID=bfcgihgadankhhijhhdlkekecfmbihef",
      "CHROME_PUBLISHER_ID=",
      "CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL=",
      "CHROME_SERVICE_ACCOUNT_PRIVATE_KEY=",
      "FIREFOX_EXTENSION_ID=arthur@olhapi.com",
      "FIREFOX_JWT_ISSUER=",
      "FIREFOX_JWT_SECRET=",
    ]) expect(template).toContain(variable);
  });
});
