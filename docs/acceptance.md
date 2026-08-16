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

Expected: frozen Node/Cargo resolution, TypeScript and Rust tests, rustfmt and Clippy with warnings denied, all three extension builds, `pnpm smoke`, `pnpm acceptance:native`, both audits, three ZIPs, and no diff-whitespace errors. The smoke command prints one compact JSON object after it parses all three manifests and checks identities, permissions, content-script match patterns, options/status pages, background entrypoints, and the absence of a default toolbar popup. The native command prints one compact JSON object with the direct binary, fixture SHA-256 values, and byte-retention, normalized overwrite, collision, warning fallback, limits, interruption, and poison checks.

The native result uses the release binary directly with `PATH=/usr/bin:/bin`. Its fixture hashes cover `animated.gif`, `animated.webp`, `diagram.svg`, `photo.avif`, `audio.mp3`, and `video.mp4`; the matching output hashes must be byte-identical. It proves a saved note has LF endings, exactly `title`/`source` frontmatter, lowercase `attachments/` embeds, and an in-place normalized replacement from `HTTPS://Example.TEST:443/a#old` to `https://example.test/a#new`. It also proves an incomplete transfer keeps a normalized remote autolink, individual/total limits expose no note, EOF leaves the old note byte-identical, and zero/oversized/truncated/invalid-UTF-8/invalid-JSON frames emit one error and never answer a later hello.

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
