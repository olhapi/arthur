import { constants } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export interface Destination {
  readonly path: string;
}

function isWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

function childParts(relativePath: string): string[] {
  if (relativePath.length === 0 || isAbsolute(relativePath) || relativePath.includes("\0")) {
    throw new TypeError("Child path must be a non-empty relative path");
  }

  const parts = relativePath.split(/[\\/]/u);
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new TypeError("Child path must contain only relative basenames");
  }
  return parts;
}

export async function resolveDestination(path: string): Promise<Destination> {
  if (!isAbsolute(path)) {
    throw new TypeError("Destination must be an absolute path");
  }

  const resolvedPath = await realpath(path);
  const metadata = await stat(resolvedPath);
  if (!metadata.isDirectory()) {
    throw new TypeError("Destination must be a directory");
  }
  await access(resolvedPath, constants.W_OK);

  return Object.freeze({ path: resolvedPath });
}

export async function assertSafeNewChild(
  destination: Destination,
  relativePath: string,
): Promise<string> {
  const parts = childParts(relativePath);
  const root = await realpath(destination.path);
  const rootMetadata = await stat(root);
  if (!rootMetadata.isDirectory()) {
    throw new TypeError("Destination must be a directory");
  }

  let current = root;
  for (const [index, part] of parts.entries()) {
    const candidate = join(current, part);
    let metadata;
    try {
      metadata = await lstat(candidate);
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        return join(current, ...parts.slice(index));
      }
      throw error;
    }

    const resolved = await realpath(candidate);
    if (!isWithin(root, resolved)) {
      throw new TypeError("Child path escapes the destination");
    }
    if (index === parts.length - 1) {
      throw new TypeError("Child path already exists");
    }
    if (!metadata.isDirectory() && !metadata.isSymbolicLink()) {
      throw new TypeError("Existing child ancestor must be a directory");
    }
    if (!(await stat(resolved)).isDirectory()) {
      throw new TypeError("Existing child ancestor must be a directory");
    }
    current = resolved;
  }

  throw new Error("Unreachable child path state");
}
