# Arthur macOS native host

Arthur v1 installs a native-messaging host on macOS only. The repository build uses Rust 1.97.1. Node 22+ and pnpm are used only to run Arthur's repository build, installation, verification, and uninstall scripts.

## Identity and installed files

The Chromium public identity is `kaknffcpoififkcmhphedbajjbacfaof`; the Firefox extension ID is `arthur@olhapi.com`.

Installation copies exactly one Rust release binary to:

```text
~/Library/Application Support/Arthur/native-host/arthur-native-host
```

It writes these three manifests, each of which points directly to that binary:

```text
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.olhapi.arthur.json
~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.olhapi.arthur.json
~/Library/Application Support/Mozilla/NativeMessagingHosts/com.olhapi.arthur.json
```

Browser launch of the installed host requires no Node executable, launcher, copied package, inherited `PATH`, or repository checkout.

## Commands

From the Arthur repository:

```sh
pnpm native:install
pnpm native:verify
pnpm native:verify -- --destination /absolute/Obsidian/Vault
pnpm native:uninstall
```

The installer first builds the locked Rust release target. Verification checks all manifests, the direct executable path and mode, then directly launches the binary using only `PATH=/usr/bin:/bin` for a framed `hello`. The destination form also requires a matching writable `test_destination` reply.

Installation is recoverable: the binary and each manifest are staged in their final directory, fsynced, and atomically renamed. Uninstall is bounded. It can remove only these exact four Arthur-owned files: the single binary and the three manifest files above. It leaves parent browser and application-support directories in place.

The installer canonicalizes the supplied home once and validates every created or used descendant directory as a non-symlink directory immediately before file operations. It deliberately does not claim resistance to a concurrent same-user filesystem attacker changing those paths between system calls; that race is outside the Task 7 threat model.
