import { describe, expect, it } from "vitest";

import { MEDIA_LIMITS, NATIVE_CHUNK_BYTES } from "../shared/constants.js";
import { NativeClient, NativeDisconnectedError, type NativePortAdapter } from "./native-client.js";
import { preflightMedia, transferMedia, type PreparedMedia } from "./media-transfer.js";

const SESSION_ID = "a5a74c85-92de-4a5d-9768-4e66c4d64987";
const MEDIA_ID = "7f9b5e81-4e80-4b7b-9ac5-c5d54f88b832";

class Listeners<T> {
  private readonly listeners: Array<(value: T) => void> = [];

  addListener(listener: (value: T) => void): void {
    this.listeners.push(listener);
  }

  emit(value: T): void {
    for (const listener of this.listeners) listener(value);
  }
}

type PostedMessage = Record<string, unknown>;

class TransferPort implements NativePortAdapter {
  readonly posted: PostedMessage[] = [];
  readonly onMessage = new Listeners<unknown>();
  readonly onDisconnect = new Listeners<void>();
  acknowledgeChunks = true;
  disconnectAfterChunkAck = false;
  fallbackOnEnd = false;
  disconnectCalls = 0;
  throwOnMessageType: string | undefined;

  postMessage(message: unknown): void {
    const posted = message as PostedMessage;
    if (posted.type === this.throwOnMessageType) throw new Error(`Failed to post ${String(posted.type)}.`);
    this.posted.push(posted);
    if (posted.type === "media_chunk" && this.acknowledgeChunks) {
      queueMicrotask(() => {
        this.onMessage.emit({
          type: "ack",
          requestId: "chunk",
          sessionId: posted.sessionId,
          mediaId: posted.mediaId,
          sequence: posted.sequence,
        });
        if (this.disconnectAfterChunkAck) this.onDisconnect.emit(undefined);
      });
    }
    if (posted.type === "begin_save" || posted.type === "begin_media") {
      queueMicrotask(() => {
        this.onMessage.emit({ type: "ack", requestId: posted.requestId, sessionId: posted.sessionId });
      });
    }
    if (posted.type === "end_media") {
      queueMicrotask(() => {
        if (this.fallbackOnEnd && posted.chunks === Number.MAX_SAFE_INTEGER) {
          this.onMessage.emit({
            type: "warning",
            requestId: posted.requestId,
            sessionId: posted.sessionId,
            code: "media_fallback",
            message: "Media transfer was incomplete; original link was retained.",
          });
          return;
        }
        this.onMessage.emit({
          type: "ack",
          requestId: posted.requestId,
          sessionId: posted.sessionId,
          mediaId: posted.mediaId,
        });
      });
    }
    if (posted.type === "commit_save") {
      queueMicrotask(() => {
        this.onMessage.emit({
          type: "save_result",
          requestId: posted.requestId,
          sessionId: posted.sessionId,
          savedPath: "/Vault/Clippings/Article.md",
        });
      });
    }
    if (posted.type === "abort_save") {
      queueMicrotask(() => {
        this.onMessage.emit({ type: "ack", requestId: posted.requestId, sessionId: posted.sessionId });
      });
    }
  }

  disconnect(): void {
    this.disconnectCalls += 1;
  }
}

function media(id = MEDIA_ID) {
  return {
    id,
    url: "https://cdn.example.test/hero.webp",
    originalName: "hero.webp",
    kind: "image" as const,
    placeholder: `arthur-media://${id}`,
  };
}

function prepared(response: Response, id = MEDIA_ID): PreparedMedia {
  return {
    status: "eligible",
    media: media(id),
    response,
    contentType: "image/webp",
    declaredBytes: undefined,
  };
}

async function activeClient(port: TransferPort, options?: ConstructorParameters<typeof NativeClient>[1]): Promise<NativeClient> {
  let request = 0;
  const client = new NativeClient(port, {
    createRequestId: () => `request-${++request}`,
    ...options,
  });
  await client.beginSave({
    sessionId: SESSION_ID,
    destination: "/Vault/Clippings",
    source: "https://example.test/article",
    title: "Article",
    markdown: `arthur-media://${MEDIA_ID}`,
  });
  return client;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe("preflightMedia", () => {
  it("rejects a known individual limit before a save begins", async () => {
    const result = await preflightMedia(
      media(),
      (async () => new Response("", {
        headers: {
          "content-type": "image/webp",
          "content-length": String(MEDIA_LIMITS.image + 1),
        },
      })) as typeof fetch,
    );

    expect(result).toMatchObject({ status: "fallback", code: "media_limit_exceeded" });
  });

  it("preserves a remote link when a direct URL redirects to an HLS manifest", async () => {
    const response = new Response(new Uint8Array([1]), { headers: { "content-type": "application/octet-stream" } });
    Object.defineProperty(response, "url", {
      configurable: true,
      value: "https://cdn.example.test/live/master.m3u8",
    });

    await expect(preflightMedia(media(), (async () => response) as typeof fetch)).resolves.toMatchObject({
      status: "fallback",
      code: "streaming_media",
    });
  });

  it("cancels a rejected response body instead of retaining a download", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    }), {
      headers: {
        "content-type": "image/webp",
        "content-length": String(MEDIA_LIMITS.image + 1),
      },
    });

    await expect(preflightMedia(media(), (async () => response) as typeof fetch)).resolves.toMatchObject({
      status: "fallback",
      code: "media_limit_exceeded",
    });
    expect(cancelled).toBe(true);
  });
});

describe("transferMedia", () => {
  it("uses one in-flight 256 KiB chunk at a time with ordered sequences", async () => {
    const port = new TransferPort();
    port.acknowledgeChunks = false;
    const client = await activeClient(port);
    const bytes = new Uint8Array(NATIVE_CHUNK_BYTES + 1).fill(7);
    const saving = transferMedia(prepared(new Response(bytes)), client);

    await settle();
    const firstChunks = port.posted.filter((message) => message.type === "media_chunk");
    expect(firstChunks).toHaveLength(1);
    expect(firstChunks[0]).toMatchObject({ sequence: 0 });

    port.onMessage.emit({
      type: "ack",
      requestId: "chunk",
      sessionId: SESSION_ID,
      mediaId: MEDIA_ID,
      sequence: 0,
    });
    await settle();
    const chunks = port.posted.filter((message) => message.type === "media_chunk");
    expect(chunks).toHaveLength(2);
    expect(chunks.map((message) => message.sequence)).toEqual([0, 1]);
    expect(chunks.map((message) => Buffer.from(message.data as string, "base64").byteLength)).toEqual([
      NATIVE_CHUNK_BYTES,
      1,
    ]);

    port.onMessage.emit({
      type: "ack",
      requestId: "chunk",
      sessionId: SESSION_ID,
      mediaId: MEDIA_ID,
      sequence: 1,
    });
    await expect(saving).resolves.toBe("saved");
  });

  it("completes an empty file without emitting an invalid empty chunk", async () => {
    const port = new TransferPort();
    const client = await activeClient(port);

    await expect(transferMedia(prepared(new Response(null)), client)).resolves.toBe("saved");

    expect(port.posted.filter((message) => message.type === "media_chunk")).toEqual([]);
    expect(port.posted.find((message) => message.type === "end_media")).toMatchObject({ chunks: 0 });
  });

  it("signals a recoverable Vault fallback after a stream failure", async () => {
    const port = new TransferPort();
    port.fallbackOnEnd = true;
    const client = await activeClient(port);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.error(new Error("network interrupted"));
      },
    });

    await expect(transferMedia(prepared(new Response(body)), client)).resolves.toBe("fallback");

    expect(port.posted.find((message) => message.type === "end_media")).toMatchObject({
      chunks: Number.MAX_SAFE_INTEGER,
    });
  });

  it("preserves a terminal native error instead of attempting fallback on the closed session", async () => {
    const port = new TransferPort();
    const client = await activeClient(port);
    port.throwOnMessageType = "media_chunk";

    await expect(transferMedia(prepared(new Response(new Uint8Array([1]))), client)).rejects.toBeInstanceOf(
      NativeDisconnectedError,
    );

    expect(port.disconnectCalls).toBe(1);
    expect(port.posted.some((message) => message.type === "end_media")).toBe(false);
    expect(client.sessionId).toBeUndefined();
  });

  it("preserves disconnect when it follows a valid chunk acknowledgement before transfer continues", async () => {
    const port = new TransferPort();
    port.disconnectAfterChunkAck = true;
    const client = await activeClient(port);

    await expect(transferMedia(prepared(new Response(new Uint8Array([1]))), client)).rejects.toBeInstanceOf(
      NativeDisconnectedError,
    );

    expect(port.posted.some((message) => message.type === "end_media")).toBe(false);
    expect(client.sessionId).toBeUndefined();
  });

  it("interrupts a pending reader promptly when the native client disconnects", async () => {
    const port = new TransferPort();
    const client = await activeClient(port);
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
        return new Promise<void>(() => undefined);
      },
    });
    let failure: unknown;
    let settled = false;
    void transferMedia(prepared(new Response(body)), client).catch((error: unknown) => {
      failure = error;
      settled = true;
    });
    await settle();

    port.onDisconnect.emit(undefined);
    await settle();

    expect(settled).toBe(true);
    expect(failure).toBeInstanceOf(NativeDisconnectedError);
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
    expect(port.posted.some((message) => message.type === "media_chunk" || message.type === "end_media")).toBe(false);
  });

  it("preserves disconnect when a pending reader yields after the client closes", async () => {
    const port = new TransferPort();
    const client = await activeClient(port);
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(nextController) {
        controller = nextController;
      },
      cancel() {
        cancelled = true;
      },
    });
    const saving = transferMedia(prepared(new Response(body)), client);
    await settle();

    port.onDisconnect.emit(undefined);
    controller?.enqueue(new Uint8Array(NATIVE_CHUNK_BYTES));

    await expect(saving).rejects.toBeInstanceOf(NativeDisconnectedError);
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
    expect(port.posted.some((message) => message.type === "media_chunk" || message.type === "end_media")).toBe(false);
  });

  it("enforces an unknown-length individual budget incrementally", async () => {
    const port = new TransferPort();
    port.fallbackOnEnd = true;
    const client = await activeClient(port, {
      limits: { image: NATIVE_CHUNK_BYTES + 3, audio: NATIVE_CHUNK_BYTES + 10, video: NATIVE_CHUNK_BYTES + 10, total: NATIVE_CHUNK_BYTES + 10 },
    });
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(NATIVE_CHUNK_BYTES));
        controller.enqueue(new Uint8Array(NATIVE_CHUNK_BYTES));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(transferMedia(prepared(new Response(body)), client)).resolves.toBe("fallback");

    expect(port.posted.filter((message) => message.type === "media_chunk")).toHaveLength(1);
    expect(port.posted.find((message) => message.type === "end_media")).toMatchObject({
      chunks: Number.MAX_SAFE_INTEGER,
    });
    expect(cancelled).toBe(true);
  });

  it("enforces the total budget across unknown-length media in one session", async () => {
    const port = new TransferPort();
    port.fallbackOnEnd = true;
    const client = await activeClient(port, {
      limits: {
        image: NATIVE_CHUNK_BYTES + 10,
        audio: NATIVE_CHUNK_BYTES + 10,
        video: NATIVE_CHUNK_BYTES + 10,
        total: NATIVE_CHUNK_BYTES + 3,
      },
    });

    await expect(transferMedia(prepared(new Response(new Uint8Array(NATIVE_CHUNK_BYTES))), client)).resolves.toBe("saved");
    await expect(transferMedia(prepared(new Response(new Uint8Array([1, 2, 3, 4])), "e0ddc6e9-9075-455f-9af0-2d2fd08dcc6d"), client)).resolves.toBe("fallback");

    expect(port.posted.filter((message) => message.type === "media_chunk")).toHaveLength(1);
    expect(port.posted.filter((message) => message.type === "end_media").at(-1)).toMatchObject({
      chunks: Number.MAX_SAFE_INTEGER,
    });
  });

  it("resets session-scoped accounting after a commit", async () => {
    const port = new TransferPort();
    const client = await activeClient(port, { limits: { image: 3, audio: 3, video: 3, total: 3 } });

    await expect(transferMedia(prepared(new Response(new Uint8Array([1, 2]))), client)).resolves.toBe("saved");
    await expect(client.commitSave()).resolves.toBe("/Vault/Clippings/Article.md");
    await client.beginSave({
      sessionId: SESSION_ID,
      destination: "/Vault/Clippings",
      source: "https://example.test/article",
      title: "Article",
      markdown: `arthur-media://${MEDIA_ID}`,
    });
    await expect(transferMedia(prepared(new Response(new Uint8Array([1, 2]))), client)).resolves.toBe("saved");
  });

  it("resets session-scoped accounting after an abort", async () => {
    const port = new TransferPort();
    const client = await activeClient(port, { limits: { image: 3, audio: 3, video: 3, total: 3 } });

    await expect(transferMedia(prepared(new Response(new Uint8Array([1, 2]))), client)).resolves.toBe("saved");
    await expect(client.abortSave("cancelled")).resolves.toBeUndefined();
    await client.beginSave({
      sessionId: SESSION_ID,
      destination: "/Vault/Clippings",
      source: "https://example.test/article",
      title: "Article",
      markdown: `arthur-media://${MEDIA_ID}`,
    });
    await expect(transferMedia(prepared(new Response(new Uint8Array([1, 2]))), client)).resolves.toBe("saved");
  });
});
