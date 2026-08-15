# Arthur Article Saver Design

## Purpose

Arthur is a one-click browser extension for Chrome, Edge, and Firefox. It extracts the main article from the active rendered page, converts it to clean Markdown, downloads supported media without transcoding, and saves the result into a user-selected folder inside an Obsidian vault through a macOS native-messaging helper.

The selected folder is the complete article destination. Article notes are written directly into it. All downloaded media is shared through one lowercase `attachments/` subfolder.

## Scope

Version 1 includes:

- Chrome, Edge, and Firefox extension builds using WXT and vanilla HTML, CSS, and TypeScript.
- A macOS native-messaging helper written in TypeScript and compiled with `tsc`.
- One-click article saving from the toolbar.
- Mozilla Readability extraction from the rendered DOM.
- DOMPurify sanitization and Turndown Markdown conversion.
- Original-byte downloads for browser-retrievable images, including GIF, animated WebP, SVG, AVIF, and other image formats.
- Original-byte downloads for direct audio and video URLs.
- Source links for streamed players and iframe embeds rather than attempts to capture streams.
- Obsidian embeds for downloaded media.
- Source-based overwrite behavior.
- macOS install, verify, and uninstall tooling for Chrome, Edge, and Firefox native-host manifests.

Version 1 does not include Windows or Linux helper installation, ZIP/download fallback, cloud sync, a component UI framework, streamed-media capture, media transcoding, or a date-based folder layout.

## Storage Model

Given a selected destination folder `/Vault/Clippings`, a save produces:

```text
/Vault/Clippings/
├── Article title.md
└── attachments/
    ├── hero--b7c87d380f4e.webp
    └── interview--18f4a299a662.mp3
```

Article files are UTF-8 Markdown with LF line endings. Frontmatter contains exactly the available fields from this set:

```yaml
---
title: "Article title"
source: "https://example.com/article"
---
```

Both fields are required for a successful save. Values are emitted with safe YAML quoting.

`source` is the active tab's final HTTP(S) URL after redirects. Arthur removes the fragment, relies on standard URL serialization to normalize scheme, host, and default ports, and preserves the path and query. Page-supplied canonical URLs are not used for identity, so a document cannot redirect writes to an unrelated identity.

Downloaded media is referenced with Obsidian embeds:

```markdown
![[attachments/hero--b7c87d380f4e.webp]]
```

Attachment names consist of a project-owned sanitized original basename, a short SHA-256 content hash, and the preserved or MIME-derived extension. Identical content is reused. Different content cannot collide merely because it has the same original name.

## Existing Article Behavior

Before writing a note, the helper scans Markdown files directly inside the selected destination folder and reads frontmatter written by Arthur. If a note has the same normalized `source` URL, Arthur atomically replaces that note in place. This remains true if the remote title changed.

If no source matches and the sanitized title filename is unused, Arthur uses `<sanitized-title>.md`. If that filename belongs to a different source, Arthur writes `<sanitized-title>--<short-source-hash>.md`. It never overwrites an unrelated note.

The destination folder and its Markdown files are the source of truth. Arthur does not maintain a hidden article index.

## Components

### Content extraction

The WXT content script clones the active rendered document so the page is never mutated. Before Readability runs, it resolves relative resource URLs and materializes responsive selections, preferring `currentSrc` for retained `img`, `picture`, `audio`, and `video` elements and their poster images. Mozilla Readability extracts the main article and metadata.

DOMPurify sanitizes the extracted article in the browser context. It removes scripts, event handlers, forms, unsafe embedded content, tracking elements, and irrelevant markup. Turndown converts the sanitized HTML to Markdown.

The project owns only the small additional Markdown rules it needs: fenced code, tables, and strikethrough. It does not use `turndown-plugin-gfm`.

### Extension coordinator

The background service coordinates extraction, media retrieval, native transfer, and toolbar state. It fetches retained media with extension host permissions and streams the response into bounded native-messaging chunks. It does not decode or transcode media.

The coordinator rewrites successfully saved media references to Obsidian embeds. An HTTP(S) audio or video file URL is direct unless its URL or response content type identifies a streaming manifest such as HLS or DASH. Unsupported schemes, streamed sources, and iframes remain remote links. Media that cannot be saved remains a remote link and yields a warning without discarding the article.

### Options and status UI

The options page contains:

- An absolute destination-path field.
- A Save settings action.
- A Test connection action.
- Native-host availability and folder-writability results.

The extension stores settings in browser extension-local storage and validates them at runtime.

A normal toolbar click immediately begins saving. Badge states are:

- `…` while saving.
- `✓` after success.
- `!` after a failure or warning.

The action has no popup during the normal one-click flow. When a failure or warning occurs, Arthur dynamically enables a minimal status popup so the next click shows actionable details. Starting another save clears the old status popup.

### Native helper

The helper uses the browser native-messaging protocol: four-byte little-endian message length followed by UTF-8 JSON. Zod validates every request, response, and transfer transition.

The protocol supports:

- Capability and version negotiation.
- Destination connection tests.
- Save-session begin and abort.
- Article metadata and Markdown transfer.
- Media begin, bounded base64 chunk, and media end messages.
- Save commit.
- Typed success, warning, and failure responses.

Each media stream is written to a temporary file while the helper incrementally calculates SHA-256. The helper therefore does not retain whole audio or video files in memory.

## Save Transaction

1. The toolbar click sets the badge to `…`.
2. The content script clones and prepares the rendered document.
3. Readability extracts the article; DOMPurify sanitizes it; Turndown produces Markdown.
4. The coordinator opens a validated save session with the helper.
5. Each retained media response is streamed in bounded chunks to a staged file.
6. The helper determines each final content-addressed attachment name.
7. The coordinator finalizes Markdown references using the returned attachment names.
8. The helper moves new attachment files into `attachments/` with same-filesystem renames.
9. The helper atomically replaces or creates the article note last.
10. The helper cleans the staging area and returns success or warnings.
11. The extension updates the badge and optional status details.

Writing the note last prevents Arthur from exposing a newly updated note whose new local attachments are absent. Content-addressed attachments are immutable and safe to reuse. A failure before the note rename leaves the previous note intact.

## Security and Validation

Every value received by the helper is untrusted. The helper must:

- Require the selected destination to be an existing absolute directory.
- Resolve the selected directory once and confine every target to that real path.
- Allow the selected directory itself to resolve through a legitimate symlink, but reject child-target symlink escapes.
- Reject traversal, absolute child paths, NUL bytes, empty filenames, control characters, and platform-unsafe filename forms.
- Create only its staging directory and the lowercase `attachments/` directory beneath the selected folder.
- Use exclusive temporary-file creation and same-filesystem renames.
- Validate protocol message order, identifiers, declared sizes, chunk sizes, and completed byte counts.
- Write protocol output only to stdout and diagnostics only to stderr.
- Accept connections only from the configured Arthur extension IDs through browser native-host manifests.
- Avoid logging article content, URLs with credentials, or media bytes.

Resource limits are:

- 100 MiB per image.
- 2 GiB per direct audio or video file.
- 4 GiB total media per save.
- A bounded number and byte size for individual native messages.

Oversized media remains a remote link and creates a warning. Invalid article metadata, malformed protocol state, native-host absence, an invalid destination, or an unwritable destination fails the save with a typed actionable error.

## Native Installation

The macOS installer compiles the helper, resolves the absolute Node executable path, and writes an executable launcher that invokes the compiled helper without depending on a GUI browser's shell `PATH`.

It installs browser-specific native-host manifests in the documented user-level locations for Chrome, Edge, and Firefox. Chromium manifests use allowed origins tied to fixed extension IDs; Firefox uses its fixed Gecko extension ID. Verify tooling checks the launcher, manifest JSON, IDs, helper handshake, and destination access. Uninstall tooling removes only Arthur-owned launchers and manifests after validating their exact paths.

## Dependencies

Dependencies are minimized and exact versions are locked in `pnpm-lock.yaml`.

Runtime dependencies:

- `@mozilla/readability` for main-article extraction.
- `dompurify` for browser-context HTML sanitization.
- `turndown` for HTML-to-Markdown conversion.
- `zod` for settings and protocol validation.

Development dependencies:

- `wxt` for cross-browser extension builds.
- `typescript` for strict extension, shared protocol, and helper code.
- `tsx` only if a concrete development script requires direct TypeScript execution; otherwise it is omitted.
- `vitest` for unit and integration tests.
- `happy-dom` for DOM integration tests without adding jsdom.
- `@types/node` for typed native Node APIs.
- `@types/turndown` only if the selected Turndown release lacks bundled declarations.

`date-fns` is omitted because the accepted design has no date formatting. `fflate` is omitted because there is no ZIP fallback. React, Vue, Svelte, Plasmo, `turndown-plugin-gfm`, `sanitize-filename`, jszip, tsup, and jsdom are not used.

Before installation, each package must be checked with `pnpm view <package> version time deprecated`, its primary repository must be checked for recent activity and open security advisories, and the resolved project must pass `pnpm audit`. Any dependency beyond this list requires a documented feature-specific reason.

## Testing Strategy

All behavior changes follow red-green-refactor development. A production function is introduced only after a focused test has failed for the expected missing behavior.

Vitest coverage includes:

- Protocol schemas and state transitions.
- Native frame encoding and decoding.
- Filename sanitization and collision handling.
- Path confinement and symlink escape attempts.
- YAML serialization and source matching.
- Attachment extension selection and content hashing.
- Chunk order, byte counts, aborts, and resource limits.
- Toolbar and status state transitions.
- Readability, DOMPurify, and Turndown integration.
- Relative and responsive resource resolution.
- GIF, animated WebP, SVG, AVIF, and direct audio/video retention.
- Obsidian embed rewriting.
- Iframe, streaming, failed, and oversized-media link fallback.
- Transaction failures proving the note is committed last.
- Native-helper integration through real length-prefixed stdin/stdout frames and temporary destination folders.

Built-extension smoke tests run against local deterministic fixtures in Chromium and Firefox. Final macOS acceptance installs browser-specific manifests, saves a fixture article into a temporary Obsidian-style destination, verifies byte-identical media and note output, exercises overwrite behavior, and then runs the bounded uninstall path.

## Acceptance Criteria

Arthur is complete when:

- Chrome/Edge and Firefox artifacts build successfully.
- A toolbar click saves a rendered article into the selected folder without opening a popup.
- The note contains only `title` and `source` frontmatter plus clean Markdown content.
- All successfully retrieved image formats retain their original bytes and animation.
- Direct audio/video files save locally; streams and iframes remain links.
- Every local media reference is an Obsidian embed into lowercase `attachments/`.
- Re-saving an existing `source` replaces that article note without overwriting unrelated notes.
- Failed or oversized media does not prevent the article save and is surfaced as a warning.
- Invalid paths, traversal attempts, symlink escapes, malformed messages, and interrupted transfers do not escape the destination or expose a partially updated note.
- macOS install, verify, and uninstall flows work for Chrome, Edge, and Firefox.
- Dependency review is documented, exact versions are locked, and audit, tests, typecheck, build, smoke, and acceptance gates pass.
