import { describe, expect, it } from "vitest";

import type { ExtractedArticle, ExtractedMedia } from "../article/extract.js";
import { MEDIA_LIMITS } from "../shared/constants.js";
import { NativeHostError, NativeLimitError, type NativeClient } from "./native-client.js";
import type { PreparedMedia } from "./media-transfer.js";
import { SaveCoordinator } from "./save-coordinator.js";
import type { SaveStatus } from "./status.js";

const SESSION_ID = "a5a74c85-92de-4a5d-9768-4e66c4d64987";
const MEDIA_ID = "7f9b5e81-4e80-4b7b-9ac5-c5d54f88b832";

class RecordingStatus implements SaveStatus {
  readonly calls: string[] = [];
  readonly details: unknown[] = [];

  async saving(): Promise<void> {
    this.calls.push("saving");
  }

  async success(): Promise<void> {
    this.calls.push("success");
  }

  async warning(_tabId: number, details: readonly { code: string; message: string }[]): Promise<void> {
    this.calls.push("warning");
    this.details.push(details);
  }

  async error(_tabId: number, detail: { code: string; message: string }): Promise<void> {
    this.calls.push("error");
    this.details.push(detail);
  }
}

class FakeNativeClient {
  readonly calls: string[] = [];
  beginMarkdown: string | undefined;
  sessionId: string | undefined;
  helloError: Error | undefined;
  beginMediaError: Error | undefined;
  chunkError: Error | undefined;
  commitError: Error | undefined;

  async hello(): Promise<{ type: "hello_result"; requestId: string; protocolVersion: 1; hostName: string; hostVersion: string }> {
    this.calls.push("hello");
    if (this.helloError !== undefined) throw this.helloError;
    return { type: "hello_result", requestId: "hello", protocolVersion: 1, hostName: "Arthur native host", hostVersion: "0.1.0" };
  }

  async beginSave(input: { sessionId: string; markdown: string }): Promise<void> {
    this.calls.push("begin_save");
    this.beginMarkdown = input.markdown;
    this.sessionId = input.sessionId;
  }

  async beginMedia(): Promise<void> {
    this.calls.push("begin_media");
    if (this.beginMediaError !== undefined) throw this.beginMediaError;
  }

  async sendChunk(): Promise<{ type: "ack"; requestId: "chunk" }> {
    this.calls.push("media_chunk");
    if (this.chunkError !== undefined) throw this.chunkError;
    return { type: "ack", requestId: "chunk" };
  }

  async endMedia(_mediaId: string, chunks: number): Promise<{ type: "ack" | "warning"; requestId: string; sessionId: string; mediaId?: string; code?: string; message?: string }> {
    this.calls.push(chunks === Number.MAX_SAFE_INTEGER ? "end_media_fallback" : "end_media");
    if (chunks === Number.MAX_SAFE_INTEGER) {
      return {
        type: "warning",
        requestId: "end",
        sessionId: this.sessionId ?? SESSION_ID,
        code: "media_fallback",
        message: "Media transfer was incomplete; original link was retained.",
      };
    }
    return { type: "ack", requestId: "end", sessionId: this.sessionId ?? SESSION_ID, mediaId: MEDIA_ID };
  }

  async commitSave(): Promise<string> {
    this.calls.push("commit_save");
    this.sessionId = undefined;
    if (this.commitError !== undefined) throw this.commitError;
    return "/Vault/Clippings/Article.md";
  }

  async abortSave(): Promise<void> {
    this.calls.push("abort_save");
    this.sessionId = undefined;
  }
}

function directMedia(): ExtractedMedia {
  return {
    id: MEDIA_ID,
    url: "https://cdn.example.test/hero.webp",
    originalName: "hero.webp",
    kind: "image",
    placeholder: `arthur-media://${MEDIA_ID}`,
  };
}

function article(overrides: Partial<ExtractedArticle> = {}): ExtractedArticle {
  const media = overrides.media ?? [directMedia()];
  return {
    title: "Article",
    source: "https://example.test/article",
    markdown: overrides.markdown ?? `Before arthur-media://${MEDIA_ID} after`,
    media,
  };
}

function createCoordinator({
  native = new FakeNativeClient(),
  status = new RecordingStatus(),
  extracted = article(),
  loadSettings = async () => ({ destination: "/Vault/Clippings" }),
  fetcher = (async () => new Response(new Uint8Array([1]), { headers: { "content-type": "image/webp" } })) as typeof fetch,
  preflight,
  transfer,
}: {
  native?: FakeNativeClient;
  status?: RecordingStatus;
  extracted?: ExtractedArticle;
  loadSettings?: () => Promise<unknown>;
  fetcher?: typeof fetch;
  preflight?: (media: ExtractedMedia, fetcher: typeof fetch) => Promise<PreparedMedia>;
  transfer?: (prepared: PreparedMedia, client: NativeClient) => Promise<"saved" | "fallback">;
} = {}) {
  return {
    native,
    status,
    coordinator: new SaveCoordinator({
      loadSettings,
      extract: async () => extracted,
      fetcher,
      nativeClient: native as never,
      status,
      createSessionId: () => SESSION_ID,
      preflight,
      transfer,
    }),
  };
}

describe("SaveCoordinator", () => {
  it("reports an unconfigured destination without opening a native session", async () => {
    const { coordinator, native, status } = createCoordinator({ loadSettings: async () => undefined });

    await expect(coordinator.save(1, "https://example.test/article")).resolves.toMatchObject({
      status: "error",
      code: "destination_unconfigured",
    });
    expect(native.calls).toEqual([]);
    expect(status.calls).toEqual(["saving", "error"]);
  });

  it("reports negotiation and extraction failures before beginning a save", async () => {
    const native = new FakeNativeClient();
    native.helloError = new NativeHostError("protocol_version_mismatch", "Unsupported protocol.");
    const mismatch = createCoordinator({ native });
    await expect(mismatch.coordinator.save(1, "https://example.test/article")).resolves.toMatchObject({
      status: "error",
      code: "protocol_version_mismatch",
    });
    expect(native.calls).toEqual(["hello"]);

    const extraction = new SaveCoordinator({
      loadSettings: async () => ({ destination: "/Vault/Clippings" }),
      extract: async () => {
        throw new Error("readability failed");
      },
      fetcher: (async () => new Response()) as typeof fetch,
      nativeClient: new FakeNativeClient() as never,
      status: new RecordingStatus(),
      createSessionId: () => SESSION_ID,
    });
    await expect(extraction.save(1, "https://example.test/article")).resolves.toMatchObject({
      status: "error",
      code: "extraction_failed",
    });
  });

  it("streams each deduplicated direct resource then commits a full success", async () => {
    const media = directMedia();
    let fetches = 0;
    const { coordinator, native, status } = createCoordinator({
      extracted: article({ media: [media, { ...media }], markdown: `${media.placeholder} ${media.placeholder}` }),
      fetcher: (async () => {
        fetches += 1;
        return new Response(new Uint8Array([1]), { headers: { "content-type": "image/webp" } });
      }) as typeof fetch,
    });
    const result = await coordinator.save(1, "https://example.test/article");

    expect(status.calls).toEqual(["saving", "success"]);
    expect(result).toMatchObject({ articlePath: "/Vault/Clippings/Article.md", warnings: [] });
    expect(native.calls.filter((call) => call === "begin_media")).toHaveLength(1);
    expect(fetches).toBe(1);
  });

  it("rewrites fetch and HTTP preflight failures before begin_save", async () => {
    const fetched: string[] = [];
    const { coordinator, native, status } = createCoordinator({
      fetcher: (async (input) => {
        fetched.push(String(input));
        if (fetched.length === 1) throw new Error("offline");
        return new Response("gone", { status: 503, headers: { "content-type": "text/plain" } });
      }) as typeof fetch,
    });

    const first = await coordinator.save(1, "https://example.test/article");
    expect(first).toMatchObject({ status: "warning", warnings: [{ code: "media_fetch_failed" }] });
    expect(native.beginMarkdown).toBe("Before <https://cdn.example.test/hero.webp> after");
    expect(status.calls).toEqual(["saving", "warning"]);

    const second = await coordinator.save(1, "https://example.test/article");
    expect(second).toMatchObject({ status: "warning", warnings: [{ code: "media_http_failed" }] });
  });

  it("rewrites oversized known media before begin_save", async () => {
    const { coordinator, native } = createCoordinator({
      fetcher: (async () => new Response("", {
        headers: {
          "content-type": "image/webp",
          "content-length": String(MEDIA_LIMITS.image + 1),
        },
      })) as typeof fetch,
    });

    await expect(coordinator.save(1, "https://example.test/article")).resolves.toMatchObject({
      status: "warning",
      warnings: [{ code: "media_limit_exceeded" }],
    });
    expect(native.beginMarkdown).toBe("Before <https://cdn.example.test/hero.webp> after");
    expect(native.calls).not.toContain("begin_media");
  });

  it("preflights known aggregate sizes before registering placeholders with Vault", async () => {
    const first = directMedia();
    const second: ExtractedMedia = {
      ...directMedia(),
      id: "e0ddc6e9-9075-455f-9af0-2d2fd08dcc6d",
      url: "https://cdn.example.test/second.webp",
      placeholder: "arthur-media://e0ddc6e9-9075-455f-9af0-2d2fd08dcc6d",
    };
    let cancelled = false;
    const { coordinator, native } = createCoordinator({
      extracted: article({ media: [first, second], markdown: `${first.placeholder} ${second.placeholder}` }),
      preflight: async (item) => ({
        status: "eligible",
        media: item,
        response: item.id === first.id ? new Response(null) : new Response(new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          },
        })),
        contentType: "image/webp",
        declaredBytes: item.id === first.id ? MEDIA_LIMITS.total - 1 : 2,
      }),
    });

    await expect(coordinator.save(1, "https://example.test/article")).resolves.toMatchObject({
      status: "warning",
      warnings: [{ code: "media_limit_exceeded" }],
    });
    expect(native.beginMarkdown).toBe(`${first.placeholder} <https://cdn.example.test/second.webp>`);
    expect(native.calls.filter((call) => call === "begin_media")).toHaveLength(1);
    expect(cancelled).toBe(true);
  });

  it("streams declared-size media before unknown-length media can exhaust the total budget", async () => {
    const unknown = directMedia();
    const known: ExtractedMedia = {
      ...directMedia(),
      id: "e0ddc6e9-9075-455f-9af0-2d2fd08dcc6d",
      url: "https://cdn.example.test/known.webp",
      placeholder: "arthur-media://e0ddc6e9-9075-455f-9af0-2d2fd08dcc6d",
    };
    let unknownStarted = false;
    const transferOrder: string[] = [];
    const { coordinator, native, status } = createCoordinator({
      extracted: article({ media: [unknown, known], markdown: `${unknown.placeholder} ${known.placeholder}` }),
      preflight: async (item) => ({
        status: "eligible",
        media: item,
        response: new Response(null),
        contentType: "image/webp",
        declaredBytes: item.id === known.id ? 1 : undefined,
      }),
      transfer: async (prepared) => {
        transferOrder.push(prepared.media.id);
        if (prepared.media.id === unknown.id) {
          unknownStarted = true;
          return "fallback";
        }
        if (unknownStarted) throw new NativeLimitError("The save exceeds its configured total media limit.");
        return "saved";
      },
    });

    await expect(coordinator.save(1, "https://example.test/article")).resolves.toMatchObject({
      status: "warning",
      articlePath: "/Vault/Clippings/Article.md",
      warnings: [{ code: "media_fallback" }],
    });
    expect(transferOrder).toEqual([known.id, unknown.id]);
    expect(native.calls).toContain("commit_save");
    expect(native.calls).not.toContain("abort_save");
    expect(status.calls).toEqual(["saving", "warning"]);
  });

  it("commits a Vault-recorded fallback when streaming fails after begin_media", async () => {
    const native = new FakeNativeClient();
    native.chunkError = new NativeHostError("io_failed", "The staged attachment failed.");
    const { coordinator, status } = createCoordinator({ native });

    await expect(coordinator.save(1, "https://example.test/article")).resolves.toMatchObject({
      status: "warning",
      articlePath: "/Vault/Clippings/Article.md",
      warnings: [{ code: "media_fallback" }],
    });
    expect(native.calls).toContain("end_media_fallback");
    expect(native.calls).toContain("commit_save");
    expect(native.calls).not.toContain("abort_save");
    expect(status.calls).toEqual(["saving", "warning"]);
  });

  it("preserves already remote stream links without fetching them", async () => {
    const stream = "https://cdn.example.test/live.m3u8";
    const { coordinator, native } = createCoordinator({
      extracted: article({ markdown: `Listen <${stream}>`, media: [] }),
      fetcher: (async () => {
        throw new Error("a stream must not be fetched");
      }) as typeof fetch,
    });

    await expect(coordinator.save(1, "https://example.test/article")).resolves.toMatchObject({
      status: "success",
      warnings: [],
    });
    expect(native.beginMarkdown).toBe(`Listen <${stream}>`);
  });

  it("aborts fatal work after begin but never aborts a commit that already closed the host session", async () => {
    const mediaFailure = new FakeNativeClient();
    mediaFailure.beginMediaError = new NativeHostError("invalid_transition", "Media rejected.");
    const failedMedia = createCoordinator({ native: mediaFailure });
    await expect(failedMedia.coordinator.save(1, "https://example.test/article")).resolves.toMatchObject({
      status: "error",
      code: "invalid_transition",
    });
    expect(mediaFailure.calls).toContain("abort_save");

    const commitFailure = new FakeNativeClient();
    commitFailure.commitError = new NativeHostError("commit_failed", "Commit failed.");
    const failedCommit = createCoordinator({ native: commitFailure });
    await expect(failedCommit.coordinator.save(1, "https://example.test/article")).resolves.toMatchObject({
      status: "error",
      code: "commit_failed",
    });
    expect(commitFailure.calls).not.toContain("abort_save");
  });
});
