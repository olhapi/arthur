# Release acceptance

Run the following fresh, locked automated gate from the repository root. `cargo-audit` must report exactly `cargo-audit 0.22.2`; absence or a mismatch blocks release.

```sh
test "$("${CARGO_HOME:-$HOME/.cargo}/bin/cargo-audit" --version)" = "cargo-audit 0.22.2"
pnpm install --frozen-lockfile
node scripts/rust-toolchain.mjs fetch --manifest-path native/Cargo.toml --locked
pnpm verify
pnpm zip
git diff --check
git status --short
```

Expected: frozen Node/Cargo resolution, TypeScript and Rust tests, rustfmt and Clippy with warnings denied, all three extension builds, `pnpm smoke`, `pnpm acceptance:native`, both audits, three ZIPs, a bounded source ZIP, and no diff-whitespace errors. The smoke command prints one compact JSON object after it parses all three manifests and checks the byte-exact Chromium public key and derived fixed ID, exact Firefox Gecko ID, permissions, content-script match patterns, options/status pages, background entrypoints, and the absence of a default toolbar popup. Packaging rejects a source ZIP above 10 MiB or 500 entries and rejects `native/target`, `node_modules`, extension build outputs, coverage, distribution, and cache paths.

The native command prints one compact JSON object with named fixture input/output SHA-256 pairs, exact output paths, collision hashes, strict framing evidence, pre-note-rename before/after hashes and trees, and the full destination trees. It first inspects every committed fixture offline with bounded dependency-free Node parsers; `ffprobe`, `webpmux`, and other media executables are neither called nor required on `PATH`. The GIF parser requires nonzero logical/frame dimensions, every frame rectangle inside the logical screen, legal 2–8 LZW minimum code sizes, terminated bounded sub-blocks, control timing, and at least two image descriptors. WebP requires exact RIFF/WEBP bounds, the VP8X animation flag, ANIM, and at least two bounded ANMF frame payloads. SVG requires bounded UTF-8 XML, an SVG root, and dimensions. AVIF requires bounded ISO BMFF boxes under explicit depth/box/work budgets, an AVIF/AVIS brand, capped and exactly consumed `iloc` items/extents with valid field sizes and payload offsets, AV1 item/property evidence, dimensions, and a nonempty coded payload. MP3 requires a bounded optional ID3 tag followed by at least two valid MPEG frames that consume the exact remaining file with no truncation or trailing garbage. MP4 requires bounded `ftyp`, `moov/trak/mdia`, a `vide` handler, dimensions/duration, a capped and exact `stsz` sample table consistent with `mdat`, and nonempty sample payload evidence.

The native result uses the default release binary directly with `PATH=/usr/bin:/bin` for every normal, limit, race, EOF, and poison check. Its fixture hashes cover `animated.gif`, `animated.webp`, `diagram.svg`, `photo.avif`, `audio.mp3`, and `video.mp4`; every named output hash must equal its mapped input hash. It proves a saved note has LF endings, exactly `title`/`source` frontmatter, lowercase `attachments/` embeds, and an in-place normalized replacement from `HTTPS://Example.TEST:443/a#old` to `https://example.test/a#new`. Fixture, collision, warning, individual/total limit, attachment race, fault, poison, and EOF scenarios each require the exact child status, exact count/order/content of framed messages, and the complete stderr value. No extra frame or diagnostic is accepted. It also proves an incomplete transfer keeps a normalized remote autolink, individual/total limits expose no note, normal EOF is silent, and zero/oversized/truncated/invalid-UTF-8/invalid-JSON frames emit exactly one canonical framed error with only the allowlisted diagnostic.

The deterministic commit interruption alone uses `arthur-native-acceptance-host`, built internally by `native-roundtrip.mjs` through the exact Rust adapter with `acceptance-faults` and the separate `native/target/acceptance` directory. The package command remains exactly `node scripts/smoke/native-roundtrip.mjs --binary native/target/release/arthur-native-host`. The fault host invokes Vault's existing `CommitFault::BeforeNoteRename` through the same host/session/framed-message path, and asserts the old note's before/after SHA-256 is identical and no new note is visible. The feature is absent from the default binary, the installer accepts only the exact `arthur-native-host` basename, and all native targets are excluded from source packages. This seam is for build and acceptance only; it is never an installed-host option and does not change the canonical protocol.

## Installed-browser check

Only after the automated gate passes, create one dedicated destination and keep its printed path as acceptance evidence:

```sh
ARTHUR_ACCEPTANCE_DEST="$(mktemp -d -t arthur-acceptance)"; pnpm native:install; pnpm native:verify -- --destination "$ARTHUR_ACCEPTANCE_DEST"; printf "%s\n" "$ARTHUR_ACCEPTANCE_DEST"
```

Inventory before browser use must contain exactly these four Arthur files and nothing else in Arthur's native-host directory:

```text
~/Library/Application Support/Arthur/native-host/arthur-native-host
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.olhapi.arthur.json
~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.olhapi.arthur.json
~/Library/Application Support/Mozilla/NativeMessagingHosts/com.olhapi.arthur.json
```

In installed Chrome, Edge, and Firefox profiles, configure the printed destination, open the fixture article, and click Arthur once. Confirm that no popup appears, local media retains the six input hashes, iframe/stream entries remain remote links, a normalized-source re-save overwrites in place, an unrelated same-title note remains, and a failed/oversized medium shows warning details on the next toolbar click. Capture before/after destination trees; for an interrupted commit-last check the previous note must remain byte-identical. Record all browser versions, hashes, paths, and warning text in the task acceptance evidence.

Then run the bounded cleanup:

```sh
pnpm native:uninstall
pnpm native:verify -- --expect-absent
```

After recording evidence, delete only the printed dedicated destination if it is empty. If installation, a browser check, verification, or uninstall fails, retain that destination and evidence; do not use fake-home tests as installed-browser proof.
