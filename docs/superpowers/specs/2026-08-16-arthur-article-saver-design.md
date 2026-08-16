# Arthur Article Saver Design

## Purpose

Arthur is a one-click browser extension for Chrome, Edge, and Firefox. It extracts the main article from the active rendered page, converts it to clean Markdown, downloads supported media without transcoding, and saves the result into a user-selected folder inside an Obsidian vault through a macOS native-messaging helper.

The selected folder is the complete article destination. Article notes are written directly into it. All downloaded media is shared through one lowercase `attachments/` subfolder.

## Scope

Version 1 includes:

- Chrome, Edge, and Firefox extension builds using WXT and vanilla HTML, CSS, and TypeScript.
- A self-contained macOS native-messaging helper binary written in Rust.
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

`source` is the active tab's final HTTP(S) URL after redirects. Arthur removes the fragment, relies on WHATWG-compatible URL serialization to normalize scheme, host, and default ports, and preserves the path and query. The browser normalizes the outgoing source, and the native helper independently normalizes both the incoming source and every stored frontmatter source before comparing them. Page-supplied canonical URLs are not used for identity, so a document cannot redirect writes to an unrelated identity.

Downloaded media is referenced with Obsidian embeds:

```markdown
![[attachments/hero--b7c87d380f4e.webp]]
```

Attachment names consist of a project-owned sanitized original basename, a short SHA-256 content hash, and the preserved or MIME-derived extension. Identical content is reused. Different content cannot collide merely because it has the same original name.

## Existing Article Behavior

Before writing a note, the helper scans Markdown files directly inside the selected destination folder and reads frontmatter written by Arthur. It normalizes each valid stored source with the same Rust URL implementation used for the incoming source. If a note has the same normalized `source` URL, Arthur atomically replaces that note in place. This remains true if the remote title changed.

If no source matches and the sanitized title filename is unused, Arthur uses `<sanitized-title>.md`. If that filename belongs to a different source, Arthur writes `<sanitized-title>--<short-source-hash>.md`. It never overwrites an unrelated note.

The destination folder and its Markdown files are the source of truth. Arthur does not maintain a hidden article index.

## Components

### Content extraction

The WXT content script clones the active rendered document so the page is never mutated. Before Readability runs, it resolves relative resource URLs and materializes responsive selections, preferring `currentSrc` for retained `img`, `picture`, `audio`, and `video` elements and their poster images. Mozilla Readability extracts the main article and metadata.

DOMPurify sanitizes the extracted article in the browser context. It removes scripts, event handlers, forms, unsafe embedded content, tracking elements, and irrelevant markup. Turndown converts the sanitized HTML to Markdown.

The project owns only the small additional Markdown rules it needs: fenced code, tables, and strikethrough. It does not use `turndown-plugin-gfm`.

### Extension coordinator

The background service coordinates extraction, media retrieval, native transfer, and toolbar state. It fetches retained media with extension host permissions and streams the response into bounded native-messaging chunks. It does not decode or transcode media.

The coordinator preflights retained media responses, streams eligible bodies, and reports transfer completion using the existing native-messaging contract. The Rust Vault module owns the placeholder-to-attachment mapping and rewrites successfully saved references to Obsidian embeds at commit. The coordinator records preflight failures as remote links; Vault records failures after a media transfer begins. Either path yields a warning without discarding the article. An HTTP(S) audio or video file URL is direct unless its URL or response content type identifies a streaming manifest such as HLS or DASH. Unsupported schemes, streamed sources, and iframes remain remote links.

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

The helper is one self-contained Rust macOS binary. It uses the browser native-messaging protocol: four-byte little-endian message length followed by UTF-8 JSON. The browser-side Zod schemas remain the canonical JSON interface. Strict Rust `serde` enums match those schemas through shared cross-language fixtures; Rust then validates semantic constraints and every transfer transition.

Frame decoding is fail-closed. After any invalid length, truncated frame at EOF, other framing failure, UTF-8 failure, or JSON failure, the decoder becomes permanently poisoned, emits at most one typed error, accepts no later frame, and the host exits. Protocol output is written only to stdout; diagnostics are written only to stderr.

The native filesystem seam is a deep `Vault` module with a small interface. Its implementation opens and owns the selected destination and lowercase `attachments/` directory descriptors. Save transactions remain opaque outside the module: raw child mutation paths and directory descriptors never cross its interface. Staging, attachment installation, note replacement, cleanup, scanning, and write probes use descriptor-relative, no-follow `rustix` operations (`openat`, `mkdirat`, `renameat`/`renameat_with`, `unlinkat`, `statat`, and descriptor syncs).

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
4. The coordinator preflights retained media responses and resolves fetch, HTTP, streaming, and known-size fallbacks.
5. The coordinator opens a validated save session with the helper using Markdown whose remaining placeholders correspond only to eligible media.
6. Each eligible media response is streamed in bounded chunks to a staged file.
7. The helper determines each final content-addressed attachment name.
8. The Vault transaction finalizes Markdown placeholders from its internal successful-media mapping and remote-link fallback mapping.
9. The Vault implementation moves new attachment files into `attachments/` with descriptor-relative same-filesystem renames.
10. The Vault implementation atomically replaces or creates the article note last.
11. The helper cleans the staging area and returns success or warnings.
12. The extension updates the badge and optional status details.

Writing the note last prevents Arthur from exposing a newly updated note whose new local attachments are absent. Content-addressed attachments are immutable and safe to reuse. A failure before the note rename leaves the previous note intact.

## Security and Validation

Every value received by the helper is untrusted. The helper must:

- Require the selected destination to be an existing absolute directory.
- Resolve the selected directory once, open it as a no-follow directory descriptor, and perform every child mutation relative to owned directory descriptors.
- Allow the selected directory itself to resolve through a legitimate symlink, but reject child-target symlink escapes.
- Reject traversal, absolute child paths, NUL bytes, empty filenames, control characters, and platform-unsafe filename forms.
- Create only its staging directory and the lowercase `attachments/` directory beneath the selected folder.
- Use descriptor-relative no-follow opens, exclusive temporary-file creation, no-replace attachment installation, same-filesystem renames, and descriptor syncs.
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

The macOS installer builds the locked release target and copies exactly one `arthur-native-host` binary into Arthur's application-support directory. Browser manifests point directly to that absolute executable. The installed host has no Node runtime, launcher, `node_modules`, or shell `PATH` dependency.

The installer writes browser-specific native-host manifests in the documented user-level locations for Chrome, Edge, and Firefox. Chromium manifests use allowed origins tied to fixed extension IDs; Firefox uses its fixed Gecko extension ID. Verify tooling checks the installed binary, manifest JSON, IDs, executable mode, helper handshake, and destination access. Uninstall tooling removes only the Arthur-owned binary and manifests after validating their exact paths.

## Dependencies

Dependencies are minimized and exact versions are locked in `pnpm-lock.yaml` and `native/Cargo.lock`.

Runtime dependencies:

- `@mozilla/readability` for main-article extraction.
- `dompurify` for browser-context HTML sanitization.
- `turndown` for HTML-to-Markdown conversion.
- `zod` for settings and protocol validation.

Development dependencies:

- `wxt` for cross-browser extension builds.
- `typescript` for strict extension and shared browser protocol code.
- `vitest` for unit and integration tests.
- `happy-dom` for DOM integration tests without adding jsdom.
- `@types/turndown` only if the selected Turndown release lacks bundled declarations.

The Rust 1.97.1 native crate has exactly these direct runtime dependencies, verified as the current stable releases on 2026-08-16:

- `serde` 1.0.229 with `derive` for strict protocol enums.
- `serde_json` 1.0.151 for JSON frames and shared contract fixtures.
- `rustix` 1.1.4 with only `std` and `fs` for descriptor-relative filesystem operations.
- `url` 2.5.8 for identical normalization of stored and incoming sources.
- `sha2` 0.11.0 without default features for incremental SHA-256.
- `base64` 0.23.1 with `std` but without its `simd-unsafe` default feature for bounded chunk decoding.

The dependency repositories showed current maintenance activity between 2026-06-15 and 2026-08-08. The RustSec advisory database snapshot at commit `69f93e1d081d8b6fbee010e48f0b5e0d13661415` contains only historical advisories for `sha2` and `base64`; the selected versions are above their patched ranges. This point-in-time review does not replace the complete locked-graph `cargo audit` gate.

`tsx` is omitted because no script executes TypeScript directly. `date-fns` is omitted because the accepted design has no date formatting. `fflate` is omitted because there is no ZIP fallback. React, Vue, Svelte, Plasmo, `turndown-plugin-gfm`, `sanitize-filename`, jszip, tsup, and jsdom are not used.

Before installation, each npm package must be checked with `pnpm view <package> version time deprecated`, and each Rust crate with `cargo search` plus `cargo info`; every primary repository must be checked for recent activity and advisories. The resolved project must pass both `pnpm audit` and `cargo audit`. Build-time Rust commands resolve Homebrew's keg-only rustup directory with `brew --prefix rustup` and explicitly select toolchain 1.97.1; they never fall through to a different Homebrew `cargo`. `cargo-audit` 0.22.2 is installed in the standard Cargo bin, but every implementation/release run must verify that exact version and reinstall it with the selected rustup Cargo only if it is absent or mismatched. Inability to resolve rustup, select Rust 1.97.1, verify cargo-audit 0.22.2, or run it against `native/Cargo.lock` blocks the task and must never become a skipped or weakened gate. This build-time resolution does not add Homebrew, rustup, Cargo, or Node as an installed-host dependency. Any dependency beyond the two lists requires a documented feature-specific reason.

## Testing Strategy

All behavior changes follow red-green-refactor development. A production function is introduced only after a focused test has failed for the expected missing behavior.

Vitest coverage includes:

- Canonical Zod protocol schemas and cross-language contract fixtures.
- Toolbar and status state transitions.
- Readability, DOMPurify, and Turndown integration.
- Relative and responsive resource resolution.
- GIF, animated WebP, SVG, AVIF, and direct audio/video retention.
- Obsidian embed rewriting.
- Iframe, streaming, failed, and oversized-media link fallback.
- Native-client request/response and tuple-ack correlation against canonical host messages.

Rust unit and integration coverage includes:

- Strict `serde` protocol parity with every canonical Zod message variant.
- Fragmented/coalesced frame decoding and permanent poison after every invalid length, truncated EOF, UTF-8, or JSON failure.
- Filename sanitization, YAML serialization, normalized stored/incoming source matching, and collision handling.
- Descriptor-relative confinement against symlink replacement races for the destination's children, staging area, attachments, and notes.
- Attachment extension selection, incremental content hashing, chunk order, byte counts, aborts, and resource limits.
- Transaction failures proving attachment installation precedes the note and the note is committed last.
- Native-host integration through the release binary's real length-prefixed stdin/stdout frames.

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
- Any framing, UTF-8, or JSON failure permanently poisons that native connection; later bytes are never interpreted as a new request.
- macOS install, verify, and uninstall flows work for Chrome, Edge, and Firefox.
- The installed native host is one binary and runs without Node, a launcher, copied packages, or inherited shell configuration.
- Dependency review is documented, exact versions are locked, and npm audit, Cargo audit, tests, typecheck, Rust formatting/lints, build, smoke, and acceptance gates pass.

## Delivery Workflow

Implementation follows strict red-green-refactor development. Terra implements one plan task at a time; Sol performs the independent specification and quality review at each SDD gate. No task is final until its focused tests, the applicable repository gates, and the required Sol review pass.
