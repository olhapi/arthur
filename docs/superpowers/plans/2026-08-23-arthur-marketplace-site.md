# Arthur Marketplace Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy a Tailwind-styled GitHub Pages product site that gives users and marketplace reviewers accurate, accessible installation, privacy, and support information for Arthur.

**Architecture:** Keep the public site as dependency-free static HTML and minimal JavaScript under `site/`; Tailwind CSS v4 is compiled at build time into a deployable directory. A small typed-by-convention configuration module controls store and native-release availability, and Node verification scripts inspect the emitted HTML/CSS before Pages uploads it.

**Tech Stack:** HTML5, Tailwind CSS 4.3.0 CLI, minimal browser JavaScript, Node 22 built-in modules, pnpm, Vitest 4, GitHub Pages Actions.

**Spec:** `docs/superpowers/specs/2026-08-23-arthur-marketplace-site-design.md`

## Global Constraints

- Support Chrome and Firefox only; do not render an Edge marketplace button or availability claim.
- The site is static and ships no account system, analytics, telemetry, advertising, remote backend, remote code, or third-party assets.
- Use Tailwind utilities for styling; keep custom CSS limited to `@theme`, base styles, focus styling, and reduced-motion behavior.
- `site/privacy/index.html` is the public, stable privacy-policy route.
- Never display a release-installer command unless its immutable release URL and SHA-256 are both configured.
- The native helper is opt-in. It registers only Arthur's helper/manifests, never installs a browser extension, and has an adjacent uninstall command.
- Claims must exactly match `wxt.config.ts`: `activeTab`, `storage`, `nativeMessaging`, `downloads`, and HTTP(S) host access.
- Public support email is `oleh@olhapi.com`; GitHub Issues is the support website.
- Arthur is distributed under the MIT License; create a repository `LICENSE` file and link to it from the site and listings.
- Pin every GitHub Action to an immutable commit SHA, not a tag.
- Preserve all existing dirty worktree changes; stage only files named in each task.

---

## File structure

| Path | Responsibility |
| --- | --- |
| `site/source/index.html` | Accessible product page markup and site navigation. |
| `site/source/privacy/index.html` | Standalone privacy policy at the stable public route. |
| `site/source/site.js` | Renders store/release states and copy-to-clipboard feedback. |
| `site/source/site-config.js` | Single source of truth for public store, issue, source, license, and optional-release metadata. |
| `site/source/styles.css` | Tailwind import, theme tokens, and minimal global accessibility CSS. |
| `site/source/assets/arthur.svg` | Local Arthur mark copied from the existing public icon. |
| `scripts/site/build.mjs` | Creates a clean `.site-dist` directory, copies public source, and runs the Tailwind CLI. |
| `scripts/site/verify.mjs` | Dependency-free build-output contract check. |
| `scripts/site/verify.test.ts` | Vitest unit tests for the output-verification helpers. |
| `docs/marketplace-listing.md` | Private handoff copy and reviewer checklist for Chrome and Firefox. |
| `.github/workflows/deploy-pages.yml` | SHA-pinned build, verification, and GitHub Pages deployment. |
| `package.json` | Exact Tailwind dev dependencies and site build/verify scripts. |
| `pnpm-lock.yaml` | Locked Tailwind dependency graph. |
| `LICENSE` | Canonical MIT License referenced by the website and marketplace listings. |

### Task 1: Static-site build contract

**Files:**
- Create: `LICENSE`
- Create: `site/source/styles.css`
- Create: `site/source/site-config.js`
- Create: `scripts/site/build.mjs`
- Create: `scripts/site/verify.mjs`
- Create: `scripts/site/verify.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces `SITE_CONFIG`, exported from `site/source/site-config.js`, with `stores`, `nativeRelease`, `supportEmail`, `issuesUrl`, `repositoryUrl`, and `licenseUrl` properties.
- Produces `buildSite({ rootDir, outputDir, run })`, exported from `scripts/site/build.mjs`; it resolves after writing a deployable static tree.
- Produces `verifySite({ outputDir })`, exported from `scripts/site/verify.mjs`; it returns an array of human-readable violations and never writes files.
- Produces package scripts `site:build` and `site:verify`, where `site:verify` runs the build then the emitted-site verification.

- [ ] **Step 1: Write the failing verification-helper tests**

```ts
import { describe, expect, it } from "vitest";
import { verifyHtml } from "./verify.mjs";

describe("verifyHtml", () => {
  it("requires the stable privacy-policy route and local stylesheet", () => {
    expect(verifyHtml("<main></main>", "index.html")).toContain(
      "index.html: missing privacy route /privacy/",
    );
  });

  it("rejects a release install command without immutable URL and checksum", () => {
    const html = '<code data-native-install="release">curl -fsSL example | sh</code>';
    expect(verifyHtml(html, "index.html")).toContain(
      "index.html: release installer requires data-release-url and data-release-sha256",
    );
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm vitest run scripts/site/verify.test.ts`

Expected: FAIL because `scripts/site/verify.mjs` does not exist.

- [ ] **Step 3: Add exact build dependencies and scripts**

Update `package.json` using `pnpm add -D tailwindcss@4.3.0 @tailwindcss/cli@4.3.0`. Add:

```json
"site:build": "node scripts/site/build.mjs",
"site:verify": "pnpm site:build && node scripts/site/verify.mjs"
```

Keep the existing extension scripts unchanged. `site/source/styles.css` begins with:

```css
@import "tailwindcss";

@theme {
  --color-ink: #17231d;
  --color-paper: #f7f5ed;
  --color-moss: #1d5b43;
  --font-sans: ui-sans-serif, system-ui, sans-serif;
}

html { scroll-behavior: smooth; }
:focus-visible { outline: 3px solid var(--color-moss); outline-offset: 3px; }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
```

Create `LICENSE` with the standard MIT License text and a `Copyright (c) 2026 Oleh` notice. Set the package's top-level `license` field to `MIT`.

- [ ] **Step 4: Implement configuration, build, and verification helpers**

Create `site/source/site-config.js` with disabled public listings and disabled native release until real immutable URLs exist:

```js
export const SITE_CONFIG = Object.freeze({
  stores: Object.freeze({ chrome: null, firefox: null }),
  nativeRelease: null,
  supportEmail: "oleh@olhapi.com",
  issuesUrl: "https://github.com/olhapi/arthur/issues",
  repositoryUrl: "https://github.com/olhapi/arthur",
  licenseUrl: "https://github.com/olhapi/arthur/blob/main/LICENSE",
});
```

In `build.mjs`, remove only the explicit output directory with `fs.rm(outputDir, { recursive: true, force: true })`, then copy `site/source` into it and execute the local Tailwind binary with `-i styles.css -o styles.css --minify`. Reject an output path outside `rootDir/.site-dist`.

In `verify.mjs`, define `verifyHtml(html, relativePath)` to require the primary page's `/privacy/` link and local `styles.css`, reject `http://` assets, reject known analytics hostnames, and require `data-release-url` plus a 64-character hexadecimal `data-release-sha256` for a `data-native-install="release"` command. `verifySite` reads `.site-dist/index.html` and `.site-dist/privacy/index.html`, checks that the compiled CSS exists, and exits 1 after printing every violation.

- [ ] **Step 5: Run focused and build verification**

Run: `pnpm vitest run scripts/site/verify.test.ts && pnpm site:build`

Expected: tests pass and the Tailwind build completes. Task 2 supplies the public HTML pages required by `site:verify`.

- [ ] **Step 6: Commit the build contract**

```bash
git add LICENSE package.json pnpm-lock.yaml site/source/styles.css site/source/site-config.js scripts/site/build.mjs scripts/site/verify.mjs scripts/site/verify.test.ts
git commit -m "feat: add marketplace site build contract"
```

### Task 2: Product and privacy pages

**Files:**
- Create: `site/source/index.html`
- Create: `site/source/privacy/index.html`
- Create: `site/source/assets/arthur.svg`
- Create: `site/source/site.js`
- Modify: `scripts/site/verify.test.ts`

**Interfaces:**
- Consumes `SITE_CONFIG` from `./site-config.js`.
- Produces static semantic page landmarks: `header`, `main`, `footer`, one `h1`, `#install`, `#helper`, `#permissions`, `#privacy`, and `#support`.
- Produces `renderAvailability(config, document)` and `copyInstallCommand(button, navigator)` exported by `site.js` for direct unit tests.

- [ ] **Step 1: Add failing page-contract tests**

```ts
it("requires Chrome and Firefox slots but forbids Edge copy", () => {
  const errors = verifyHtml(
    '<h1>Arthur</h1><a data-store="chrome"></a><a data-store="firefox"></a>',
    "index.html",
  );
  expect(errors).toContain("index.html: missing section #permissions");
  expect(errors).not.toContain(expect.stringContaining("Edge"));
});
```

Add tests for `renderAvailability` that verify `null` makes the exact button disabled with text `Coming soon`, while an HTTPS store URL makes it an enabled external link. Add a `copyInstallCommand` test with a fake clipboard that asserts the button's status text becomes `Copied`.

- [ ] **Step 2: Run page-contract tests and verify they fail**

Run: `pnpm vitest run scripts/site/verify.test.ts`

Expected: FAIL because the page sections and browser functions do not exist.

- [ ] **Step 3: Build the HTML and Tailwind presentation**

Copy `public/icons/arthur.svg` to `site/source/assets/arthur.svg`. Create the two pages using local assets and Tailwind utility classes for all layout, typography, spacing, color, responsive grid, and button treatment. Do not load CDN Tailwind, fonts, icon libraries, or images.

Use this exact factual copy in the comparison:

```text
Download Markdown — Works with the extension alone. Your browser downloads the saved article as Markdown; media stays as remote links.
Save straight to your vault — Optional macOS helper. Arthur writes Markdown and browser-retrievable attachments to the folder you choose.
```

The helper section must call out macOS, optional installation, checksum verification, no elevated privileges, no self-update, and the exact fallback. With `nativeRelease: null`, show source installation:

```sh
git clone https://github.com/olhapi/arthur.git
cd arthur
corepack pnpm install --frozen-lockfile
pnpm native:install
```

and its matching `pnpm native:uninstall` command. Define the release-command markup but hide it until configuration is present:

```html
<code data-native-install="release" data-release-url="" data-release-sha256=""></code>
```

The privacy page provides the complete policy (scope, local processing/retention, no collection or sharing, native-message boundary, controls/removal, changes, and `oleh@olhapi.com`) and links back to `/` using a relative URL that works on Pages project sites.

The permissions table uses exactly the five descriptions from the approved spec. Link support to `mailto:oleh@olhapi.com` and the configured issue tracker. Include no Edge copy anywhere.

- [ ] **Step 4: Implement client behavior and minimal custom CSS**

In `site.js`, import `SITE_CONFIG`; replace each `[data-store]` element's `href`, `aria-disabled`, text, and state from configuration. Enable the release command only if `nativeRelease.url` is HTTPS and `nativeRelease.sha256` matches `/^[a-f0-9]{64}$/i`; otherwise retain the source-install panel. The copy handler uses `navigator.clipboard.writeText`, announces `Copied` through an `aria-live="polite"` element, and on rejection announces `Select and copy the command` without hiding the command.

Do not add stylesheet rules beyond the Task 1 theme, focus, and reduced-motion base styles. Use Tailwind classes rather than `@apply` or component CSS.

- [ ] **Step 5: Run complete local-page verification**

Run: `pnpm vitest run scripts/site/verify.test.ts && pnpm site:verify`

Expected: PASS. The output directory contains `index.html`, `privacy/index.html`, `styles.css`, `site.js`, `site-config.js`, and `assets/arthur.svg`.

- [ ] **Step 6: Commit the product pages**

```bash
git add site/source/index.html site/source/privacy/index.html site/source/assets/arthur.svg site/source/site.js scripts/site/verify.test.ts
git commit -m "feat: add Arthur marketplace site"
```

### Task 3: Native release activation contract

**Files:**
- Create: `scripts/site/site-config.test.ts`
- Create: `docs/marketplace-listing.md`
- Modify: `site/source/site-config.js`
- Modify: `site/source/site.js`

**Interfaces:**
- Consumes `SITE_CONFIG.nativeRelease` with either `null` or `{ version: string, url: string, sha256: string, sourceUrl: string }`.
- Produces an enabled release command only from a versioned HTTPS asset and its 64-hex SHA-256.

- [ ] **Step 1: Write failing release-state tests**

```ts
import { describe, expect, it } from "vitest";
import { isNativeRelease } from "../../site/source/site.js";

describe("isNativeRelease", () => {
  it("accepts an immutable HTTPS asset with a SHA-256", () => {
    expect(isNativeRelease({
      version: "0.1.0",
      url: "https://github.com/olhapi/arthur/releases/download/v0.1.0/arthur-native-macos.tar.gz",
      sha256: "a".repeat(64),
      sourceUrl: "https://github.com/olhapi/arthur/blob/v0.1.0/scripts/native-host/install.mjs",
    })).toBe(true);
  });

  it("rejects latest URLs and missing checksums", () => {
    expect(isNativeRelease({ version: "0.1.0", url: "https://example.test/latest", sha256: "", sourceUrl: "https://example.test" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run release-state tests and verify they fail**

Run: `pnpm vitest run scripts/site/site-config.test.ts`

Expected: FAIL because `isNativeRelease` is not exported.

- [ ] **Step 3: Implement strict release validation and marketplace release procedure**

Export `isNativeRelease(value)` from `site.js`. It requires a nonempty semver-like version, an HTTPS GitHub Releases `/download/v<same-version>/` URL, a 64-character SHA-256, and an HTTPS source URL. Use it both to render the page and to reject invalid configuration in `scripts/site/verify.mjs`.

Document the activation sequence in `docs/marketplace-listing.md`: publish signed/notarized macOS asset and checksum first; copy their immutable versioned URLs into `SITE_CONFIG`; run `pnpm site:verify`; inspect the built page; then merge. State explicitly that no release command appears before that sequence completes.

- [ ] **Step 4: Run strict-release and site checks**

Run: `pnpm vitest run scripts/site/site-config.test.ts scripts/site/verify.test.ts && pnpm site:verify`

Expected: PASS with the current null release configuration and all invalid-release tests passing.

- [ ] **Step 5: Commit the release activation contract**

```bash
git add scripts/site/site-config.test.ts site/source/site-config.js site/source/site.js scripts/site/verify.mjs docs/marketplace-listing.md
git commit -m "feat: guard native helper release installation"
```

### Task 4: Marketplace handoff and Pages delivery

**Files:**
- Create: `.github/workflows/deploy-pages.yml`
- Modify: `docs/marketplace-listing.md`
- Modify: `README.md`

**Interfaces:**
- Consumes built `.site-dist` from `pnpm site:verify`.
- Produces a GitHub Pages artifact containing only `.site-dist`.
- Produces review metadata for Chrome and Firefox, not a public application feature.

- [ ] **Step 1: Write the failing deployment-contract test**

Add this test to `scripts/site/verify.test.ts`:

```ts
import { verifyWorkflow } from "./verify.mjs";

it("requires immutable action SHAs and the site verification command", () => {
  const errors = verifyWorkflow("uses: actions/checkout@v4\nrun: pnpm site:build");
  expect(errors).toContain("workflow: mutable action reference actions/checkout@v4");
  expect(errors).toContain("workflow: missing pnpm site:verify");
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm vitest run scripts/site/verify.test.ts`

Expected: FAIL because `verifyWorkflow` is not exported.

- [ ] **Step 3: Add listing handoff, workflow, and implementation**

Create `docs/marketplace-listing.md` with the exact title/short/long descriptions, user-visible permission reasons, privacy URL, support contact/website, local-only/no-remote-code declarations, source-package and native-messaging reviewer instructions, screenshot checklist, and a two-browser URL checklist. It must contain no store URL before one is assigned.

Implement `verifyWorkflow(workflow)` in `scripts/site/verify.mjs`. It rejects every `uses:` value that does not end in a full 40-hex commit SHA, requires `pnpm site:verify`, and requires the upload path `.site-dist`.

Create `.github/workflows/deploy-pages.yml` with `contents: read`, `pages: write`, and `id-token: write` only where required; separate build and deploy jobs; Pages environment; concurrency that does not cancel active production deploys; and these immutable pins:

```yaml
uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
uses: actions/configure-pages@983d7736d9b0ae728b81ab479565c72886d7745b
uses: actions/upload-pages-artifact@56afc609e74202658d3ffba0e8f6dda462b719fa
uses: actions/deploy-pages@d6db1c25d18c964f5a0c1b4a5b0ce7a6678848cb
```

The build job runs `corepack enable`, `pnpm install --frozen-lockfile`, and `pnpm site:verify`, then uploads only `.site-dist`. The deploy job deploys the `github-pages` artifact. Enable the workflow only on pushes to `main` that touch `site/**`, `scripts/site/**`, `package.json`, `pnpm-lock.yaml`, or the workflow itself, and with `workflow_dispatch`.

Add a concise README section linking to the source site and its local verification command.

- [ ] **Step 4: Run page, workflow, and repository verification**

Run: `pnpm vitest run scripts/site/verify.test.ts scripts/site/site-config.test.ts && pnpm site:verify && git diff --check`

Expected: PASS. `verifyWorkflow` accepts the committed workflow and rejects tags/branches.

- [ ] **Step 5: Commit marketplace delivery**

```bash
git add docs/marketplace-listing.md .github/workflows/deploy-pages.yml README.md scripts/site/verify.mjs scripts/site/verify.test.ts
git commit -m "ci: deploy Arthur marketplace site"
```

### Task 5: Browser-level accessibility and final acceptance

**Files:**
- Modify: `scripts/site/verify.mjs`
- Modify: `docs/marketplace-listing.md`

**Interfaces:**
- Consumes `.site-dist` generated by `pnpm site:build`.
- Produces reproducible terminal and browser acceptance evidence; no production release or marketplace submission.

- [ ] **Step 1: Add failing accessibility-output assertions**

```ts
it("requires one h1, skip link, live copy status, and reduced-motion CSS", () => {
  const errors = verifyHtml('<h1>Arthur</h1>', "index.html");
  expect(errors).toContain("index.html: missing skip link");
  expect(errors).toContain("index.html: missing aria-live copy status");
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm vitest run scripts/site/verify.test.ts`

Expected: FAIL until the output checks enforce these accessibility contracts.

- [ ] **Step 3: Implement checks and record manual acceptance procedure**

Extend `verifyHtml` to enforce exactly one `h1`, a skip link to `#main-content`, a polite live region, semantic `main`, local stylesheet, Chrome/Firefox store slots, and the required section IDs. Extend `verifySite` to require `prefers-reduced-motion` in `styles.css`.

Append a manual release checklist to `docs/marketplace-listing.md`: at 320px, 768px, and 1440px, tab from the skip link through each control; test the helper-source command copy success and denial behavior; verify JavaScript-disabled support and privacy links; and check Chrome/Firefox store buttons after URLs are configured. Include a final claim-to-manifest comparison against `wxt.config.ts`.

- [ ] **Step 4: Run all relevant verification**

Run: `pnpm test -- --run scripts/site/verify.test.ts scripts/site/site-config.test.ts && pnpm site:verify && pnpm typecheck && git diff --check`

Expected: all focused site tests, generated-output checks, existing TypeScript check, and whitespace check pass.

- [ ] **Step 5: Inspect the real local static page**

Run: `python3 -m http.server 4173 --directory .site-dist`

Expected: a local server returns the product page at `/` and the complete privacy policy at `/privacy/`. Inspect both in a browser, then stop the server.

- [ ] **Step 6: Commit acceptance improvements**

```bash
git add scripts/site/verify.mjs scripts/site/verify.test.ts docs/marketplace-listing.md
git commit -m "test: verify marketplace site accessibility"
```

## Final execution gate

Before calling the work complete, run `pnpm site:verify`, the focused Vitest suite, `pnpm typecheck`, and `git diff --check`; inspect the generated site in a real local browser. Do not publish GitHub Pages, create a GitHub Release, publish a store listing, or claim that the native release installer is available unless its signed asset, immutable URL, and SHA-256 have actually been produced and verified.
