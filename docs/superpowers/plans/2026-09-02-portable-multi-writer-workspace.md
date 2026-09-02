# Portable Multi-Writer Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Arthur's machine-bound v1 transaction authority with a portable, writer-scoped v2 workspace that works across computers sharing an iCloud destination and reports native failures immediately.

**Architecture:** The installer owns a persistent local UUID; the native server injects it into the Vault. The Vault stores each writer's bounded transaction slots under `.arthur-workspace-v2/<writer-id>` and persists content fingerprints only, retaining descriptor/inode checks solely for live race detection. Commit uses optimistic portable target fingerprints, while the browser preserves correlated native error details.

**Tech Stack:** Rust 2024, rustix descriptor-relative filesystem operations, serde/sha2, TypeScript, WXT, Vitest, Node installer scripts.

**Spec:** `docs/superpowers/specs/2026-09-02-portable-multi-writer-workspace-design.md`

## Global Constraints

- Multiple Arthur installations may save different articles into one synchronized destination.
- Simultaneous changes to the same source fail with `source_conflict`; Arthur never silently selects a winner.
- Persisted state contains no device numbers, inode numbers, link counts, or open-handle identities.
- Live operations retain `openat`, `O_NOFOLLOW`, link-count checks, and before/after descriptor identity validation.
- `.arthur-workspace-v1` remains byte-for-byte untouched.
- Native failures resolve immediately; 30 seconds is only the silent-host deadline.
- Preserve all pre-existing dirty files and commit only files belonging to this implementation.

---

### Task 1: Persistent Local Writer Identity

**Files:**
- Modify: `scripts/native-host/install.mjs`
- Modify: `scripts/native-host/verify.mjs`
- Modify: `scripts/native-host/install.test.ts`
- Modify: `scripts/native-host/verify.test.ts`
- Modify: `native/src/main.rs`
- Modify: `native/src/lib.rs`
- Modify: `native/src/server.rs`
- Modify: `native/tests/native_host.rs`

**Interfaces:**
- Produces: local state file `~/Library/Application Support/Arthur/state/writer-id` containing `/^[0-9a-f-]{36}\n$/`, mode `0600`.
- Produces: `run_server_with_writer<R, W>(reader, writer, writer_id)` internal test seam; production reads the validated local identity before serving.

- [ ] **Step 1: Write failing installer tests**

Add cases proving first install creates a canonical UUID identity, an upgrade preserves it, and malformed, symlinked, non-regular, or incorrectly permissioned identity files fail verification.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm test -- scripts/native-host/install.test.ts scripts/native-host/verify.test.ts`

Expected: failures because the install plan and verifier know only the binary/manifests.

- [ ] **Step 3: Implement identity installation and verification**

Extend `nativeHostTargets` with a state directory and writer-id target. Create the identity with exclusive, no-follow, atomic file operations and mode `0600`; preserve a valid existing identity. Validate exact canonical UUID bytes without printing the value.

- [ ] **Step 4: Write failing native startup tests**

Exercise missing and malformed identity input through the native startup seam, and prove a valid injected writer ID reaches destination operations.

- [ ] **Step 5: Run native tests and verify RED**

Run: `node scripts/rust-toolchain.mjs test --manifest-path native/Cargo.toml --locked native_host`

- [ ] **Step 6: Pass writer identity into the server/Vault**

Read the fixed local identity file at startup, validate it, and retain it in the session so every `Vault::open` receives the same writer ID.

- [ ] **Step 7: Verify GREEN**

Run the focused JS tests and `pnpm test:native`.

### Task 2: Portable Writer-Scoped Workspace v2

**Files:**
- Modify: `native/src/vault/fs.rs`
- Modify: `native/src/vault/workspace.rs`
- Modify: `native/src/vault/mod.rs`
- Modify: `native/src/vault/transaction.rs`
- Modify: `native/tests/vault.rs`
- Modify: `native/tests/vault_transaction.rs`

**Interfaces:**
- Consumes: validated writer UUID from Task 1.
- Produces: `Vault::open(destination: &Path, writer_id: &WriterId)` and `.arthur-workspace-v2/<writer-id>`.
- Produces: persisted portable fingerprint `{ size: u64, sha256: String }`; transient `FileIdentity` remains in memory only.

- [ ] **Step 1: Write failing cross-materialization and v1-coexistence tests**

Create a workspace with writer A, simulate changed stored device identity using the existing v1 fixture pattern, reopen v2 successfully, and assert a pre-existing v1 tree's recursive digest is unchanged.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node scripts/rust-toolchain.mjs test --manifest-path native/Cargo.toml --locked workspace`

Expected: failures because v1 serializes `FileIdentity` and has no writer namespace.

- [ ] **Step 3: Introduce v2 layout and portable journal schema**

Rename the shared workspace constant to `.arthur-workspace-v2`, create/validate the root format marker, open only the current writer UUID directory, and serialize only content fingerprints and semantic journal fields. Keep live descriptor identities private to the open `Slot`.

- [ ] **Step 4: Write failing two-writer isolation tests**

Open the same destination with writer A and writer B. Prove they receive separate slots, writer B ignores writer A's preparing/crashed slot, and unexpected root entries fail closed without reading another writer's slot contents.

- [ ] **Step 5: Implement writer isolation and bounded recovery**

Scope exact layout and recovery checks to the local writer directory. Validate other root entries by basename/type only; never hash or recover their contents.

- [ ] **Step 6: Verify GREEN**

Run focused workspace tests, then `pnpm test:native`.

### Task 3: Optimistic Same-Source Conflict Detection

**Files:**
- Modify: `native/src/vault/frontmatter.rs`
- Modify: `native/src/vault/transaction.rs`
- Modify: `native/src/vault/workspace.rs`
- Modify: `native/tests/vault_transaction.rs`
- Modify: `native/tests/vault.rs`

**Interfaces:**
- Consumes: portable target fingerprint captured when `begin_save` selects an existing note.
- Produces: `VaultError::SourceConflict` when the target expectation changes before commit.

- [ ] **Step 1: Write failing concurrent-writer tests**

Begin writer A and writer B saves in one destination. Assert different targets both commit. For one source, modify/create/remove/substitute the target after begin; assert commit returns `SourceConflict` and preserves the intervening visible bytes.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node scripts/rust-toolchain.mjs test --manifest-path native/Cargo.toml --locked concurrent`

- [ ] **Step 3: Capture and persist target expectation**

Record either `Missing` or the selected note's portable fingerprint and source identity in the journal before preparing replacement bytes.

- [ ] **Step 4: Validate expectation immediately before replacement**

Reopen descriptor-relatively, recheck safe type/link state and portable fingerprint, and return `SourceConflict` on any mismatch. Keep the existing atomic no-replace/exchange operations after validation.

- [ ] **Step 5: Extend recovery tests for every journal phase**

Prove same-writer preparing, exchange-pending, and committed recovery remains safe; ambiguous target state quarantines the slot without altering the destination.

- [ ] **Step 6: Verify GREEN**

Run focused transaction tests, then `pnpm test:native`.

### Task 4: Immediate Native Error Propagation

**Files:**
- Modify: `entrypoints/options/main.ts`
- Modify: `entrypoints/options/main.test.ts`
- Modify: `src/background/native-client.ts`
- Modify: `src/background/native-client.test.ts`
- Modify: `src/background/save-coordinator.ts`
- Modify: `src/background/save-coordinator.test.ts`
- Modify: `src/background/status.ts`
- Modify: `src/background/status.test.ts`

**Interfaces:**
- Consumes: correlated `NativeHostError(code, message)`.
- Produces: `ConnectionResult.folder` containing the native code/message and save status showing the same error immediately.

- [ ] **Step 1: Write failing browser tests**

Return `unsafe_child` and `source_conflict` from a responsive fake port; assert options/save settle before a 100 ms sentinel and retain exact code/message. Retain the existing silent-host timeout test.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm test -- entrypoints/options/main.test.ts src/background/native-client.test.ts src/background/save-coordinator.test.ts src/background/status.test.ts`

- [ ] **Step 3: Preserve structured native failures through the UI**

Change connection result details to carry an optional code, map `NativeClientError` without replacing its message, and render the actionable folder error. Do not shorten or remove the silent-host deadline.

- [ ] **Step 4: Verify GREEN**

Run the focused browser tests and `pnpm typecheck`.

### Task 5: Migration, Full Verification, and Live Runtime Proof

**Files:**
- Modify only if tests require: `docs/native-host.md`
- Runtime artifact: installed helper and temporary Zen extension

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: verified helper installation, prompt connection result, and a saved/inspected note without modifying v1.

- [ ] **Step 1: Record v1 evidence before installation**

Run a deterministic recursive metadata/content digest over the configured destination's `.arthur-workspace-v1` and save the output under `/private/tmp`.

- [ ] **Step 2: Run repository verification**

Run: `pnpm verify`

Expected: all browser tests, typecheck, Rust tests/format/Clippy, native/browser builds, smoke, native round-trip, and audits pass.

- [ ] **Step 3: Install and verify the exact helper**

Run: `pnpm native:install` and `pnpm native:verify -- --destination <configured-absolute-destination>`; compare SHA-256 of installed and built binaries.

- [ ] **Step 4: Prove v1 remained untouched**

Repeat the recursive digest and compare it byte-for-byte with Step 1.

- [ ] **Step 5: Reload and time Zen**

Reload the temporary extension, refresh the article tab, time `Test connection`, and require a responsive success rather than a timeout.

- [ ] **Step 6: Perform and inspect a live save**

Save a representative small article, require the status to leave saving promptly, inspect the resulting Markdown/frontmatter/media references, and confirm the v2 writer namespace exists.

- [ ] **Step 7: Review and commit scoped changes**

Run `git diff --check`, inspect the exact requested file set, preserve unrelated dirty files, and commit with a Conventional Commit message describing the portable multi-writer fix.
