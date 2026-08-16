import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { validateSourceArchives } from "./check-zips.mjs";

describe("source archive inventory", () => {
  it("rejects native targets, dependencies, build outputs, and caches", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "arthur-source-zip-"));
    await mkdir(path.join(root, "native/target"), { recursive: true });
    await writeFile(path.join(root, "native/target/binary"), "bad");
    const archive = path.join(root, "arthur-0.1.0-sources.zip");
    const zip = spawnSync("/usr/bin/zip", ["-q", archive, "native/target/binary"], { cwd: root });
    expect(zip.status).toBe(0);
    await expect(validateSourceArchives({ root })).rejects.toThrow(/native\/target/i);
  });

  it("rejects the acceptance-only native entrypoint", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "arthur-acceptance-source-zip-"));
    await mkdir(path.join(root, "native/src/bin"), { recursive: true });
    await writeFile(path.join(root, "native/src/bin/arthur-native-acceptance-host.rs"), "acceptance only");
    const archive = path.join(root, "arthur-0.1.0-sources.zip");
    const zip = spawnSync("/usr/bin/zip", ["-q", archive, "native/src/bin/arthur-native-acceptance-host.rs"], { cwd: root });
    expect(zip.status).toBe(0);
    await expect(validateSourceArchives({ root })).rejects.toThrow(/acceptance/i);
  });
});
