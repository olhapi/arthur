# Arthur Article Saver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a one-click Chrome/Edge/Firefox extension and macOS native helper that save rendered articles as Obsidian Markdown with original media in a shared lowercase `attachments/` directory.

**Architecture:** A WXT content script performs browser-DOM extraction and Markdown conversion, while a background coordinator streams media through a typed native-messaging client. A plain-`tsc` Node helper validates the protocol, stages content-addressed media, and atomically commits the article note last inside a path-confined destination.

**Tech Stack:** TypeScript 7.0.2, WXT 0.21.4, Vitest 4.1.10, happy-dom 20.11.2, Mozilla Readability 0.6.0, DOMPurify 3.4.13, Turndown 7.2.4, Zod 4.4.3, Node.js 22+ on macOS, pnpm 10.32.1.

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
- Use vanilla HTML, CSS, and TypeScript; do not add React, Vue, Svelte, Plasmo, `turndown-plugin-gfm`, `sanitize-filename`, jszip, tsup, jsdom, date-fns, or fflate.
- Third-party dependencies must be actively maintained, non-deprecated, necessary, audited, and pinned exactly in `pnpm-lock.yaml`.
- Every behavior task follows red-green-refactor and ends in a Conventional Commit.

---

## File Map

- `package.json`: exact dependencies and repository-wide scripts.
- `pnpm-lock.yaml`: immutable dependency resolution.
- `tsconfig.json`: WXT, shared, and test TypeScript settings.
- `tsconfig.native.json`: NodeNext compilation for shared/native code into `dist/native`.
- `vitest.config.ts`: Node default with per-file happy-dom opt-in.
- `wxt.config.ts`: extension identity, permissions, browser targets, and manifest settings.
- `docs/dependencies.md`: registry, repository-activity, advisory, and audit evidence.
- `src/shared/constants.ts`: host name, protocol version, limits, and chunk size.
- `src/shared/settings.ts`: validated extension settings.
- `src/shared/protocol.ts`: Zod schemas and inferred native request/response types.
- `src/article/source.ts`: final-page source URL normalization.
- `src/article/resources.ts`: rendered resource URL materialization and media classification.
- `src/article/markdown.ts`: sanitization, Turndown rules, placeholders, and Obsidian rewriting.
- `src/article/extract.ts`: Readability pipeline and extracted-article contract.
- `src/native/framing.ts`: native-message byte framing.
- `src/native/filenames.ts`: project-specific filenames and media extensions.
- `src/native/paths.ts`: realpath confinement and symlink checks.
- `src/native/frontmatter.ts`: safe note serialization and source discovery.
- `src/native/session.ts`: streaming save transaction and resource budgets.
- `src/native/server.ts`: validated request dispatcher.
- `src/native/main.ts`: stdin/stdout host entrypoint.
- `src/background/native-client.ts`: browser native-port request/response adapter.
- `src/background/media-transfer.ts`: fetch-stream to bounded base64 chunks.
- `src/background/status.ts`: badge and conditional popup state.
- `src/background/save-coordinator.ts`: end-to-end browser save orchestration.
- `entrypoints/content.ts`: WXT content-message bridge.
- `entrypoints/background.ts`: WXT action and coordinator wiring.
- `entrypoints/options/*`: destination configuration UI.
- `entrypoints/status/*`: failure/warning detail UI.
- `scripts/native-host/*.mjs`: install, verify, and uninstall tooling.
- `scripts/smoke/*.mjs`: built-artifact and helper acceptance checks.
- `tests/fixtures/article.html`: deterministic browser article fixture.
- `README.md`: setup, usage, builds, installation, and troubleshooting.

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

### Task 3: Native framing, filenames, paths, and notes

**Files:**
- Create: `src/native/framing.ts`
- Create: `src/native/filenames.ts`
- Create: `src/native/paths.ts`
- Create: `src/native/frontmatter.ts`
- Test: `src/native/framing.test.ts`
- Test: `src/native/filenames.test.ts`
- Test: `src/native/paths.test.ts`
- Test: `src/native/frontmatter.test.ts`

**Interfaces:**
- Consumes: protocol types and source normalization.
- Produces: `encodeNativeMessage(value: unknown): Buffer`, `NativeMessageDecoder.push(chunk: Buffer): unknown[]`, `sanitizeFilenameStem(value: string): string`, `extensionForMedia(originalName: string, contentType: string): string`, `contentAddressedFilename(stem: string, digestHex: string, extension: string): string`, `resolveDestination(path: string): Promise<Destination>`, `assertSafeNewChild(destination: Destination, relativePath: string): Promise<string>`, `serializeNote(title: string, source: string, markdown: string): string`, and `findExistingArticle(destination: string, source: string): Promise<string | undefined>`.

- [ ] **Step 1: Write failing framing and filename tests**

Assert fragmented/coalesced frame decoding, invalid lengths, UTF-8 JSON failures, macOS-reserved separators, control/NUL characters, empty/dot names, 180-byte stem truncation, MIME-derived extensions, and content hashes:

```ts
expect(contentAddressedFilename("hero", "b7c87d380f4e99ff", "webp"))
  .toBe("hero--b7c87d380f4e.webp");
expect(extensionForMedia("animated.webp", "image/webp")).toBe("webp");
```

- [ ] **Step 2: Run framing/filename tests and verify RED**

Run `rtk pnpm test -- src/native/framing.test.ts src/native/filenames.test.ts` and expect missing-module failures.

- [ ] **Step 3: Implement framing and project-owned filenames**

Limit incoming native frames to 1 MiB, reject zero/oversized frames, buffer incomplete input, parse JSON only after a full frame, normalize filenames to NFC, remove unsafe characters locally, and preserve a recognized URL extension unless MIME supplies the only trustworthy extension.

- [ ] **Step 4: Write failing path and frontmatter tests**

Use real temporary directories. Cover an absolute writable destination, a symlinked destination root, `../` traversal, absolute children, a symlink inside the destination pointing outside, existing normal children, YAML quotes/newlines, direct-folder-only scanning, same-source discovery, and same-title/different-source collision.

```ts
expect(serializeNote('A "title"', "https://example.test/a", "Body\n")).toBe(
  '---\ntitle: "A \\"title\\""\nsource: "https://example.test/a"\n---\n\nBody\n',
);
```

- [ ] **Step 5: Run path/frontmatter tests and verify RED**

Run `rtk pnpm test -- src/native/paths.test.ts src/native/frontmatter.test.ts` and expect missing-module failures.

- [ ] **Step 6: Implement path confinement and note serialization**

Resolve the selected folder with `realpath`, require a directory, and check writability. Resolve each existing ancestor beneath it, reject any child symlink that escapes, and use only validated relative basenames. Parse only Arthur's exact two-field frontmatter shape when matching existing notes; malformed or unrelated Markdown must be ignored, not overwritten.

- [ ] **Step 7: Verify and commit**

Run:

```bash
rtk pnpm test -- src/native/framing.test.ts src/native/filenames.test.ts src/native/paths.test.ts src/native/frontmatter.test.ts
rtk pnpm typecheck
rtk git diff --check
rtk git add src/native/framing.ts src/native/framing.test.ts src/native/filenames.ts src/native/filenames.test.ts src/native/paths.ts src/native/paths.test.ts src/native/frontmatter.ts src/native/frontmatter.test.ts
rtk git commit -m "feat: secure native filesystem primitives"
```

---

### Task 4: Streaming native save transaction

**Files:**
- Create: `src/native/session.ts`
- Create: `src/native/server.ts`
- Create: `src/native/main.ts`
- Test: `src/native/session.test.ts`
- Test: `src/native/server.test.ts`
- Test: `src/native/main.integration.test.ts`

**Interfaces:**
- Consumes: all shared schemas/constants and Task 3 native primitives.
- Produces: `SaveSession`, `SessionManager.handle(message: ClientMessage): Promise<HostMessage>`, `NativeServer.accept(value: unknown): Promise<HostMessage>`, and `runNativeHost(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<void>`.
- `SaveSession` exposes `beginMedia`, `appendChunk`, `endMedia`, `commit`, and `abort`; callers cannot commit while media is open or before all declared byte counts match.

- [ ] **Step 1: Write failing transaction tests**

Use a temporary selected folder and assert:

- Ordered base64 chunks produce byte-identical GIF/WebP/audio/video staged files.
- Duplicate content reuses one content-addressed attachment.
- Out-of-order chunks, mismatched byte counts, unknown media IDs, and duplicate end calls fail with typed codes.
- Image, audio/video, and total budgets reject excess data before it is committed.
- Aborting removes the stage.
- A forced attachment-rename failure leaves the prior note unchanged.
- A successful commit moves attachments first and atomically replaces the matching-source note last.
- A same-title/different-source save receives a source-hash suffix.

- [ ] **Step 2: Run transaction tests and verify RED**

Run `rtk pnpm test -- src/native/session.test.ts` and expect a missing `SaveSession` failure.

- [ ] **Step 3: Implement the minimal save transaction**

Create a hidden `.arthur-stage-<session UUID>` directory with mode `0700`. Stream decoded chunks to exclusively created files while updating Node `createHash("sha256")`. On media end, return the final content-addressed filename but keep the file staged. On commit, finalize placeholders, install immutable attachments, write the complete note to an exclusive temporary file in the destination, `fsync`/close it, then rename it over the selected article path. Always remove the stage in `finally` or abort handling.

- [ ] **Step 4: Write failing dispatcher and host-process tests**

Assert hello/version negotiation, destination tests, message-schema failures, missing sessions, full begin/media/chunk/end/commit order, recoverable errors, stdout framing, and stderr-only diagnostics. Spawn `node dist/native/native/main.js`, send real framed JSON through stdin, and decode the response from stdout.

- [ ] **Step 5: Run dispatcher/host tests and verify RED**

Run:

```bash
rtk pnpm build:native
rtk pnpm test -- src/native/server.test.ts src/native/main.integration.test.ts
```

Expected: FAIL because dispatcher/entrypoint behavior is absent.

- [ ] **Step 6: Implement validated dispatch and native entrypoint**

Parse every input with `ClientMessageSchema`, map known filesystem/protocol failures to stable error codes without leaking paths beyond the configured destination, and frame every `HostMessageSchema`-validated response. Handle `SIGTERM`, EOF, and stream errors by aborting active sessions. Never write diagnostics to stdout.

- [ ] **Step 7: Verify and commit**

Run:

```bash
rtk pnpm test -- src/native
rtk pnpm build:native
rtk node dist/native/native/main.js </dev/null
rtk git diff --check
rtk git add src/native
rtk git commit -m "feat: add transactional native save host"
```

Expected: native unit/integration tests pass, compilation succeeds, and EOF exits cleanly with no stdout noise.

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
- Consumes: shared messages/constants, `ExtractedArticle`, and `finalizeMarkdown`.
- Produces: `NativeClient`, `transferMedia(response: Response, media: ExtractedMedia, client: NativeClient): Promise<string>`, `StatusController`, and `SaveCoordinator.save(tabId: number, tabUrl: string): Promise<SaveOutcome>`.
- `NativeClient` depends on an injected `NativePortAdapter` with `postMessage`, `onMessage`, `onDisconnect`, and `disconnect`, so tests use real client logic without a browser mock library.

- [ ] **Step 1: Write failing native-client and transfer tests**

Assert request correlation, schema rejection, host disconnect, typed errors, one in-flight chunk for backpressure, exact 256 KiB decoded chunk bounds, ordered sequence numbers, empty files, stream failures, and early size rejection from `Content-Length` plus incremental enforcement when it is absent.

- [ ] **Step 2: Run client/transfer tests and verify RED**

Run `rtk pnpm test -- src/background/native-client.test.ts src/background/media-transfer.test.ts` and expect missing-module failures.

- [ ] **Step 3: Implement native client and streaming transfer**

Wrap `browser.runtime.connectNative(NATIVE_HOST_NAME)` behind the injected adapter. Validate every response, resolve only its correlated pending operation, and reject all pending operations on disconnect. Read `Response.body` incrementally, accumulate no more than `NATIVE_CHUNK_BYTES`, base64-encode each bounded chunk, await its acknowledgement, and enforce individual plus total budgets before sending more bytes.

- [ ] **Step 4: Write failing status and coordinator tests**

Inject extraction, fetch, native client, settings, and status dependencies. Cover unconfigured destination, hello mismatch, extraction failure, full success, duplicate media, failed media fallback, oversized media fallback, streamed-link preservation, commit failure/abort, warning popup state, and badge transitions:

```ts
expect(status.calls).toEqual(["saving", "success"]);
expect(outcome).toMatchObject({ articlePath: "/Vault/Clippings/Article.md", warnings: [] });
```

- [ ] **Step 5: Run status/coordinator tests and verify RED**

Run `rtk pnpm test -- src/background/status.test.ts src/background/save-coordinator.test.ts` and expect missing-module failures.

- [ ] **Step 6: Implement orchestration and warning fallback**

Load validated settings, request extraction from the active tab, negotiate protocol, begin a save, fetch each direct resource, stream successful responses, retain remote Markdown links on media warnings, finalize successful Obsidian embeds, and commit. Abort on fatal failures. `StatusController` sets `…`, `✓`, or `!`, clears the popup before a new save, and enables `status.html` only for warning/error detail stored in extension-local storage.

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

### Task 7: Bounded macOS native-host installation

**Files:**
- Create: `scripts/native-host/identity.mjs`
- Create: `scripts/native-host/install.mjs`
- Create: `scripts/native-host/verify.mjs`
- Create: `scripts/native-host/uninstall.mjs`
- Test: `scripts/native-host/identity.test.ts`
- Test: `scripts/native-host/install.test.ts`
- Modify: `package.json`
- Modify: `wxt.config.ts`
- Create: `docs/native-host.md`

**Interfaces:**
- Consumes: compiled `dist/native`, installed `zod`, `NATIVE_HOST_NAME`, Firefox ID, and WXT Chromium manifest key.
- Produces: `getChromiumExtensionId(publicKeyBase64: string): string`, `buildInstallPlan(options): InstallPlan`, `applyInstallPlan(plan): Promise<void>`, `verifyInstall(options): Promise<VerificationResult>`, and `buildUninstallPlan(options): UninstallPlan`.

- [ ] **Step 1: Generate and commit only a Chromium public identity**

Generate a 2048-bit RSA key in a temporary directory, derive the public DER base64 for WXT's manifest `key`, calculate the Chrome extension ID from SHA-256(public DER) using the first 16 bytes mapped to `a` through `p`, and discard the private key. Store only the public key and computed ID in `wxt.config.ts`/`identity.mjs`. Test that the committed key always derives the committed ID.

- [ ] **Step 2: Write failing installation-plan tests**

Inject platform, home, Node path, repository path, and filesystem operations. Assert exact user-level destinations:

```text
~/Library/Application Support/Arthur/native-host/
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.olhapi.arthur.json
~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.olhapi.arthur.json
~/Library/Application Support/Mozilla/NativeMessagingHosts/com.olhapi.arthur.json
```

Assert Chromium uses `allowed_origins: ["chrome-extension://<derived-id>/"]`, Firefox uses `allowed_extensions: ["arthur@olhapi.com"]`, manifests reference the absolute Arthur launcher, the launcher references an absolute Node executable, non-macOS is rejected, and uninstall refuses paths outside the exact Arthur allowlist.

- [ ] **Step 3: Run installer tests and verify RED**

Run `rtk pnpm test -- scripts/native-host` and expect missing-module failures.

- [ ] **Step 4: Implement install, verify, and uninstall tooling**

Install must build the native helper first, copy `dist/native` and the real installed `zod` package into the Arthur application-support directory through a staging directory, write an executable launcher with mode `0755`, and atomically replace only Arthur-owned manifests. Verify must parse all manifests, check IDs/paths/modes, run a framed hello handshake, and optionally test a supplied destination. Uninstall must resolve every target, compare it to the exact allowlist, remove only matching Arthur files, and leave nonempty parent directories intact.

Add scripts:

```json
{
  "native:install": "pnpm build:native && node scripts/native-host/install.mjs",
  "native:verify": "node scripts/native-host/verify.mjs",
  "native:uninstall": "node scripts/native-host/uninstall.mjs"
}
```

- [ ] **Step 5: Document the exact operational boundary**

In `docs/native-host.md`, document Node 22+, macOS-only support, the three manifest paths, installed application-support path, build/install/verify/uninstall commands, extension IDs, destination test syntax, recoverability, and which files uninstall removes.

- [ ] **Step 6: Verify against an isolated fake home and commit**

Run tests with a temporary fake home first; do not mutate the real browser configuration during this task review:

```bash
rtk pnpm test -- scripts/native-host
rtk pnpm build:native
rtk pnpm typecheck
rtk git diff --check
rtk git add scripts/native-host package.json wxt.config.ts docs/native-host.md
rtk git commit -m "feat: add macOS native host lifecycle"
```

---

### Task 8: Smoke acceptance, packaging, and user documentation

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
- Consumes: all built extension artifacts, compiled native host, fixture article, and fake/temporary destination support.
- Produces: deterministic `pnpm smoke`, `pnpm acceptance:native`, and `pnpm verify` release gates.

- [ ] **Step 1: Write failing artifact and native-roundtrip tests**

Assert `check-builds` parses each generated manifest and verifies name/version, target-specific identity, permissions, content script match patterns, options/status pages, background entrypoint, and absence of a default action popup. Assert `native-roundtrip` frames a complete save containing GIF, animated WebP, SVG, AVIF, MP3, and MP4 fixture bytes, then verifies byte-identical attachment output, exact frontmatter, Obsidian embeds, overwrite-by-source, and same-title/different-source safety.

- [ ] **Step 2: Run smoke tests and verify RED**

Run `rtk pnpm test -- scripts/smoke` and expect missing-module failures.

- [ ] **Step 3: Implement deterministic smoke and acceptance scripts**

Make scripts accept explicit build/destination paths, use temporary directories by default, print compact machine-checkable results, and exit nonzero on any mismatch. Do not require network access or modify a real vault/browser profile.

Add scripts:

```json
{
  "smoke": "node scripts/smoke/check-builds.mjs",
  "acceptance:native": "node scripts/smoke/native-roundtrip.mjs",
  "verify": "pnpm test && pnpm typecheck && pnpm build && pnpm smoke && pnpm acceptance:native && pnpm audit --audit-level high"
}
```

- [ ] **Step 4: Write setup and acceptance documentation**

`README.md` must cover requirements, dependency policy, development, unpacked Chrome/Edge loading, temporary Firefox loading, native-host installation, destination configuration, one-click use, file layout, warnings/limits, builds/zips, verification, and uninstall. `docs/acceptance.md` must list exact automated gates and the final bounded manual checks for toolbar behavior in installed Chrome/Edge/Firefox profiles.

- [ ] **Step 5: Run the complete fresh verification gate**

Run:

```bash
rtk pnpm verify
rtk pnpm zip
rtk git diff --check
rtk git status --short
```

Expected: all tests pass, both TypeScript configurations pass, Chrome/Edge/Firefox builds and zips succeed, smoke and native acceptance scripts pass, high-severity audit exits 0, and only Task 8 files are uncommitted.

- [ ] **Step 6: Commit the completed release surface**

Run:

```bash
rtk git add scripts/smoke tests/fixtures/media package.json README.md docs/acceptance.md
rtk git commit -m "docs: complete Arthur release workflow"
```

- [ ] **Step 7: Perform final branch-wide review and verification**

Request a broad spec-compliance and code-quality review against `docs/superpowers/specs/2026-08-16-arthur-article-saver-design.md`, fix all Critical and Important findings through the responsible implementer, and rerun:

```bash
rtk pnpm verify
rtk pnpm zip
rtk git status --short --branch
```

Expected: verification and packaging exit 0 and the worktree is clean.
