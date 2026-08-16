# Arthur Article Saver

Arthur is a macOS-first browser extension for saving the rendered article in the active tab to an Obsidian-style folder. It supports Chrome, Edge, and Firefox. A toolbar click extracts clean Markdown and preserves browser-retrievable GIF, animated WebP, SVG, AVIF, image, direct audio, and direct video bytes.

## Requirements and roles

Arthur v1 needs macOS for native-host installation. Development needs Node 22+ and pnpm 10.32.1 for WXT, TypeScript, tests, packaging, and the installer commands. Native development needs Rust 1.97.1.

Repository native commands use the dependency-free `scripts/rust-toolchain.mjs` adapter. It resolves Homebrew rustup's exact Rust 1.97.1 `cargo` and `rustc` binaries and runs Cargo with that child environment. The installed host is a single Rust binary: it has no Node, Homebrew, rustup, Cargo, launcher, copied packages, repository checkout, inherited shell configuration, or `PATH` runtime dependency.

The native crate has exactly six direct runtime crates: `serde`, `serde_json`, `rustix`, `url`, `sha2`, and `base64`. Their exact locked versions and dependency review are recorded in [docs/dependencies.md](docs/dependencies.md). Keep dependencies minimal, exact-lock all graphs, and do not ship a dependency until its purpose, maintenance, and advisory status are documented. Both `pnpm audit --audit-level high` and locked `cargo-audit 0.22.2` are required release gates.

## Development

```sh
pnpm install --frozen-lockfile
node scripts/rust-toolchain.mjs fetch --manifest-path native/Cargo.toml --locked
pnpm dev
```

For unpacked Chromium testing, build the target and load `.output/chrome-mv3` in Chrome or `.output/edge-mv3` in Edge from the extensions developer page. For Firefox temporary testing, run `pnpm dev:firefox` and use Firefox's temporary-extension loader with `.output/firefox-mv2/manifest.json`.

## Install and use

```sh
pnpm native:install
pnpm native:verify -- --destination /absolute/path/to/Vault/Clippings
```

The install creates one executable plus three browser manifests. Configure the same existing absolute destination in Arthur's options page and use the toolbar once on an HTTP(S) article. There is no normal toolbar popup. Arthur writes the article directly into the selected folder and places local media in lowercase `attachments/`:

```text
Clippings/
├── Article title.md
└── attachments/
    └── hero--content-hash.webp
```

Notes have only `title` and normalized `source` frontmatter. A matching normalized source replaces its old note in place; a same-title different source receives a suffix. Local media uses `![[attachments/name]]`. Iframes, streaming manifests, failed retrievals, and oversized media remain remote links and produce a warning. Limits are 100 MiB per image, 2 GiB per direct audio/video item, 4 GiB total media, 4,096 media items, and 10 MiB UTF-16 Markdown.

## Release gates and packaging

```sh
pnpm verify
pnpm zip
```

`pnpm verify` runs TypeScript and Rust tests, format/lint checks, locked release builds, deterministic artifact smoke, the real release-binary native roundtrip, and both audits. The roundtrip inspects committed media with bounded dependency-free Node parsers—no `ffprobe`, `webpmux`, or media tool on `PATH`—and reports each exact input/output SHA-256 pair. It requires exact ordered native transcripts, child statuses, and wholly allowlisted diagnostics for every scenario. Its pre-note-rename test internally builds a separate `acceptance-faults` binary in `native/target/acceptance`; that test-only binary cannot be installed and is excluded from packages. The default and installed host have no fault trigger or acceptance code path.

`pnpm zip` creates Chrome, Edge, and Firefox archives, then rejects a WXT source archive above 10 MiB or 500 entries and rejects native targets, dependencies, build outputs, and caches. See [docs/acceptance.md](docs/acceptance.md) for exact automated and manual evidence.

To remove only Arthur-owned host files:

```sh
pnpm native:uninstall
pnpm native:verify -- --expect-absent
```

Uninstall is bounded to Arthur's one binary and three manifests; it does not remove browser profiles, vault contents, or parent support directories.
