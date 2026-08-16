import { afterEach, describe, expect, it } from "vitest";
import { access, mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { assertSafeNewChild, resolveDestination } from "./paths.js";

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "arthur-paths-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("destination path confinement", () => {
  it("resolves an absolute writable destination to its real directory", async () => {
    const directory = await makeTemporaryDirectory();
    const destination = await resolveDestination(directory);

    expect(destination.path).toBe(await realpath(directory));
    await expect(access(destination.path, constants.W_OK)).resolves.toBeUndefined();
  });

  it("resolves a symlinked destination root to the target directory", async () => {
    const temporary = await makeTemporaryDirectory();
    const target = join(temporary, "target");
    const link = join(temporary, "link");
    await mkdir(target);
    await symlink(target, link, "dir");

    expect((await resolveDestination(link)).path).toBe(await realpath(target));
  });

  it("rejects traversal and absolute child paths", async () => {
    const temporary = await makeTemporaryDirectory();
    const destination = await resolveDestination(temporary);

    await expect(assertSafeNewChild(destination, "../escape.md")).rejects.toThrow(/relative/i);
    await expect(assertSafeNewChild(destination, join(temporary, "escape.md"))).rejects.toThrow(
      /relative/i,
    );
  });

  it("rejects a child symlink that escapes the destination", async () => {
    const temporary = await makeTemporaryDirectory();
    const destinationRoot = join(temporary, "destination");
    const outside = join(temporary, "outside");
    await mkdir(destinationRoot);
    await mkdir(outside);
    await symlink(outside, join(destinationRoot, "escape"), "dir");
    const destination = await resolveDestination(destinationRoot);

    await expect(assertSafeNewChild(destination, "escape/article.md")).rejects.toThrow(/escapes/i);
  });

  it("allows a new file beneath existing normal directory children", async () => {
    const temporary = await makeTemporaryDirectory();
    const nested = join(temporary, "notes");
    await mkdir(nested);
    const destination = await resolveDestination(temporary);

    await expect(assertSafeNewChild(destination, "notes/article.md")).resolves.toBe(
      join(await realpath(nested), "article.md"),
    );
  });
});
