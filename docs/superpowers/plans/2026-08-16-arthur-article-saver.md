# Arthur Article Saver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a one-click Chrome/Edge/Firefox extension and macOS native helper that save rendered articles as Obsidian Markdown with original media in a shared lowercase `attachments/` directory.

**Architecture:** A WXT content script performs browser-DOM extraction and Markdown conversion, while a background coordinator streams media through the unchanged typed native-messaging interface. A self-contained Rust binary mirrors the canonical Zod contracts with strict `serde` enums. Its deep `Vault` module owns destination and attachment directory descriptors, hides every raw mutation path behind its interface, and uses descriptor-relative no-follow operations to install attachments before atomically committing the note last.

**Tech Stack:** TypeScript 7.0.2, WXT 0.21.4, Vitest 4.1.10, happy-dom 20.11.2, Mozilla Readability 0.6.0, DOMPurify 3.4.13, Turndown 7.2.4, Zod 4.4.3, Node.js 22+ and pnpm 10.32.1 for extension development, Rust 1.97.1 for the macOS host, and cargo-audit 0.22.2 for the locked Cargo graph.

## Global Constraints

- Browser targets are Chrome, Edge, and Firefox; the native helper installer supports macOS only.
- Article notes are written directly into the selected folder as `<sanitized-title>.md`; media is written beneath its lowercase `attachments/` subfolder.
- Frontmatter contains exactly `title` and `source`; both are required.
- Saved media uses Obsidian embeds in the form `![[attachments/<filename>]]`.
- Preserve original media bytes, including animated GIF/WebP and other image formats; do not transcode.
- Save direct HTTP(S) audio/video files; leave streaming manifests and iframes as remote links.
- A matching normalized `source` overwrites its existing note in place; a same-title/different-source note must never be overwritten.
- Resource limits are 100 MiB per image, 2 GiB per audio/video file, and 4 GiB total per save.
- Production writes must remain inside the real selected destination and must reject child symlink escapes.
- The Rust `Vault` module owns the destination and `attachments/` directory descriptors; no raw child mutation path or descriptor crosses its interface.
- Every staging, attachment, probe, cleanup, and note mutation uses descriptor-relative no-follow `rustix` operations; the note is renamed last.
- The browser-side Zod schemas are the canonical JSON interface and stay wire-compatible; strict Rust `serde` enums and shared fixtures must match every variant.
- Normalize both the incoming source and every stored frontmatter source in Rust before comparing them.
- After any framing, UTF-8, or JSON failure, permanently poison that decoder, emit at most one typed error, and terminate the native connection without parsing later bytes.
- The installed native host is one binary with no Node runtime, launcher, copied `node_modules`, or shell `PATH` dependency.
- Use vanilla HTML, CSS, and TypeScript; do not add React, Vue, Svelte, Plasmo, `turndown-plugin-gfm`, `sanitize-filename`, jszip, tsup, jsdom, date-fns, or fflate.
- The Rust crate's only direct runtime dependencies are `serde` 1.0.229, `serde_json` 1.0.151, `rustix` 1.1.4, `url` 2.5.8, `sha2` 0.11.0, and `base64` 0.23.1, with the exact features in Task 3.
- Third-party dependencies must be actively maintained, non-deprecated, necessary, audited, and pinned exactly in `pnpm-lock.yaml` and `native/Cargo.lock`.
- `cargo audit --file native/Cargo.lock` is mandatory. If cargo-audit 0.22.2 cannot be installed and version-verified, stop; never skip or weaken the gate.
- Every native build/gate command runs through `node scripts/rust-toolchain.mjs <cargo-args...>`. The adapter resolves exact toolchain 1.97.1 Cargo/rustc binaries, injects only a copied child environment, and prevents fallback to Homebrew Rust 1.94. This is build-time only and does not change the installed host's independence from Homebrew and Node.
- Every behavior task follows red-green-refactor and ends in a Conventional Commit.
- Terra implements each SDD task; Sol performs the independent specification and quality reviews before the task is accepted.

---

## File Map

- `package.json`: exact dependencies and repository-wide scripts.
- `pnpm-lock.yaml`: immutable dependency resolution.
- `tsconfig.json`: WXT, shared, and test TypeScript settings.
- `vitest.config.ts`: Node default with per-file happy-dom opt-in.
- `wxt.config.ts`: extension identity, permissions, browser targets, and manifest settings.
- `docs/dependencies.md`: npm/crates.io registry, repository-activity, advisory, and audit evidence.
- `src/shared/constants.ts`: host name, protocol version, limits, and chunk size.
- `src/shared/settings.ts`: validated extension settings.
- `src/shared/protocol.ts`: canonical Zod schemas and inferred native request/response types.
- `src/shared/protocol.contract.test.ts`: canonical TypeScript validation of shared JSON fixtures.
- `src/article/source.ts`: final-page source URL normalization.
- `src/article/resources.ts`: rendered resource URL materialization and media classification.
- `src/article/markdown.ts`: sanitization, Turndown rules, placeholders, and Obsidian rewriting.
- `src/article/extract.ts`: Readability pipeline and extracted-article contract.
- `tests/contracts/native-messages.json`: shared valid/invalid client and host message fixtures consumed by TypeScript and Rust.
- `rust-toolchain.toml`: exact Rust 1.97.1 toolchain with rustfmt and clippy.
- `scripts/rust-toolchain.mjs`: dependency-free build-time adapter that resolves and verifies exact Rust 1.97.1 binaries before spawning Cargo.
- `scripts/rust-toolchain.test.ts`: behavior tests for toolchain resolution, version rejection, forwarding, child environment, signals, and exit status.
- `native/Cargo.toml`: macOS host crate and six exact direct dependencies.
- `native/Cargo.lock`: immutable native dependency resolution.
- `native/src/protocol.rs`: strict serde enums plus semantic validation matching canonical Zod contracts.
- `native/src/framing.rs`: native-message frame encoder and permanently poisoning decoder.
- `native/src/vault/mod.rs`: deep Vault interface; owns destination/attachments descriptors and opaque save transactions.
- `native/src/vault/fs.rs`: private descriptor-relative open/create/rename/unlink/sync implementation.
- `native/src/vault/names.rs`: private filename, extension, and content-addressing implementation.
- `native/src/vault/frontmatter.rs`: private YAML serialization and normalized source discovery.
- `native/src/vault/transaction.rs`: private staged-media and commit-last transaction implementation.
- `native/src/session.rs`: protocol-order adapter from messages to opaque Vault transactions.
- `native/src/server.rs`: validated request dispatcher and error mapping.
- `native/src/lib.rs`: native modules and testable host runner.
- `native/src/main.rs`: stdin/stdout/stderr binary adapter.
- `native/tests/contracts.rs`: Rust parity tests over the shared JSON fixture.
- `native/tests/vault_transaction.rs`: public Vault-transaction integration and failure-order tests.
- `native/tests/server.rs`: protocol-order and typed-error integration tests.
- `native/tests/native_host.rs`: real-binary length-prefixed and decoder-poison integration tests.
- `src/background/native-client.ts`: browser native-port request/response adapter.
- `src/background/media-transfer.ts`: fetch-stream to bounded base64 chunks.
- `src/background/status.ts`: badge and conditional popup state.
- `src/background/save-coordinator.ts`: end-to-end browser save orchestration.
- `entrypoints/content.ts`: WXT content-message bridge.
- `entrypoints/background.ts`: WXT action and coordinator wiring.
- `entrypoints/options/*`: destination configuration UI.
- `entrypoints/status/*`: failure/warning detail UI.
- `scripts/native-host/*.mjs`: single-binary install, verify, and uninstall tooling.
- `scripts/smoke/*.mjs`: built-artifact and helper acceptance checks.
- `tests/fixtures/article.html`: deterministic browser article fixture.
- `README.md`: setup, usage, builds, installation, and troubleshooting.

---

## Execution Checkpoint

Tasks 1 and 2 are already complete and are retained below as historical execution records; do not rerun or edit them. Their Node-native setup was part of the rejected Task 3 commit. Revised Task 3 explicitly deletes `src/native/*.ts` and `tsconfig.native.json`, removes the native `tsc`/`@types/node` consequences from repository configuration, and replaces them with the locked Rust crate before any later task executes.

---

### Task 1: Verified foundation and shared contracts

**Files:**
- Create: `package.json`
- Create: `pnpm-lock.yaml`
- Create: `.gitignore`
- Create: `tsconfig.json`
- Create: `tsconfig.native.json`
- Create: `vitest.config.ts`
- Create: `wxt.config.ts`
- Create: `docs/dependencies.md`
- Create: `src/shared/constants.ts`
- Create: `src/shared/settings.ts`
- Create: `src/shared/protocol.ts`
- Test: `src/shared/settings.test.ts`
- Test: `src/shared/protocol.test.ts`

**Interfaces:**
- Produces: `ArthurSettingsSchema`, `ArthurSettings`, `ClientMessageSchema`, `HostMessageSchema`, `ClientMessage`, `HostMessage`, `NATIVE_HOST_NAME`, `PROTOCOL_VERSION`, `MEDIA_LIMITS`, and `NATIVE_CHUNK_BYTES`.
- Consumes: none.

- [ ] **Step 1: Complete dependency due diligence before installing packages**

Run the required registry checks for every selected package:

```bash
rtk proxy pnpm view @mozilla/readability version time deprecated
rtk proxy pnpm view dompurify version time deprecated
rtk proxy pnpm view turndown version time deprecated
rtk proxy pnpm view zod version time deprecated
rtk proxy pnpm view wxt version time deprecated
rtk proxy pnpm view typescript version time deprecated
rtk proxy pnpm view vitest version time deprecated
rtk proxy pnpm view happy-dom version time deprecated
rtk proxy pnpm view @types/node version time deprecated
rtk proxy pnpm view @types/turndown version time deprecated
```

Inspect each package's primary GitHub repository for a recent commit/release and its Security/Advisories page. Record the check date, exact version, latest activity date, deprecation result, advisory result, repository URL, purpose, and keep/omit decision in `docs/dependencies.md`. Explicitly record that `tsx`, `date-fns`, and `fflate` are omitted because the accepted design has no direct-TypeScript runtime script, date formatting, or ZIP fallback.

- [ ] **Step 2: Create the exact package and toolchain configuration**

Use these exact package versions:

```json
{
  "name": "arthur",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.32.1",
  "engines": { "node": ">=22.0.0" },
  "scripts": {
    "postinstall": "wxt prepare",
    "dev": "wxt",
    "dev:firefox": "wxt -b firefox",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "wxt prepare && tsc --noEmit && tsc -p tsconfig.native.json --noEmit",
    "build:native": "tsc -p tsconfig.native.json",
    "build:chrome": "wxt build -b chrome",
    "build:edge": "wxt build -b edge",
    "build:firefox": "wxt build -b firefox",
    "build": "pnpm build:native && pnpm build:chrome && pnpm build:edge && pnpm build:firefox",
    "zip": "wxt zip -b chrome && wxt zip -b edge && wxt zip -b firefox",
    "verify": "pnpm test && pnpm typecheck && pnpm build && pnpm audit --audit-level high"
  },
  "dependencies": {
    "@mozilla/readability": "0.6.0",
    "dompurify": "3.4.13",
    "turndown": "7.2.4",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@types/node": "26.2.0",
    "@types/turndown": "5.0.6",
    "happy-dom": "20.11.2",
    "typescript": "7.0.2",
    "vitest": "4.1.10",
    "wxt": "0.21.4"
  }
}
```

Configure strict TypeScript with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, and NodeNext output for `src/shared/**/*.ts` plus `src/native/**/*.ts`. Ignore `.output/`, `.wxt/`, `coverage/`, `dist/`, `node_modules/`, and `*.zip`.

- [ ] **Step 3: Install the exact dependency graph and audit it**

Run:

```bash
rtk pnpm install --frozen-lockfile=false
rtk pnpm audit --audit-level high
```

Expected: `pnpm-lock.yaml` records the exact direct versions above, `wxt prepare` succeeds, and audit exits 0. If an advisory or peer incompatibility appears, stop the task and report it rather than substituting a package silently.

- [ ] **Step 4: Write failing shared-contract tests**

Cover these assertions:

```ts
expect(() => ArthurSettingsSchema.parse({ destination: "relative/path" })).toThrow();
expect(ArthurSettingsSchema.parse({ destination: "/Vault/Clippings" })).toEqual({
  destination: "/Vault/Clippings",
});
expect(ClientMessageSchema.parse({ type: "hello", requestId: "r1", protocolVersion: 1 })).toMatchObject({
  type: "hello",
});
expect(() => ClientMessageSchema.parse({
  type: "media_chunk",
  sessionId: "a5a74c85-92de-4a5d-9768-4e66c4d64987",
  mediaId: "m1",
  sequence: -1,
  data: "AA==",
})).toThrow();
```

The discriminated schemas must cover `hello`, `test_destination`, `begin_save`, `begin_media`, `media_chunk`, `end_media`, `commit_save`, and `abort_save`, plus matching typed result, acknowledgement, warning, and error messages.

- [ ] **Step 5: Run the tests and verify RED**

Run:

```bash
rtk pnpm test -- src/shared/settings.test.ts src/shared/protocol.test.ts
```

Expected: FAIL because the shared modules do not exist.

- [ ] **Step 6: Implement the minimal shared contracts**

Define:

```ts
export const NATIVE_HOST_NAME = "com.olhapi.arthur";
export const PROTOCOL_VERSION = 1;
export const NATIVE_CHUNK_BYTES = 256 * 1024;
export const MEDIA_LIMITS = {
  image: 100 * 1024 * 1024,
  audio: 2 * 1024 * 1024 * 1024,
  video: 2 * 1024 * 1024 * 1024,
  total: 4 * 1024 * 1024 * 1024,
} as const;
```

Use Zod discriminated unions with strict objects and inferred exported types. Require UUID-shaped session identifiers, bounded non-empty media/request identifiers, nonnegative integer chunk sequences, base64 strings, normalized HTTP(S) sources, absolute destinations, and bounded message fields.

- [ ] **Step 7: Verify and commit**

Run:

```bash
rtk pnpm test -- src/shared/settings.test.ts src/shared/protocol.test.ts
rtk pnpm typecheck
rtk git diff --check
rtk git add package.json pnpm-lock.yaml .gitignore tsconfig.json tsconfig.native.json vitest.config.ts wxt.config.ts docs/dependencies.md src/shared
rtk git commit -m "chore: establish verified Arthur foundation"
```

Expected: both test files pass, both TypeScript configurations pass, and the dependency evidence matches the lockfile.

---

### Task 2: Rendered article extraction and Obsidian Markdown

**Files:**
- Create: `src/article/source.ts`
- Create: `src/article/resources.ts`
- Create: `src/article/markdown.ts`
- Create: `src/article/extract.ts`
- Test: `src/article/source.test.ts`
- Test: `src/article/resources.test.ts`
- Test: `src/article/markdown.test.ts`
- Test: `src/article/extract.test.ts`
- Create: `tests/fixtures/article.html`

**Interfaces:**
- Consumes: `MEDIA_LIMITS` from `src/shared/constants.ts`.
- Produces: `normalizeSource(raw: string): string`, `materializeRenderedResources(document: Document, baseUrl: string): void`, `classifyMedia(url: string, tagName: string, contentType?: string): MediaKind | "stream" | "unsupported"`, `extractArticle(document: Document, finalUrl: string): ExtractedArticle`, and `finalizeMarkdown(markdown: string, resolved: ReadonlyMap<string, string>): string`.
- Produces `ExtractedArticle = { title: string; source: string; markdown: string; media: ExtractedMedia[] }` and `ExtractedMedia = { id: string; url: string; originalName: string; kind: "image" | "audio" | "video"; placeholder: string }`.

- [ ] **Step 1: Write failing source and resource tests**

Use happy-dom per-file environment and assert:

```ts
expect(normalizeSource("HTTPS://Example.COM:443/a?q=1#part")).toBe("https://example.com/a?q=1");
expect(() => normalizeSource("file:///tmp/article.html")).toThrow();
expect(classifyMedia("https://cdn.test/photo.avif", "IMG")).toBe("image");
expect(classifyMedia("https://cdn.test/live.m3u8", "VIDEO", "application/vnd.apple.mpegurl")).toBe("stream");
```

Build a DOM containing relative `src`, `srcset`, `currentSrc`, `poster`, audio/video sources, an iframe, and an event handler. Assert resource materialization resolves only browser-retrievable HTTP(S) media and prefers the rendered selection.

- [ ] **Step 2: Run source/resource tests and verify RED**

Run:

```bash
rtk pnpm test -- src/article/source.test.ts src/article/resources.test.ts
```

Expected: FAIL because the source/resource modules do not exist.

- [ ] **Step 3: Implement source normalization and rendered resource materialization**

Use the platform `URL` class. Remove fragments, require HTTP(S), preserve path/query, and serialize the result. Clone before mutation; absolutize retained links; replace responsive sources with their effective `currentSrc`; retain iframe URLs as links; and classify HLS/DASH by extension or MIME type.

- [ ] **Step 4: Write failing Markdown and extraction tests**

From `tests/fixtures/article.html`, assert that extraction:

```ts
expect(article.title).toBe("All Media Formats");
expect(article.source).toBe("https://example.test/articles/media?edition=1");
expect(article.markdown).toContain("## Preserved heading");
expect(article.markdown).toContain("```ts");
expect(article.markdown).not.toContain("onclick=");
expect(article.media.map((item) => item.originalName)).toEqual(
  expect.arrayContaining(["animated.gif", "animated.webp", "diagram.svg", "photo.avif", "audio.mp3", "video.mp4"]),
);
```

Add focused cases for tables, strikethrough, blockquotes, lists, links, failed Readability extraction, duplicated media URLs, iframe links, and placeholder replacement:

```ts
expect(finalizeMarkdown("before arthur-media://m1 after", new Map([["m1", "hero--abc.webp"]])))
  .toBe("before ![[attachments/hero--abc.webp]] after");
```

- [ ] **Step 5: Run Markdown/extraction tests and verify RED**

Run:

```bash
rtk pnpm test -- src/article/markdown.test.ts src/article/extract.test.ts
```

Expected: FAIL because extraction and conversion are not implemented.

- [ ] **Step 6: Implement the extraction pipeline**

Instantiate Readability on the prepared clone, require a non-empty title and content, sanitize with an explicit DOMPurify allowlist/forbid list, and configure Turndown with project-owned fenced-code, table, and strikethrough rules. Assign deterministic per-extraction media IDs, deduplicate equal normalized URLs, substitute `arthur-media://<id>` placeholders, and leave streamed/iframe content as normal remote Markdown links.

- [ ] **Step 7: Verify and commit**

Run:

```bash
rtk pnpm test -- src/article
rtk pnpm typecheck
rtk git diff --check
rtk git add src/article tests/fixtures/article.html
rtk git commit -m "feat: extract articles as Obsidian Markdown"
```

Expected: article tests pass with original media URLs represented once and unsafe markup absent.

---

### Task 3: Replace the rejected TypeScript helper with the Rust Vault foundation

**Files:**
- Delete: `src/native/filenames.ts`
- Delete: `src/native/filenames.test.ts`
- Delete: `src/native/framing.ts`
- Delete: `src/native/framing.test.ts`
- Delete: `src/native/frontmatter.ts`
- Delete: `src/native/frontmatter.test.ts`
- Delete: `src/native/paths.ts`
- Delete: `src/native/paths.test.ts`
- Delete: `tsconfig.native.json`
- Create: `rust-toolchain.toml`
- Create: `scripts/rust-toolchain.mjs`
- Test: `scripts/rust-toolchain.test.ts`
- Create: `native/Cargo.toml`
- Create: `native/Cargo.lock`
- Create: `native/src/lib.rs`
- Create: `native/src/protocol.rs`
- Create: `native/src/framing.rs`
- Create: `native/src/vault/mod.rs`
- Create: `native/src/vault/fs.rs`
- Create: `native/src/vault/names.rs`
- Create: `native/src/vault/frontmatter.rs`
- Create: `native/tests/contracts.rs`
- Create: `tests/contracts/native-messages.json`
- Create: `src/shared/protocol.contract.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `tsconfig.json`
- Modify: `vitest.config.ts`
- Modify: `.gitignore`
- Modify: `docs/dependencies.md`

**Interfaces:**
- Consumes: the unchanged JSON shapes and limits in `src/shared/protocol.ts` and `src/shared/constants.ts`. The Zod schemas remain canonical; do not add, remove, or rename a wire field.
- Produces: strict `ClientMessage` and `HostMessage` serde enums; `parse_client(value: serde_json::Value) -> Result<ClientMessage, ProtocolError>`; `parse_host(value: serde_json::Value) -> Result<HostMessage, ProtocolError>`; `encode_frame(message: &HostMessage) -> Result<Vec<u8>, FrameError>`; `FrameDecoder::push(&mut self, bytes: &[u8]) -> Result<Vec<serde_json::Value>, FrameError>`; `FrameDecoder::finish(&mut self) -> Result<(), FrameError>`; and opaque `Vault::open(destination: &Path) -> Result<Vault, VaultError>` plus `Vault::probe(destination: &Path) -> Result<VaultProbe, VaultError>`.
- `Vault` owns private `OwnedFd` values for the resolved destination and `attachments/`. Its interface returns status/display values only; it never returns a descriptor or a child path that a caller can use for mutation.
- `VaultProbe` is `{ canonical_destination: PathBuf, writable: bool }`. `VaultError` has stable variants `InvalidDestination`, `NotDirectory`, `NotWritable`, `UnsafeChild`, `InvalidName`, `InvalidSource`, `InvalidTransition`, `MediaLimitExceeded`, `AttachmentConflict`, `UnresolvedPlaceholder`, and `Io`; path-bearing I/O details remain private.
- `FrameDecoder` has only `Active` and `Poisoned` states. Every length, framing, UTF-8, or JSON error transitions to `Poisoned`; every later `push` returns `FrameError::Poisoned` without inspecting its bytes.
- Produces the build-time interface `node scripts/rust-toolchain.mjs <cargo-args...>`. The script also exports dependency-injected `resolveToolchain(deps)` and `runCargo(args, deps)` for behavior tests; these are implementation seams, not runtime host dependencies.

- [ ] **Step 1: Build and behavior-test the exact Rust toolchain adapter**

First add `scripts/**/*.test.ts` to `vitest.config.ts`. Write `scripts/rust-toolchain.test.ts` against injected `execFileSync`, `spawn`, environment, and signal hooks. Do not inspect source text. Assert real behavior:

```ts
expect(() => runCargo([], deps)).toThrow(/cargo argument/i);
expect(resolveToolchain(deps)).toEqual({
  cargo: "/toolchains/1.97.1/bin/cargo",
  rustc: "/toolchains/1.97.1/bin/rustc",
  bin: "/toolchains/1.97.1/bin",
});
expect(spawn).toHaveBeenCalledWith(
  "/toolchains/1.97.1/bin/cargo",
  ["test", "--locked"],
  expect.objectContaining({
    stdio: "inherit",
    env: expect.objectContaining({
      RUSTC: "/toolchains/1.97.1/bin/rustc",
      PATH: `/toolchains/1.97.1/bin:${originalPath}`,
    }),
  }),
);
expect(parentEnvironment).toEqual(originalEnvironment);
```

Mock resolution must assert calls to `brew --prefix rustup`, then `<prefix>/bin/rustup which cargo --toolchain 1.97.1` and `which rustc --toolchain 1.97.1`. Add separate cases rejecting `rustc 1.97.0`, `rustc 1.97.10`, `cargo 1.97.0`, missing output, failed resolution, and empty arguments. Simulated child close code 23 must become adapter exit 23. Simulated `SIGINT`, `SIGTERM`, and `SIGHUP` must be forwarded to the child and handlers must be removed after close; a child signal exit must be re-emitted by the CLI process seam.

Run RED:

```bash
rtk pnpm test -- scripts/rust-toolchain.test.ts
```

Expected: FAIL because `scripts/rust-toolchain.mjs` does not exist.

Implement the adapter using only `node:child_process`, `node:path`, and `node:process`. `resolveToolchain` must call `execFileSync("brew", ["--prefix", "rustup"], { encoding: "utf8" })`, resolve `<prefix>/bin/rustup`, call that binary's `which` command separately for Cargo/rustc with `--toolchain 1.97.1`, and execute the returned binaries with `--version`. Require prefixes `cargo 1.97.1` and `rustc 1.97.1` followed by a space or end-of-line; `1.97.10` is not a match.

`runCargo` must reject an empty argument array, copy `process.env`, prepend `dirname(resolvedCargo)` plus `path.delimiter` to the copied `PATH`, set copied `RUSTC` to the resolved rustc, and spawn the resolved Cargo path with caller arguments and `stdio: "inherit"`. It must never mutate `process.env` or a user profile. Forward `SIGINT`, `SIGTERM`, and `SIGHUP`, remove handlers on completion, and propagate the child's exact exit code or terminating signal.

Bootstrap only rustup/toolchain availability before the first real adapter call:

```bash
if ! brew --prefix rustup >/dev/null 2>&1; then
  rtk brew install rustup
fi
RUSTUP_BIN="$(brew --prefix rustup)/bin"
rtk "$RUSTUP_BIN/rustup" toolchain install 1.97.1 --profile minimal --component rustfmt,clippy
rtk pnpm test -- scripts/rust-toolchain.test.ts
rtk node scripts/rust-toolchain.mjs --version
CARGO_AUDIT_BIN="${CARGO_HOME:-$HOME/.cargo}/bin/cargo-audit"
if [ ! -x "$CARGO_AUDIT_BIN" ] || [ "$("$CARGO_AUDIT_BIN" --version)" != "cargo-audit 0.22.2" ]; then
  rtk node scripts/rust-toolchain.mjs install cargo-audit --version 0.22.2 --locked
fi
rtk "$CARGO_AUDIT_BIN" --version
```

Expected: behavior tests pass, adapter Cargo reports `cargo 1.97.1`, its internal rustc verification reports exact `rustc 1.97.1`, and the standard Cargo-bin executable reports `cargo-audit 0.22.2`. If any resolution/version test fails, stop. Do not use raw Cargo/rustup wrappers after this bootstrap, remove `audit:native`, or substitute another audit.

- [ ] **Step 2: Record the verified dependency review through the exact-binary adapter**

Add a Rust table to `docs/dependencies.md` with these exact pins and the repository activity observed on 2026-08-16:

| Crate | Pin | Features | Repository activity | Advisory result |
| --- | --- | --- | --- | --- |
| `serde` | `1.0.229` | `derive` | `serde-rs/serde` 2026-07-25 | no RustSec entry |
| `serde_json` | `1.0.151` | default | `serde-rs/json` 2026-08-08 | no RustSec entry |
| `rustix` | `1.1.4` | `std`, `fs` only | `bytecodealliance/rustix` 2026-06-15 | no RustSec entry |
| `url` | `2.5.8` | default | `servo/rust-url` 2026-07-31 | no RustSec entry |
| `sha2` | `0.11.0` | no defaults | `RustCrypto/hashes` 2026-07-16 | RUSTSEC-2021-0100 patched since 0.9.8 |
| `base64` | `0.23.1` | `std`, no defaults | `marshallpierce/rust-base64` 2026-08-04 | RUSTSEC-2017-0004 patched since 0.5.2 |

Recheck, rather than assuming the recorded snapshot is still current:

```bash
rtk node scripts/rust-toolchain.mjs search serde --limit 1
rtk node scripts/rust-toolchain.mjs search serde_json --limit 1
rtk node scripts/rust-toolchain.mjs search rustix --limit 1
rtk node scripts/rust-toolchain.mjs search url --limit 1
rtk node scripts/rust-toolchain.mjs search sha2 --limit 1
rtk node scripts/rust-toolchain.mjs search base64 --limit 1
rtk node scripts/rust-toolchain.mjs info serde@1.0.229
rtk node scripts/rust-toolchain.mjs info serde_json@1.0.151
rtk node scripts/rust-toolchain.mjs info rustix@1.1.4
rtk node scripts/rust-toolchain.mjs info url@2.5.8
rtk node scripts/rust-toolchain.mjs info sha2@0.11.0
rtk node scripts/rust-toolchain.mjs info base64@0.23.1
```

Inspect each listed primary repository and the current RustSec database. If a pin is yanked, deprecated, inactive without an acceptable maintainer explanation, or newly vulnerable, stop and report the evidence; do not choose another version or crate silently.

- [ ] **Step 3: Replace the rejected Node-native configuration and write shared contract fixtures**

Delete every `src/native/*.ts` file from rejected commit `9a60adc` and delete `tsconfig.native.json`. Remove direct `@types/node` because the installed helper no longer uses Node. Keep Node 22+ for WXT and repository `.mjs` tooling.

Create `rust-toolchain.toml`:

```toml
[toolchain]
channel = "1.97.1"
profile = "minimal"
components = ["clippy", "rustfmt"]
```

Create `native/Cargo.toml` with no dev dependencies:

```toml
[package]
name = "arthur-native-host"
version = "0.1.0"
edition = "2024"
rust-version = "1.97.1"
publish = false

[dependencies]
base64 = { version = "=0.23.1", default-features = false, features = ["std"] }
rustix = { version = "=1.1.4", default-features = false, features = ["std", "fs"] }
serde = { version = "=1.0.229", features = ["derive"] }
serde_json = "=1.0.151"
sha2 = { version = "=0.11.0", default-features = false }
url = "=2.5.8"

[profile.release]
lto = "thin"
codegen-units = 1
strip = true
```

Create `tests/contracts/native-messages.json` with all eight client variants and all six host variants. Use this exact shape, extending the arrays only with explicit rejection cases:

```json
{
  "validClientMessages": [
    { "type": "hello", "requestId": "r1", "protocolVersion": 1 },
    { "type": "test_destination", "requestId": "r2", "destination": "/tmp/Arthur" },
    { "type": "begin_save", "requestId": "r3", "sessionId": "a5a74c85-92de-4a5d-9768-4e66c4d64987", "destination": "/tmp/Arthur", "source": "https://example.test/a", "title": "Article", "markdown": "arthur-media://m1" },
    { "type": "begin_media", "requestId": "r4", "sessionId": "a5a74c85-92de-4a5d-9768-4e66c4d64987", "mediaId": "m1", "source": "https://example.test/hero.webp", "kind": "image", "contentType": "image/webp", "byteLength": 4 },
    { "type": "media_chunk", "sessionId": "a5a74c85-92de-4a5d-9768-4e66c4d64987", "mediaId": "m1", "sequence": 0, "data": "AAEC/w==" },
    { "type": "end_media", "requestId": "r5", "sessionId": "a5a74c85-92de-4a5d-9768-4e66c4d64987", "mediaId": "m1", "chunks": 1 },
    { "type": "commit_save", "requestId": "r6", "sessionId": "a5a74c85-92de-4a5d-9768-4e66c4d64987" },
    { "type": "abort_save", "requestId": "r7", "sessionId": "a5a74c85-92de-4a5d-9768-4e66c4d64987", "reason": "browser stream failed" }
  ],
  "invalidClientMessages": [
    { "type": "hello", "requestId": "r1", "protocolVersion": 1, "extra": true },
    { "type": "begin_save", "requestId": "r3", "sessionId": "not-a-uuid", "destination": "/tmp/Arthur", "source": "file:///tmp/a", "title": "Article", "markdown": "Body" },
    { "type": "media_chunk", "sessionId": "a5a74c85-92de-4a5d-9768-4e66c4d64987", "mediaId": "m1", "sequence": -1, "data": "AA==" },
    { "type": "media_chunk", "sessionId": "a5a74c85-92de-4a5d-9768-4e66c4d64987", "mediaId": "m1", "sequence": 0, "data": "***" }
  ],
  "validHostMessages": [
    { "type": "hello_result", "requestId": "r1", "protocolVersion": 1, "hostName": "com.olhapi.arthur", "hostVersion": "0.1.0" },
    { "type": "test_destination_result", "requestId": "r2", "destination": "/tmp/Arthur", "writable": true },
    { "type": "save_result", "requestId": "r6", "sessionId": "a5a74c85-92de-4a5d-9768-4e66c4d64987", "savedPath": "/tmp/Arthur/Article.md" },
    { "type": "ack", "requestId": "chunk", "sessionId": "a5a74c85-92de-4a5d-9768-4e66c4d64987", "mediaId": "m1", "sequence": 0 },
    { "type": "warning", "requestId": "r5", "sessionId": "a5a74c85-92de-4a5d-9768-4e66c4d64987", "code": "media_fallback", "message": "Media remains remote" },
    { "type": "error", "code": "invalid_native_frame", "message": "Native message stream is invalid" }
  ],
  "invalidHostMessages": [
    { "type": "ack", "requestId": "chunk", "filename": "not-in-the-canonical-schema.webp" },
    { "type": "save_result", "requestId": "r6", "sessionId": "not-a-uuid", "savedPath": "relative.md" }
  ]
}
```

Set `resolveJsonModule: true` in `tsconfig.json`. `src/shared/protocol.contract.test.ts` must use `import fixtures from "../../tests/contracts/native-messages.json" with { type: "json" };` and assert every valid item passes its canonical Zod schema and every invalid item fails. `native/tests/contracts.rs` must read the same bytes with `include_str!("../../tests/contracts/native-messages.json")`, call Rust semantic validation, and make the same pass/fail assertions. Declare `pub mod protocol; pub mod framing; pub mod vault;` in `native/src/lib.rs` before the modules exist so the Rust test is RED.

- [ ] **Step 4: Update repository scripts and verify the Rust contract test is RED**

Update `package.json` to remove the native `tsc` invocation and add these exact scripts; retain all browser scripts and dependencies not explicitly removed:

```json
{
  "typecheck": "wxt prepare && tsc --noEmit",
  "test:native": "node scripts/rust-toolchain.mjs test --manifest-path native/Cargo.toml --locked",
  "format:native:check": "node scripts/rust-toolchain.mjs fmt --manifest-path native/Cargo.toml --all -- --check",
  "lint:native": "node scripts/rust-toolchain.mjs clippy --manifest-path native/Cargo.toml --all-targets --locked -- -D warnings",
  "audit:native": "test \"$(\"${CARGO_HOME:-$HOME/.cargo}/bin/cargo-audit\" --version)\" = \"cargo-audit 0.22.2\" && PATH=\"${CARGO_HOME:-$HOME/.cargo}/bin:$PATH\" node scripts/rust-toolchain.mjs audit --file native/Cargo.lock",
  "build:native": "node scripts/rust-toolchain.mjs build --manifest-path native/Cargo.toml --release --locked",
  "verify:native": "pnpm test:native && pnpm format:native:check && pnpm lint:native && pnpm build:native && pnpm audit:native",
  "build": "pnpm build:native && pnpm build:chrome && pnpm build:edge && pnpm build:firefox",
  "verify": "pnpm test && pnpm typecheck && pnpm verify:native && pnpm build && pnpm audit --audit-level high"
}
```

Add `native/target/` to `.gitignore`, run `rtk pnpm install --frozen-lockfile=false` to remove the direct `@types/node` entry from `pnpm-lock.yaml`, then run:

```bash
rtk pnpm test -- src/shared/protocol.contract.test.ts
rtk node scripts/rust-toolchain.mjs test --manifest-path native/Cargo.toml --test contracts
```

Expected: the TypeScript fixture test passes against canonical Zod; Rust compilation fails because `protocol`, `framing`, and `vault` are not implemented.

- [ ] **Step 5: Implement strict protocol parity and a permanently poisoning frame decoder**

In `native/src/protocol.rs`, define internally tagged enums with `#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase", deny_unknown_fields)]`. Use `u64` for nonnegative JSON integer fields and `Option<T>` only for fields optional in Zod. `parse_client` must enforce the same length, UUID, MIME, media-size, chunk-size, base64, HTTP(S), and absolute-destination rules as `ClientMessageSchema`; it must normalize every client source with `url::Url`, clear its fragment, and store the serialized result. `parse_host` must enforce every HostMessage Zod length/UUID/path constraint so the shared valid/invalid host fixtures have the same result in both languages. `encode_frame` validates the host value before serialization.

In `native/src/framing.rs`, use `MAX_NATIVE_MESSAGE_BYTES = 1_048_576` and this stateful interface:

```rust
pub struct FrameDecoder {
    state: DecoderState,
    buffered: Vec<u8>,
}

pub enum FrameError {
    ZeroLength,
    Oversized(u32),
    InvalidUtf8,
    InvalidJson,
    TruncatedFrame,
    Poisoned,
}

impl FrameDecoder {
    pub fn new() -> Self;
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<serde_json::Value>, FrameError>;
    pub fn finish(&mut self) -> Result<(), FrameError>;
}

pub fn encode_frame(message: &HostMessage) -> Result<Vec<u8>, FrameError>;
```

Add unit tests for split headers, split bodies, coalesced frames, normal empty-stream `finish`, truncated header/body at `finish`, zero length, 1 MiB + 1, invalid UTF-8, invalid JSON, and a valid frame after each failure. Each failure must poison immediately; each post-failure call to `push` or `finish` must return `Poisoned`, leave no decoded value, and not grow `buffered`.

- [ ] **Step 6: Write failing Vault tests at the module's small interface and private helper seams**

Use only `std::env::temp_dir`, `std::fs`, process ID, and an atomic counter for test directories; do not add `tempfile`. Cover:

```rust
assert!(Vault::probe(&absolute_directory)?.writable);
assert!(Vault::open(&symlink_to_absolute_directory).is_ok());
assert!(matches!(Vault::open(&destination_with_symlinked_attachments), Err(VaultError::UnsafeChild)));
assert_eq!(normalize_source("HTTPS://Example.COM:443/a#x")?, "https://example.com/a");
assert_eq!(content_addressed_name("hero", "b7c87d380f4e99ff", "webp")?, "hero--b7c87d380f4e.webp");
assert_eq!(serialize_note("A \"title\"", "https://example.test/a", "Body\n")?, "---\ntitle: \"A \\\"title\\\"\"\nsource: \"https://example.test/a\"\n---\n\nBody\n");
```

Also assert traversal/absolute/NUL child names are rejected by private basename validation, control characters and `:` are removed from stems, empty/dot stems become `article`, truncation stops on a valid UTF-8 boundary at 180 bytes, a write probe leaves no file, stored `HTTPS://Example.COM:443/a#old` matches incoming `https://example.com/a`, malformed/non-Arthur frontmatter is ignored, and only direct `.md` children are scanned.

- [ ] **Step 7: Implement the deep Vault foundation with descriptor-relative no-follow operations**

`Vault::open` may use `std::fs::canonicalize` only for the user-selected root so a legitimate root symlink resolves once. It must then open that resolved root through `rustix::fs::openat(CWD, ..., RDONLY | DIRECTORY | CLOEXEC | NOFOLLOW, Mode::empty())`, create `attachments` with `mkdirat` when absent, and open it relative to the destination descriptor with `DIRECTORY | NOFOLLOW`. Verify both descriptors with `fstat`.

Keep descriptor operations in private `vault/fs.rs`. Provide only basename-taking internal functions built from `openat`, `mkdirat`, `renameat`, `renameat_with`, `unlinkat`, `statat`, `fsync`, and macOS `fcntl_fullfsync` where durable file sync is required. Never join a child onto the canonical destination for a mutation. `Vault::probe` must create a process/counter-named file with `WRONLY | CREATE | EXCL | CLOEXEC | NOFOLLOW`, close it, and `unlinkat` it in all outcomes.

Keep filename and frontmatter behavior private in `names.rs` and `frontmatter.rs`. Derive the basename from the normalized media URL path, preserve a recognized extension or derive it from the MIME allowlist, hash content with SHA-256, and use the first 12 lowercase hex characters. Scan direct directory entries through `rustix::fs::Dir::read_from`; open candidate notes with `openat(..., RDONLY | CLOEXEC | NOFOLLOW, ...)`, require a regular file with `fstat`, read only the bounded frontmatter prefix, and normalize both stored and incoming URLs before comparison.

- [ ] **Step 8: Lock, audit, verify, and commit the replacement**

Run in this order:

```bash
rtk node scripts/rust-toolchain.mjs generate-lockfile --manifest-path native/Cargo.toml
rtk pnpm test:native
rtk pnpm format:native:check
rtk pnpm lint:native
rtk pnpm build:native
rtk pnpm audit:native
rtk pnpm test -- src/shared/protocol.contract.test.ts
rtk pnpm typecheck
rtk pnpm audit --audit-level high
rtk git diff --check
rtk git status --short
```

Expected: Rust tests/lints/build and both audits exit 0; `native/Cargo.lock` is present; the only deleted production files are the rejected TypeScript helper and `tsconfig.native.json`; browser TypeScript still passes. Then commit exactly the Task 3 files:

```bash
rtk git add package.json pnpm-lock.yaml tsconfig.json vitest.config.ts .gitignore docs/dependencies.md rust-toolchain.toml scripts/rust-toolchain.mjs scripts/rust-toolchain.test.ts native tests/contracts/native-messages.json src/shared/protocol.contract.test.ts
rtk git add -u src/native tsconfig.native.json
rtk git commit -m "feat: replace native helper foundation with Rust"
```

---

### Task 4: Descriptor-owned streaming Rust save transaction

**Files:**
- Create: `native/src/vault/transaction.rs`
- Create: `native/src/session.rs`
- Create: `native/src/server.rs`
- Create: `native/src/main.rs`
- Create: `native/tests/vault_transaction.rs`
- Create: `native/tests/server.rs`
- Create: `native/tests/native_host.rs`
- Modify: `native/src/vault/mod.rs`
- Modify: `native/src/lib.rs`

**Interfaces:**
- Consumes: Task 3 `ClientMessage`, `HostMessage`, `FrameDecoder`, and opaque `Vault`; the canonical JSON fields remain unchanged.
- Extends the deep Vault interface with `Vault::begin(self, spec: SaveSpec) -> Result<VaultTransaction, VaultError>`. `VaultTransaction` is opaque and owns the descriptors after `Vault` is consumed.
- Produces: `VaultTransaction::begin_media(&mut self, spec: MediaSpec) -> Result<(), VaultError>`, `append_chunk(&mut self, media_id: &str, sequence: u64, bytes: &[u8]) -> Result<(), VaultError>`, `finish_media(&mut self, media_id: &str, chunks: u64) -> Result<MediaDisposition, VaultError>`, `commit(self) -> Result<SavedNote, VaultError>`, and `abort(self) -> Result<(), VaultError>`.
- Produces: `SessionManager::handle(&mut self, message: ClientMessage) -> HostMessage`, `SessionManager::abort_all(&mut self)`, and `run_native_host<R: Read, W: Write, E: Write>(input: R, output: W, diagnostics: E) -> io::Result<()>`.
- The session adapter maps `byteLength: 0` to an unknown length; positive values are exact declarations. A successful chunk response is canonical `ack` with `requestId: "chunk"` plus `sessionId`, `mediaId`, and `sequence`, so no wire field is added. A successful `end_media` uses the request's ID and returns `ack`; attachment names stay private to Vault.

- [ ] **Step 1: Write failing Vault transaction tests through the public interface**

In `native/tests/vault_transaction.rs`, construct `SaveSpec` and `MediaSpec` values directly for the public-interface cases. Start `native/src/vault/transaction.rs` with a `#[cfg(test)]` module for commit-order fault cases, using private `CommitFault::{BeforeFirstAttachmentRename, BeforeNoteRename}` values and a test-only `commit_with_fault(self, CommitFault)` internal seam. Assert:

- Ordered chunks produce byte-identical GIF, animated WebP, SVG, AVIF, MP3, and MP4 attachments.
- The URL basename plus SHA-256 produces `hero--b7c87d380f4e.webp`; equal content is installed once, while an existing same-name/different-digest file returns `VaultError::AttachmentConflict`.
- Positive declared lengths must equal completed bytes; zero accepts an unknown final length, including an actually empty file.
- A deliberately mismatched `chunks` count discards that media's staged file, records `<normalized-source>` as its fallback, and returns `MediaDisposition::Fallback` without aborting the article.
- Out-of-order chunks, unknown/closed media IDs, duplicate `finish_media`, open media at commit, and individual/total limit overflow produce stable typed errors before the note rename.
- `abort` removes every known staged file and the stage directory using descriptors.
- Renaming the visible `attachments/` path and replacing it with an outside symlink after `Vault::open` cannot redirect the transaction: the held descriptor remains the only attachment mutation target.
- `CommitFault::BeforeNoteRename` leaves the prior note byte-identical; `CommitFault::BeforeFirstAttachmentRename` exposes no note update.
- A success installs and syncs attachments first, writes/syncs the note temp file, renames the note last, syncs the destination directory, and removes the stage.
- Matching stored/incoming normalized sources replace the old note in place after a title change; same-title/different-source creates `<stem>--<12-char-source-hash>.md` with no unrelated overwrite.

- [ ] **Step 2: Run transaction tests and verify RED**

Run:

```bash
rtk node scripts/rust-toolchain.mjs test --manifest-path native/Cargo.toml --test vault_transaction
```

Expected: FAIL because `Vault::begin`, `VaultTransaction`, and `vault/transaction.rs` do not exist.

- [ ] **Step 3: Implement staging, fallback mapping, and commit-last inside Vault**

Define the public value types without descriptors or mutation paths:

```rust
pub struct SaveSpec {
    pub session_id: String,
    pub title: String,
    pub source: String,
    pub markdown: String,
}

pub struct MediaSpec {
    pub media_id: String,
    pub source: String,
    pub kind: MediaKind,
    pub content_type: String,
    pub declared_bytes: Option<u64>,
}

pub enum MediaDisposition {
    Saved,
    Fallback { code: &'static str, message: &'static str },
}

pub struct SavedNote {
    pub display_path: PathBuf,
}
```

Create `.arthur-stage-<validated-session-uuid>` with `mkdirat(destination_fd, ..., 0700)` and open it with `DIRECTORY | CLOEXEC | NOFOLLOW`. Generate fixed internal temp basenames from a monotonically increasing counter; never use `mediaId`, title, source, or another untrusted string as a mutation path. Decode base64 in the session adapter, but stream bytes here through a descriptor-backed `std::fs::File` while incrementally updating `sha2::Sha256` and all resource counters.

At media finish, close and sync the staged file, compute its private final attachment basename, and retain either a saved mapping or normalized remote fallback mapping for that media ID. At commit, replace every successful `arthur-media://<id>` with `![[attachments/<private-name>]]`, replace every failed mapping with `<normalized-source>`, and reject any unresolved Arthur placeholder before any final rename.

Install each attachment with `renameat_with(..., RenameFlags::NOREPLACE)`. If the name already exists, open it through the attachments descriptor with `NOFOLLOW`, hash it, and reuse only an equal digest. Sync every new attachment and the attachments directory. Serialize the exact two-field note, write it to an exclusive stage file, call macOS full sync, and then use `renameat` only for a verified matching-source replacement or `renameat_with(..., NOREPLACE)` for a new filename. Rename the note last, sync the destination directory, then remove the emptied stage. A process killed before the note rename can leave only a hidden stage/new immutable attachment; the old note remains intact. `Vault::open` must clean stale Arthur stages using descriptor-relative enumeration and no-follow unlinking before a new save.

- [ ] **Step 4: Write failing session, dispatcher, and real-process tests**

In `native/tests/server.rs`, assert the exact response sequence for `hello`, `test_destination`, `begin_save`, `begin_media`, `media_chunk`, `end_media`, `commit_save`, and `abort_save`. Cover version mismatch, invalid destination, duplicate/missing session, wrong transition, chunk sequence mismatch, recoverable media fallback, fatal commit failure, and typed codes that contain no article content, credential-bearing URL, media bytes, or raw child paths.

In `native/tests/native_host.rs`, spawn `env!("CARGO_BIN_EXE_arthur-native-host")`, write real little-endian frames, and assert:

```text
valid hello -> one valid hello_result on stdout, empty diagnostics
split/coalesced valid frames -> one response per request in order
invalid UTF-8 -> one invalid_native_frame error, then process exits nonzero
invalid JSON followed by valid hello -> only one error; no hello_result
zero/oversized frame followed by valid hello -> only one error; no hello_result
EOF with an active session -> process exits, old note unchanged
```

Capture stdout and stderr separately and validate every stdout value against a `HostMessage` before asserting fields.

- [ ] **Step 5: Run dispatcher/host tests and verify RED**

Run:

```bash
rtk node scripts/rust-toolchain.mjs test --manifest-path native/Cargo.toml --test server --test native_host
```

Expected: FAIL because the session adapter, dispatcher, and binary adapter do not exist.

- [ ] **Step 6: Implement synchronous validated dispatch and the fail-closed binary adapter**

Use a standard-library `HashMap<String, VaultTransaction>` in `SessionManager`; no async runtime is permitted. `begin_save` opens/consumes one Vault. `begin_media` translates zero byte length to `None`; `media_chunk` base64-decodes with the standard engine, enforces the 256 KiB decoded limit, and returns the tuple ack; `end_media` returns either ack or canonical warning; commit removes the session and returns `save_result`; abort consumes and cleans the transaction.

Map errors to stable codes: `invalid_message`, `protocol_version_mismatch`, `invalid_destination`, `unsafe_child`, `session_not_found`, `invalid_transition`, `invalid_chunk`, `media_limit_exceeded`, `media_fallback`, `attachment_conflict`, and `commit_failed`. Messages must be actionable but path/content-redacted.

`run_native_host` reads bounded chunks, feeds one `FrameDecoder`, parses every value with `parse_client`, dispatches it, validates/serializes the `HostMessage`, and flushes one frame. On framing/UTF-8/JSON failure, write at most one `invalid_native_frame` error frame and return `InvalidData`; never call `push` again. On EOF, call `FrameDecoder::finish`: an empty buffer is normal, while a partial header/body is a poisoned `TruncatedFrame` and gets the same one-error/exit treatment. On normal EOF or input/output error, call `abort_all`. The binary `main` passes locked stdin/stdout/stderr handles to the runner. A normal EOF with no active transaction exits 0 and writes nothing. Default macOS `SIGTERM` termination needs no signal dependency: commit-last guarantees no partial note, and the next `Vault::open` reclaims a stale stage.

- [ ] **Step 7: Verify the native module and commit**

Run:

```bash
rtk pnpm test:native
rtk pnpm format:native:check
rtk pnpm lint:native
rtk pnpm build:native
rtk pnpm audit:native
rtk native/target/release/arthur-native-host </dev/null
rtk pnpm typecheck
rtk git diff --check
```

Expected: all Rust tests and gates pass; a normal EOF exits 0 with no stdout/stderr; malformed-stream tests prove permanent decoder poison; transaction tests prove descriptor anchoring and note-last behavior. Then commit:

```bash
rtk git add native/src native/tests
rtk git commit -m "feat: add transactional Rust native host"
```

---

### Task 5: Native client, streaming transfer, and save coordinator

**Files:**
- Create: `src/background/native-client.ts`
- Create: `src/background/media-transfer.ts`
- Create: `src/background/status.ts`
- Create: `src/background/save-coordinator.ts`
- Test: `src/background/native-client.test.ts`
- Test: `src/background/media-transfer.test.ts`
- Test: `src/background/status.test.ts`
- Test: `src/background/save-coordinator.test.ts`

**Interfaces:**
- Consumes: the unchanged shared messages/constants and `ExtractedArticle`. Successful filenames are deliberately not exposed by the canonical host schema; Vault finalizes successful placeholders.
- Produces: `NativeClient`, `preflightMedia(media: ExtractedMedia, fetcher: typeof fetch): Promise<PreparedMedia>`, `transferMedia(prepared: PreparedMedia, client: NativeClient): Promise<"saved" | "fallback">`, `StatusController`, and `SaveCoordinator.save(tabId: number, tabUrl: string): Promise<SaveOutcome>`.
- `NativeClient` depends on an injected `NativePortAdapter` with `postMessage`, `onMessage`, `onDisconnect`, and `disconnect`, so tests use real client logic without a browser mock library.
- `PreparedMedia` is `{ status: "eligible"; media: ExtractedMedia; response: Response; contentType: string; declaredBytes: number | undefined } | { status: "fallback"; media: ExtractedMedia; code: string; message: string }`. It retains an eligible body without buffering it, or carries a typed remote fallback. Chunk acknowledgements correlate on `sessionId` + `mediaId` + `sequence` and require `requestId: "chunk"`; normal request/response operations still correlate on `requestId`.

- [ ] **Step 1: Write failing native-client and transfer tests**

Assert request correlation, tuple correlation for canonical chunk acks, schema rejection, host disconnect, typed errors, one in-flight chunk for backpressure, exact 256 KiB decoded chunk bounds, ordered sequence numbers, empty files, stream failures, early size rejection from `Content-Length`, and incremental enforcement when it is absent. A stream/incremental failure after `begin_media` must send `end_media` with a deliberately mismatched chunk count; Task 4 returns `media_fallback`, discards the staged partial file, and keeps the article transaction usable.

- [ ] **Step 2: Run client/transfer tests and verify RED**

Run `rtk pnpm test -- src/background/native-client.test.ts src/background/media-transfer.test.ts` and expect missing-module failures.

- [ ] **Step 3: Implement native client and streaming transfer**

Wrap `browser.runtime.connectNative(NATIVE_HOST_NAME)` behind the injected adapter. Validate every response, resolve normal operations by request ID, resolve only a matching chunk tuple for `requestId: "chunk"`, and reject all pending operations on disconnect. Preflight every fetch through headers before `begin_save`, retaining eligible response streams without consuming their bodies and converting fetch/HTTP/known-size failures to remote fallbacks. During transfer, read `Response.body` incrementally, accumulate no more than `NATIVE_CHUNK_BYTES`, base64-encode each bounded chunk, await its tuple acknowledgement, and enforce individual plus total budgets before sending more bytes.

- [ ] **Step 4: Write failing status and coordinator tests**

Inject extraction, fetch, native client, settings, and status dependencies. Cover unconfigured destination, hello mismatch, extraction failure, full success, duplicate media, preflight fetch/HTTP failure rewritten to `<normalized-url>` before `begin_save`, oversized media fallback, midstream failure recorded by Vault as a remote fallback, streamed-link preservation, commit failure/abort, warning popup state, and badge transitions:

```ts
expect(status.calls).toEqual(["saving", "success"]);
expect(outcome).toMatchObject({ articlePath: "/Vault/Clippings/Article.md", warnings: [] });
```

- [ ] **Step 5: Run status/coordinator tests and verify RED**

Run `rtk pnpm test -- src/background/status.test.ts src/background/save-coordinator.test.ts` and expect missing-module failures.

- [ ] **Step 6: Implement orchestration and warning fallback**

Load validated settings, request extraction from the active tab, negotiate protocol, and preflight all direct resources. Replace placeholders for preflight failures with `<normalized-url>`, then begin one save whose remaining placeholders correspond exactly to eligible media. Stream each retained response; on a recoverable midstream failure, complete the media with the mismatch signal and retain the host warning. Commit without adding a response field or sending new Markdown: Task 4 Vault finalizes successful embeds and begun-media fallbacks internally. Abort on fatal failures. `StatusController` sets `…`, `✓`, or `!`, clears the popup before a new save, and enables `status.html` only for warning/error detail stored in extension-local storage.

- [ ] **Step 7: Verify and commit**

Run:

```bash
rtk pnpm test -- src/background
rtk pnpm typecheck
rtk git diff --check
rtk git add src/background
rtk git commit -m "feat: coordinate streamed article saves"
```

---

### Task 6: Cross-browser entrypoints and minimal UI

**Files:**
- Create: `entrypoints/content.ts`
- Create: `entrypoints/background.ts`
- Create: `entrypoints/options/index.html`
- Create: `entrypoints/options/main.ts`
- Create: `entrypoints/options/style.css`
- Create: `entrypoints/status/index.html`
- Create: `entrypoints/status/main.ts`
- Create: `entrypoints/status/style.css`
- Test: `entrypoints/options/main.test.ts`
- Test: `entrypoints/status/main.test.ts`
- Test: `entrypoints/background.test.ts`
- Modify: `wxt.config.ts`

**Interfaces:**
- Consumes: extraction, settings, coordinator, status, and native-client modules.
- Produces: WXT content/background/options/status entrypoints and manifests with `activeTab`, `storage`, `nativeMessaging`, and required HTTP(S) host permissions.

- [ ] **Step 1: Write failing options and status UI tests**

Use happy-dom with injected storage/native-test functions. Assert the options form loads existing settings, rejects a relative/empty path, saves an absolute path, tests host/folder access, and renders typed results. Assert status renders only sanitized text from stored warnings/errors and never inserts HTML.

- [ ] **Step 2: Run UI tests and verify RED**

Run `rtk pnpm test -- entrypoints/options/main.test.ts entrypoints/status/main.test.ts` and expect missing-entrypoint failures.

- [ ] **Step 3: Implement accessible vanilla options and status pages**

Use semantic labels, buttons, `aria-live` result regions, system fonts, light/dark color schemes, visible focus, and no inline scripts. Keep destination input, Save settings, Test connection, host status, folder status, and status details as the only UI elements.

- [ ] **Step 4: Write failing background/content wiring tests**

Inject a browser facade and assert action clicks query the active tab, clear an old popup, call one coordinator save, prevent concurrent saves per tab, and forward extraction messages to `extractArticle(document, location.href)`.

- [ ] **Step 5: Run wiring tests and verify RED**

Run `rtk pnpm test -- entrypoints/background.test.ts` and expect missing behavior.

- [ ] **Step 6: Implement WXT entrypoints and manifest configuration**

Use `defineContentScript` for `http://*/*` and `https://*/*`, `defineBackground` for action handling, and WXT's unified `browser` API. Configure options/status pages, Firefox Gecko ID `arthur@olhapi.com`, and no default action popup. Task 7 adds the committed Chromium public manifest key before installable packages are produced. Ensure warning/error state calls `browser.action.setPopup({ popup: "status.html" })` and a new save clears it with an empty popup.

- [ ] **Step 7: Verify all browser builds and commit**

Run:

```bash
rtk pnpm test -- entrypoints
rtk pnpm typecheck
rtk pnpm build:chrome
rtk pnpm build:edge
rtk pnpm build:firefox
rtk git diff --check
rtk git add entrypoints wxt.config.ts
rtk git commit -m "feat: add cross-browser Arthur interface"
```

Expected: all three builds exit 0, manifests contain native messaging/storage permissions, and the normal action has no popup.

---

### Task 7: Bounded single-binary macOS native-host installation

**Files:**
- Create: `scripts/native-host/identity.mjs`
- Create: `scripts/native-host/install.mjs`
- Create: `scripts/native-host/verify.mjs`
- Create: `scripts/native-host/uninstall.mjs`
- Test: `scripts/native-host/identity.test.ts`
- Test: `scripts/native-host/install.test.ts`
- Test: `scripts/native-host/verify.test.ts`
- Modify: `package.json`
- Modify: `wxt.config.ts`
- Create: `docs/native-host.md`

**Interfaces:**
- Consumes: `native/target/release/arthur-native-host`, `NATIVE_HOST_NAME`, Firefox ID, and the WXT Chromium manifest key. It does not consume `dist/native`, a Node executable path, Zod at runtime, or any `node_modules` content.
- Produces: `getChromiumExtensionId(publicKeyBase64: string): string`, `buildInstallPlan(options): InstallPlan`, `applyInstallPlan(plan): Promise<void>`, `verifyInstall(options): Promise<VerificationResult>`, and `buildUninstallPlan(options): UninstallPlan`.
- `InstallPlan` contains exactly one native payload source and destination: `native/target/release/arthur-native-host` to `~/Library/Application Support/Arthur/native-host/arthur-native-host`. Each manifest `path` points directly to that installed binary.

- [ ] **Step 1: Generate and test only a Chromium public identity**

Generate a 2048-bit RSA key in a temporary directory, derive the public DER base64 for WXT's manifest `key`, calculate the Chrome extension ID from SHA-256(public DER) using the first 16 bytes mapped to `a` through `p`, and discard the private key. Store only the public key and computed ID in `wxt.config.ts` and `identity.mjs`. `identity.test.ts` must prove the committed key always derives the committed ID and must reject malformed base64/DER input.

- [ ] **Step 2: Write failing single-binary install/verify/uninstall plan tests**

Inject platform, home, repository path, native binary path, spawn, and filesystem operations. Assert the exact user-level targets:

```text
~/Library/Application Support/Arthur/native-host/arthur-native-host
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.olhapi.arthur.json
~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.olhapi.arthur.json
~/Library/Application Support/Mozilla/NativeMessagingHosts/com.olhapi.arthur.json
```

Assert Chromium uses `allowed_origins: ["chrome-extension://<derived-id>/"]`, Firefox uses `allowed_extensions: ["arthur@olhapi.com"]`, every manifest references the direct absolute binary path, and the payload plan contains one regular file with final mode `0755`. Assert the plan contains no launcher, Node path, `dist/native`, package directory, or second copied payload.

Cover non-macOS rejection, a missing/non-regular release binary, a symlink at the final binary or manifest target, a target outside the exact Arthur allowlist, atomic same-directory staging/rename, and uninstall refusal when any resolved target differs from the allowlist. Verify tests must reject bad JSON, bad IDs, wrong paths/modes, a nonregular binary, extra native payload files, malformed handshake output, stdout noise, and a destination-test mismatch. `verifyInstall({ expectAbsent: true })` must pass only when all four allowlisted Arthur files are absent.

- [ ] **Step 3: Run lifecycle tests and verify RED**

Run:

```bash
rtk pnpm test -- scripts/native-host
```

Expected: FAIL because the identity/lifecycle modules do not exist.

- [ ] **Step 4: Implement one-binary install, direct verification, and bounded uninstall**

`install.mjs` must receive an already built release binary from the package script, verify it is a regular file, copy it to a unique same-parent staging basename with mode `0755`, fsync/close it, and atomically rename it to the exact installed path. It must not write a launcher or copy dependencies. Write each manifest through its own same-directory exclusive temp file and atomic rename; reject symlink targets before replacement.

`verify.mjs` must parse all three manifests, compare exact IDs/origins/extensions/path, `lstat` the installed target as one executable regular file, confirm the native-host directory contains only `arthur-native-host`, and spawn that binary directly with a minimal `PATH=/usr/bin:/bin`. Send a real framed hello and validate the framed response. When passed `--destination /absolute/path`, send `test_destination` and require `writable: true` for that normalized absolute destination. When passed `--expect-absent`, require all four allowlisted files to be absent without spawning anything. No verification may invoke Node as the host process.

`uninstall.mjs` must resolve and compare every candidate against the four exact allowlisted targets, reject symlinks/unexpected targets, remove only Arthur's three manifest files and installed binary, remove `native-host/` only when empty, and leave all broader application-support/browser directories intact.

Add these scripts:

```json
{
  "native:install": "pnpm build:native && node scripts/native-host/install.mjs",
  "native:verify": "node scripts/native-host/verify.mjs",
  "native:uninstall": "node scripts/native-host/uninstall.mjs"
}
```

- [ ] **Step 5: Document the build-time versus installed-runtime seam**

In `docs/native-host.md`, document macOS-only v1, Rust 1.97.1 for building, Node 22+/pnpm only for repository build/install scripts, the direct installed binary path, the three manifest paths, extension IDs, install/verify/destination-test/uninstall commands, recoverability, and the exact four files uninstall can remove. State explicitly that browser launch of the installed host requires no Node executable, launcher, copied package, inherited `PATH`, or repository checkout.

- [ ] **Step 6: Verify against an isolated fake home and commit**

Build first, then run the install/verify/uninstall sequence with the tests' explicit fake-home option; do not mutate real browser configuration during this task review:

```bash
rtk pnpm build:native
rtk pnpm test -- scripts/native-host
rtk pnpm typecheck
rtk pnpm audit:native
rtk git diff --check
rtk git add scripts/native-host package.json wxt.config.ts docs/native-host.md
rtk git commit -m "feat: install the Rust native host binary"
```

Expected: the fake installation contains one executable native payload plus three manifests, direct hello/destination verification passes with the minimal environment, bounded uninstall removes only those four files, and all tests pass.

---

### Task 8: Rust-host smoke acceptance, packaging, and user documentation

**Files:**
- Create: `scripts/smoke/check-builds.mjs`
- Create: `scripts/smoke/native-roundtrip.mjs`
- Test: `scripts/smoke/check-builds.test.ts`
- Test: `scripts/smoke/native-roundtrip.test.ts`
- Create: `tests/fixtures/media/animated.gif`
- Create: `tests/fixtures/media/animated.webp`
- Create: `tests/fixtures/media/diagram.svg`
- Create: `tests/fixtures/media/photo.avif`
- Create: `tests/fixtures/media/audio.mp3`
- Create: `tests/fixtures/media/video.mp4`
- Modify: `package.json`
- Create: `README.md`
- Create: `docs/acceptance.md`

**Interfaces:**
- Consumes: all built extension artifacts, `native/target/release/arthur-native-host`, the shared protocol fixture, fixture article/media, and temporary destination support.
- Produces: deterministic `pnpm smoke`, `pnpm acceptance:native`, and `pnpm verify` release gates. The native acceptance adapter sends only the existing canonical JSON interface and spawns the Rust binary directly.

- [ ] **Step 1: Write failing artifact and Rust native-roundtrip tests**

Assert `check-builds` parses each generated manifest and verifies name/version, target-specific identity, permissions, content script match patterns, options/status pages, background entrypoint, and absence of a default action popup.

Assert `native-roundtrip` sends real frames for a complete save containing GIF, animated WebP, SVG, AVIF, MP3, and MP4 fixture bytes, then verifies:

- Byte-identical attachment output and lowercase `attachments/` embeds.
- Frontmatter contains exactly `title` and normalized `source` with LF endings.
- Stored `HTTPS://Example.TEST:443/a#old` is matched by incoming `https://example.test/a#new` and replaced in place.
- Same-title/different-source writes a source-hash suffix without changing the unrelated note.
- A media chunk-count mismatch produces a warning and a normalized remote autolink while the article still commits.
- Individual and total limits fail before note exposure.
- Replacing visible `attachments/` with an outside symlink after session begin cannot redirect writes.
- A forced interruption before note rename leaves the prior note byte-identical.
- Zero length, oversized length, truncated EOF, invalid UTF-8, and invalid JSON each produce at most one framed error; a following valid hello is never answered on that connection.
- Stdout contains only frames, stderr contains only redacted diagnostics, and normal EOF is silent.

- [ ] **Step 2: Run smoke tests and verify RED**

Run:

```bash
rtk pnpm test -- scripts/smoke
```

Expected: FAIL because the smoke modules do not exist.

- [ ] **Step 3: Implement deterministic offline smoke and acceptance scripts**

Make both scripts accept explicit build/binary/destination paths, use unique temporary directories by default, clean only directories they created, print one compact JSON result object, and exit nonzero on any mismatch. They must not require network access or modify a real vault/browser profile. `native-roundtrip.mjs` must spawn the release binary path directly; reject a JavaScript path, shebang launcher, missing executable bit, or an invocation that succeeds only when a Node path is supplied.

Set the final scripts exactly:

```json
{
  "smoke": "node scripts/smoke/check-builds.mjs",
  "acceptance:native": "node scripts/smoke/native-roundtrip.mjs --binary native/target/release/arthur-native-host",
  "verify": "pnpm test && pnpm typecheck && pnpm test:native && pnpm format:native:check && pnpm lint:native && pnpm build && pnpm smoke && pnpm acceptance:native && pnpm audit --audit-level high && pnpm audit:native"
}
```

- [ ] **Step 4: Write exact setup and acceptance documentation**

`README.md` must cover macOS v1 requirements, Rust 1.97.1 and Node 22+/pnpm development roles, the dependency-free `scripts/rust-toolchain.mjs` build-time adapter, the six direct Rust crates, dependency/audit policy, development, unpacked Chrome/Edge loading, temporary Firefox loading, single-binary native-host installation, destination configuration, one-click use, file layout, warnings/limits, builds/zips, verification, and bounded uninstall. State that native repository scripts select exact toolchain binaries through the adapter, and do not describe Node, Homebrew, rustup, Cargo, or a parent shell environment as an installed-host runtime requirement.

`docs/acceptance.md` must list the exact automated commands and expected outputs from Step 5, plus bounded manual checks for one-click toolbar behavior in installed Chrome, Edge, and Firefox profiles. Include a file inventory proving the native install contains one binary and three manifests, a direct hello with minimal `PATH`, byte hashes for every input/output fixture pair, normalized overwrite evidence, warning fallback evidence, poison/termination evidence, and before/after destination trees for commit-last failures.

- [ ] **Step 5: Run the complete fresh locked verification gate without exceptions**

First verify the audit executable; a missing/mismatched tool blocks release:

```bash
rtk zsh -lc 'test "$("${CARGO_HOME:-$HOME/.cargo}/bin/cargo-audit" --version)" = "cargo-audit 0.22.2"'
rtk pnpm install --frozen-lockfile
rtk node scripts/rust-toolchain.mjs fetch --manifest-path native/Cargo.toml --locked
rtk pnpm verify
rtk pnpm zip
rtk git diff --check
rtk git status --short
```

Expected: `cargo-audit 0.22.2`; npm and Cargo frozen/locked resolution succeeds; TypeScript/Rust tests pass; Rust format/clippy pass with warnings denied; the locked release binary and Chrome/Edge/Firefox artifacts build; smoke/native acceptance pass; both audits exit 0; all three zips succeed; and only Task 8 files are uncommitted. Do not use `--ignore`, remove an audit command, lower an audit threshold, or substitute a source inspection for any failed gate.

- [ ] **Step 6: Commit the completed release surface**

Run:

```bash
rtk git add scripts/smoke tests/fixtures/media package.json README.md docs/acceptance.md
rtk git commit -m "docs: complete Arthur release workflow"
```

- [ ] **Step 7: Perform bounded installed-browser acceptance and uninstall**

Run the real user-level lifecycle only after the automated gates pass. Use one dedicated temporary destination, install the direct binary/manifests, and verify them before opening browsers:

```bash
rtk zsh -lc 'ARTHUR_ACCEPTANCE_DEST="$(mktemp -d -t arthur-acceptance)"; pnpm native:install; pnpm native:verify -- --destination "$ARTHUR_ACCEPTANCE_DEST"; printf "%s\n" "$ARTHUR_ACCEPTANCE_DEST"'
```

Use the printed destination for the exact Chrome, Edge, and Firefox toolbar checks in `docs/acceptance.md`: one click with no popup, byte-identical local media, stream/iframe remote links, overwrite by normalized source, unrelated-note preservation, and warning details after a failed/oversized medium. Record the installed inventory and evidence in `.superpowers/sdd/2026-08-16-arthur-article-saver/task-8-acceptance.md`. Then uninstall Arthur's host files and confirm absence:

```bash
rtk pnpm native:uninstall
rtk pnpm native:verify -- --expect-absent
```

Delete only the printed dedicated empty acceptance destination after its evidence has been recorded. If install, any browser check, verify, or uninstall fails, stop release and retain the failure evidence; do not claim acceptance from the fake-home tests.

- [ ] **Step 8: Perform the final Terra/Sol SDD review and branch-wide verification**

Have Terra present the exact verification evidence and acceptance artifacts. Have Sol independently review both code quality and compliance against `docs/superpowers/specs/2026-08-16-arthur-article-saver-design.md`, including the canonical JSON fixtures, descriptor ownership, symlink-race tests, decoder poison behavior, one-binary install inventory, source normalization, and both audit outputs. Route every Critical or Important finding back to Terra for a focused red-green fix and repeat Sol review until accepted.

After the final accepted review, rerun:

```bash
rtk pnpm verify
rtk pnpm zip
rtk git status --short --branch
```

Expected: verification and packaging exit 0, Sol's final review has no unresolved Critical/Important findings, and the worktree is clean.
