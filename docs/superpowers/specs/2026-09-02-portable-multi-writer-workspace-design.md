# Portable Multi-Writer Workspace Design

## Problem

Arthur currently persists filesystem device and inode numbers in `.arthur-workspace-v1`. Those identifiers are valid only for one materialization of a filesystem. A reboot, remount, iCloud download, or access from another Mac can change them without changing the file's logical contents. The native helper then rejects every transaction slot as `unsafe_child`, preventing connection verification and article saves.

Arthur must support multiple computers saving into one synchronized destination. Persistent recovery state therefore cannot depend on machine-local filesystem identities, and one computer must not recover or invalidate another computer's in-progress transaction.

## Goals

- Allow independent Arthur installations to save different articles into the same local or iCloud-synchronized destination.
- Keep crash recovery for transactions created by the same Arthur installation.
- Detect concurrent replacement of the same logical article instead of silently losing another writer's update.
- Retain descriptor-relative, no-follow filesystem operations and transient device/inode validation during one helper process.
- Stop using the invalid v1 workspace without deleting it automatically.
- Return native-host and destination failures to the extension immediately.

## Non-goals

- Distributed locking across iCloud computers.
- Automatic merging of two concurrently edited Markdown notes.
- Automatic deletion or migration of `.arthur-workspace-v1`.
- Recovery of an interrupted transaction created on another computer.
- Guaranteeing that iCloud has uploaded a completed save to every computer before Arthur reports local success.

## Chosen Architecture

### Local writer identity

The native helper owns a random UUID writer identity stored outside the synchronized destination under Arthur's local Application Support state. Installation creates it atomically when absent and preserves an existing valid identity during helper upgrades. The file is a regular, non-symlinked, mode-0600 file containing a canonical lowercase UUID plus one newline.

The helper receives the validated writer identity when it creates a Vault. Browser callers do not know or supply it. Tests may inject an identity through an internal native seam.

### Versioned shared workspace

The destination uses `.arthur-workspace-v2/<writer-id>/`. The v2 root contains a fixed format marker. Each writer directory contains its own fixed owner marker and bounded transaction slots. A helper may inspect, recover, reset, or quarantine only the directory matching its local writer identity.

Other valid writer directories are treated as opaque siblings. Their contents do not participate in the current writer's authority checks. Unexpected entries at the v2 root still fail closed, while an absent current-writer directory is initialized safely.

`.arthur-workspace-v1` is ignored by v2 code and left byte-for-byte untouched. This makes the upgrade non-destructive and allows explicit recovery or later removal.

### Portable persisted authority

Persisted journal evidence uses portable file fingerprints:

- byte length;
- SHA-256 content digest;
- expected fixed pathname or destination basename;
- journal format version and monotonically increasing generation;
- transaction phase and media index bounds.

Device number, inode number, link count, and open-file handles are never serialized. They remain transient safety evidence inside one process. Descriptor-relative `openat` operations, `O_NOFOLLOW`, link-count policy, exact fixed-layout validation, and before/after open-file identity checks continue to prevent symlink, hard-link, FIFO, and replacement races.

Journal copies authenticate their canonical payload with the existing checksum approach. Authority comes from the local writer marker, exact layout, canonical journals, portable fingerprints, and live descriptor checks—not from cross-launch device/inode equality.

### Transaction and conflict behavior

At `begin_save`, Arthur identifies the existing note by canonical source as it does today and records a portable fingerprint if a target exists. A new note records an explicit missing-target expectation.

At commit, Arthur reopens and validates the target descriptor-relatively:

- If the target was missing and remains missing, create it atomically.
- If the target existed and its portable fingerprint still matches, replace it atomically.
- If the target was created, removed, changed, became unsafe, or now resolves to a different source candidate, abort with `source_conflict` and preserve the other writer's visible note.

Different articles do not conflict. Two machines may commit unrelated targets concurrently because their staging state is writer-scoped and their final replacements are target-scoped.

The existing source-based identity and exact-title preference remain unchanged. Arthur does not merge Markdown or choose a winner for concurrent same-source saves.

### Recovery

On startup, a writer inspects only its own slots. A slot is recoverable when its exact layout, local writer marker, canonical journal copies, portable fingerprints, and current destination state agree with one permitted transaction phase.

Recovery preserves the current fail-closed behavior:

- safely provable pre-commit states reset to empty;
- safely provable post-replacement states finish durability and reset;
- ambiguous or unsafe states are quarantined and never overwrite a visible destination note;
- one quarantined slot does not invalidate other valid slots owned by the same writer;
- no valid local slot returns `unsafe_child` immediately.

The implementation must not scan or hash arbitrary destination files during connection verification. Work is bounded to the fixed workspace layout and transaction targets named by the local journals.

## Native Messaging and UI Errors

`hello` remains a capability/version handshake and must not open the destination. `test_destination` opens and probes the v2 workspace for the supplied destination. Native errors retain their exact code through `NativeClient` and the options page.

The options page displays the actionable native error rather than collapsing it to `Destination could not be checked.` The save status likewise displays `source_conflict`, `unsafe_child`, or another correlated host error immediately. The existing 30-second timeout remains a last-resort guard for a genuinely silent host, not the normal error path.

## Installation and Upgrade

The native installer manages two local artifacts:

- the executable native host binary;
- the persistent writer identity file.

It creates the identity on first install, validates and preserves it on upgrades, and rejects symlinks, malformed UUIDs, extra bytes, unsafe parents, and incorrect file type. Verification checks the identity without exposing its value in normal output.

Uninstall behavior is unchanged unless explicitly requested in a separate change: removing the helper must not silently delete recovery identity or synchronized workspace data.

## Testing

Native tests must prove:

- a v2 workspace reopens when a simulated device number changes;
- two injected writer identities initialize and use separate namespaces in one destination;
- one writer ignores another valid writer's active or crashed slots;
- two writers can save different articles;
- a same-source target changed after `begin_save` produces `source_conflict` and preserves the changed note;
- missing, changed, unsafe, and symlink-substituted targets fail closed;
- same-writer crash recovery remains valid in every journal phase;
- an existing v1 workspace remains unchanged while v2 is initialized and used;
- destination probing is bounded to the current writer workspace;
- installer creation, upgrade preservation, malformed identity, permissions, and symlink rejection work as specified.

Browser tests must prove:

- correlated native errors resolve without waiting for the timeout;
- options connection results preserve and display the native error code/message;
- save status shows `source_conflict` and `unsafe_child` as immediate errors;
- a silent host still terminates at the configured test timeout.

## Verification and Delivery

Completion requires:

1. Focused red/green tests for each behavior above.
2. `pnpm verify` passing without warnings or unrelated failures.
3. Installation and verification of the exact built helper.
4. Reloading the temporary Zen extension and refreshing the article tab.
5. A timed connection check that returns promptly.
6. A representative live save into the configured destination.
7. Inspection of the resulting note and retained media references.
8. Confirmation that `.arthur-workspace-v1` was not modified.

No source-only or build-only result is sufficient evidence of completion.
