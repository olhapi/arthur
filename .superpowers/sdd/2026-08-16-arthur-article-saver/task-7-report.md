# Task 7 report: bounded Rust native-host installation

## Delivery

- Generated a temporary 2048-bit Chromium RSA identity, retained only the public DER base64 and derived extension ID `kaknffcpoififkcmhphedbajjbacfaof`, and discarded the private key.
- Added a single-binary installer, direct verifier, bounded uninstaller, lifecycle tests, package commands, strict script type declarations, and native-host documentation.
- The installer permits exactly one `arthur-native-host` release binary at `~/Library/Application Support/Arthur/native-host/arthur-native-host` and exactly three browser manifests at the specified user-level Chrome, Edge, and Firefox locations.
- Manifests point directly to the binary. Chromium permits only `chrome-extension://kaknffcpoififkcmhphedbajjbacfaof/`; Firefox permits only `arthur@olhapi.com`.
- Staged copies and manifests use same-directory exclusive temporary files, fsync, and rename. Source/final targets reject missing, symlink, or non-regular files. Install and uninstall plans reject paths outside the exact allowlist.
- Verification enforces exact manifest JSON, binary mode `0755`, a native-host directory containing only the binary, a direct framed `hello` under `PATH=/usr/bin:/bin`, and an exact writable destination response. `--expect-absent` checks all four allowlisted files without spawning.

## RED to GREEN evidence

- RED: `rtk pnpm test -- scripts/native-host` failed because the identity and lifecycle modules did not exist.
- GREEN: `rtk pnpm test -- scripts/native-host` passed: 18 files, 104 tests.
- A forged install-plan target test was added and first failed; the installer now validates plan destinations against the exact allowlist.

## Required gates

All passed:

```text
rtk pnpm build:native
rtk pnpm test -- scripts/native-host
rtk pnpm typecheck
rtk pnpm audit:native
rtk git diff --check
```

`pnpm audit:native` required the standard Cargo advisory cache outside the workspace sandbox; it completed with the locked graph scan of 57 dependencies.

## Isolated runtime proof

With a fresh temporary fake `HOME` and temporary absolute destination, the release binary was installed and verified directly. The resulting inventory contained only:

```text
Library/Application Support/Arthur/native-host/arthur-native-host
Library/Application Support/Google/Chrome/NativeMessagingHosts/com.olhapi.arthur.json
Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.olhapi.arthur.json
Library/Application Support/Mozilla/NativeMessagingHosts/com.olhapi.arthur.json
```

The direct framed hello and destination test succeeded with the minimal environment. Bounded uninstall followed by `--expect-absent` succeeded. No real browser configuration was modified.

## Review fix round 1

- Recomputed installation and uninstall targets from an injected, canonicalized home at application time; forged complete plans cannot select arbitrary write/delete paths.
- Added one-segment-at-a-time non-symlink directory validation before descendant filesystem operations. Same-user concurrent path replacement is explicitly outside this task's threat model.
- Re-exported parsed SPKI DER for byte equality, rejecting trailing public-key data.
- Capped host stdout at 1 MiB, uses fatal UTF-8 decoding for the framed JSON payload, and rejects malformed/noisy output before accepting a reply.
- Destination verification now canonicalizes through the injected filesystem, permitting legitimate selected-destination symlinks.
- Added focused forged-plan, trailing-DER, framing, no-spawn absence, and destination-symlink coverage.
