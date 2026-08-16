import { describe, expect, it } from "vitest";

import {
  NativeClient,
  NativeDisconnectedError,
  NativeHostError,
  NativeProtocolError,
  type NativePortAdapter,
} from "./native-client.js";

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

class FakeNativePort implements NativePortAdapter {
  readonly posted: unknown[] = [];
  readonly onMessage = new Listeners<unknown>();
  readonly onDisconnect = new Listeners<void>();
  disconnected = false;
  disconnectCalls = 0;
  hostTransactionActive = false;
  destinationLocked = false;
  throwOnMessageType: string | undefined;

  postMessage(message: unknown): void {
    const type = (message as { type?: string }).type;
    if (type === this.throwOnMessageType) throw new Error(`Failed to post ${type}.`);
    this.posted.push(message);
    if (type === "begin_save") {
      this.hostTransactionActive = true;
      this.destinationLocked = true;
    }
  }

  disconnect(): void {
    this.disconnectCalls += 1;
    this.disconnected = true;
    // Native server EOF runs SessionManager::abort_all(), which drops the
    // VaultTransaction and releases its destination flock.
    this.hostTransactionActive = false;
    this.destinationLocked = false;
  }

  emitMessage(message: unknown): void {
    this.onMessage.emit(message);
  }

  emitDisconnect(): void {
    this.disconnected = true;
    this.hostTransactionActive = false;
    this.destinationLocked = false;
    this.onDisconnect.emit(undefined);
  }
}

function sequentialRequestIds(): () => string {
  let next = 0;
  return () => `request-${++next}`;
}

async function settlePromiseContinuations(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

async function beginSave(client: NativeClient, port: FakeNativePort): Promise<void> {
  const save = client.beginSave({
    sessionId: SESSION_ID,
    destination: "/Vault/Clippings",
    source: "https://example.test/article",
    title: "Article",
    markdown: `arthur-media://${MEDIA_ID}`,
  });
  port.emitMessage({ type: "ack", requestId: "request-1", sessionId: SESSION_ID });
  await save;
}

async function beginOpenMedia(client: NativeClient, port: FakeNativePort): Promise<void> {
  await beginSave(client, port);

  const media = client.beginMedia({
    mediaId: MEDIA_ID,
    source: "https://cdn.example.test/hero.webp",
    kind: "image",
    contentType: "image/webp",
    declaredBytes: 1,
  });
  port.emitMessage({ type: "ack", requestId: "request-2", sessionId: SESSION_ID });
  await media;
}

describe("NativeClient", () => {
  it("resolves normal operations only for their matching request IDs", async () => {
    const port = new FakeNativePort();
    const client = new NativeClient(port);
    const request = client.request({ type: "hello", requestId: "hello-1", protocolVersion: 1 });
    let settled = false;
    void request.then(() => {
      settled = true;
    });

    port.emitMessage({
      type: "hello_result",
      requestId: "another-request",
      protocolVersion: 1,
      hostName: "Arthur native host",
      hostVersion: "0.1.0",
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    port.emitMessage({
      type: "hello_result",
      requestId: "hello-1",
      protocolVersion: 1,
      hostName: "Arthur native host",
      hostVersion: "0.1.0",
    });

    await expect(request).resolves.toMatchObject({ type: "hello_result", requestId: "hello-1" });
  });

  it("resolves chunks only for the canonical acknowledgement tuple", async () => {
    const port = new FakeNativePort();
    const client = new NativeClient(port, { createRequestId: sequentialRequestIds() });
    await beginOpenMedia(client, port);

    const chunk = client.sendChunk({
      type: "media_chunk",
      sessionId: SESSION_ID,
      mediaId: MEDIA_ID,
      sequence: 0,
      data: "AQ==",
    });
    let settled = false;
    void chunk.then(() => {
      settled = true;
    });

    port.emitMessage({
      type: "ack",
      requestId: "chunk",
      sessionId: SESSION_ID,
      mediaId: MEDIA_ID,
      sequence: 0,
    });
    await expect(chunk).resolves.toMatchObject({ type: "ack", requestId: "chunk" });
  });

  it("rejects begin_save when disconnect follows its acknowledgement before the continuation", async () => {
    const port = new FakeNativePort();
    const client = new NativeClient(port, { createRequestId: sequentialRequestIds() });
    const beginning = client.beginSave({
      sessionId: SESSION_ID,
      destination: "/Vault/Clippings",
      source: "https://example.test/article",
      title: "Article",
      markdown: "Article",
    });

    port.emitMessage({ type: "ack", requestId: "request-1", sessionId: SESSION_ID });
    port.emitDisconnect();

    await expect(beginning).rejects.toBeInstanceOf(NativeDisconnectedError);
    expect(client.sessionId).toBeUndefined();
    expect(port.hostTransactionActive).toBe(false);
    expect(port.destinationLocked).toBe(false);
    await expect(
      client.beginSave({
        sessionId: SESSION_ID,
        destination: "/Vault/Clippings",
        source: "https://example.test/article",
        title: "Another article",
        markdown: "Another article",
      }),
    ).rejects.toBeInstanceOf(NativeDisconnectedError);
  });

  it("rejects commit when disconnect follows its save result before the continuation", async () => {
    const port = new FakeNativePort();
    const client = new NativeClient(port, { createRequestId: sequentialRequestIds() });
    await beginSave(client, port);
    const commit = client.commitSave();

    port.emitMessage({
      type: "save_result",
      requestId: "request-2",
      sessionId: SESSION_ID,
      savedPath: "/Vault/Clippings/Article.md",
    });
    port.emitDisconnect();

    await expect(commit).rejects.toBeInstanceOf(NativeDisconnectedError);
    expect(client.sessionId).toBeUndefined();
    expect(port.hostTransactionActive).toBe(false);
    expect(port.destinationLocked).toBe(false);
  });

  it("preserves the terminal cause before validating later public requests and chunks", async () => {
    const port = new FakeNativePort();
    const client = new NativeClient(port, { createRequestId: sequentialRequestIds() });
    port.emitDisconnect();
    const terminal = await client.hello().catch((error: unknown) => error);

    await expect(
      client.request({ type: "hello", requestId: "", protocolVersion: 1 } as never),
    ).rejects.toBe(terminal);
    await expect(
      client.sendChunk({ type: "media_chunk", sessionId: "", mediaId: "", sequence: 0, data: "" } as never),
    ).rejects.toBe(terminal);
    await expect(
      client.beginSave({
        sessionId: "invalid",
        destination: "relative",
        source: "not-a-url",
        title: "",
        markdown: "",
      }),
    ).rejects.toBe(terminal);
  });

  it("terminally closes an active host when commit posting throws and rejects concurrent pending work once", async () => {
    const port = new FakeNativePort();
    const client = new NativeClient(port, { createRequestId: sequentialRequestIds() });
    await beginSave(client, port);

    let concurrentRejections = 0;
    void client.request({ type: "hello", requestId: "parallel-hello", protocolVersion: 1 }).catch(() => {
      concurrentRejections += 1;
    });
    port.throwOnMessageType = "commit_save";
    let commitRejections = 0;
    const commit = client.commitSave().catch((error: unknown) => {
      commitRejections += 1;
      throw error;
    });

    await expect(commit).rejects.toBeInstanceOf(NativeDisconnectedError);
    await Promise.resolve();
    expect({ commitRejections, concurrentRejections }).toEqual({ commitRejections: 1, concurrentRejections: 1 });
    expect(port.disconnectCalls).toBe(1);
    expect(port.hostTransactionActive).toBe(false);
    expect(port.destinationLocked).toBe(false);
    expect(client.sessionId).toBeUndefined();

    port.emitDisconnect();
    port.emitMessage({ unexpected: true });
    await Promise.resolve();
    expect({ commitRejections, concurrentRejections }).toEqual({ commitRejections: 1, concurrentRejections: 1 });
    expect(port.disconnectCalls).toBe(1);
  });

  it.each([
    {
      failure: "malformed",
      response: { type: "save_result", requestId: "request-2", sessionId: SESSION_ID, savedPath: "/Vault/Article.md", extra: true },
    },
    {
      failure: "wrong session",
      response: {
        type: "ack",
        requestId: "request-2",
        sessionId: "e0ddc6e9-9075-455f-9af0-2d2fd08dcc6d",
      },
    },
    {
      failure: "wrong request",
      response: {
        type: "ack",
        requestId: "request-99",
        sessionId: SESSION_ID,
      },
    },
  ])("terminally closes an active host after a $failure commit response", async ({ response }) => {
    const port = new FakeNativePort();
    const client = new NativeClient(port, { createRequestId: sequentialRequestIds() });
    await beginSave(client, port);
    let rejections = 0;
    let rejection: unknown;
    void client.commitSave().catch((error: unknown) => {
      rejections += 1;
      rejection = error;
    });

    port.emitMessage(response);
    await settlePromiseContinuations();

    expect(rejections).toBe(1);
    expect(rejection).toBeInstanceOf(NativeProtocolError);
    expect(port.disconnectCalls).toBe(1);
    expect(port.hostTransactionActive).toBe(false);
    expect(port.destinationLocked).toBe(false);
    expect(client.sessionId).toBeUndefined();
  });

  it.each([
    { failure: "post failure", throwOnPost: true, sequence: 0 },
    { failure: "tuple mismatch", throwOnPost: false, sequence: 1 },
  ])("terminally closes an active host after a chunk $failure", async ({ throwOnPost, sequence }) => {
    const port = new FakeNativePort();
    const client = new NativeClient(port, { createRequestId: sequentialRequestIds() });
    await beginOpenMedia(client, port);
    if (throwOnPost) port.throwOnMessageType = "media_chunk";
    let rejections = 0;
    void client.sendChunk({
      type: "media_chunk",
      sessionId: SESSION_ID,
      mediaId: MEDIA_ID,
      sequence: 0,
      data: "AQ==",
    }).catch(() => {
      rejections += 1;
    });
    if (!throwOnPost) {
      port.emitMessage({ type: "ack", requestId: "chunk", sessionId: SESSION_ID, mediaId: MEDIA_ID, sequence });
    }
    await settlePromiseContinuations();

    expect(rejections).toBe(1);
    expect(port.disconnectCalls).toBe(1);
    expect(port.hostTransactionActive).toBe(false);
    expect(port.destinationLocked).toBe(false);
    expect(client.sessionId).toBeUndefined();
  });

  it.each([
    { errorSessionId: SESSION_ID, description: "matching session" },
    { errorSessionId: undefined, description: "omitted optional session" },
  ])("keeps an active session open for a correlated typed host error with $description", async ({ errorSessionId }) => {
    const port = new FakeNativePort();
    const client = new NativeClient(port, { createRequestId: sequentialRequestIds() });
    await beginSave(client, port);
    const media = client.beginMedia({
      mediaId: MEDIA_ID,
      source: "https://cdn.example.test/hero.webp",
      kind: "image",
      contentType: "image/webp",
      declaredBytes: 1,
    });
    port.emitMessage({
      type: "error",
      requestId: "request-2",
      ...(errorSessionId === undefined ? {} : { sessionId: errorSessionId }),
      code: "media_open_failed",
      message: "The media could not be opened.",
    });

    await expect(media).rejects.toBeInstanceOf(NativeHostError);
    expect(port.disconnected).toBe(false);
    expect(port.hostTransactionActive).toBe(true);
    expect(client.sessionId).toBe(SESSION_ID);

    const abort = client.abortSave("Recover after media error.");
    port.emitMessage({ type: "ack", requestId: "request-3", sessionId: SESSION_ID });
    await expect(abort).resolves.toBeUndefined();
    expect(port.disconnected).toBe(false);
    expect(client.sessionId).toBeUndefined();
  });

  it("rejects malformed outbound and inbound protocol messages", async () => {
    const port = new FakeNativePort();
    const client = new NativeClient(port);

    await expect(
      client.request({ type: "hello", requestId: "", protocolVersion: 1 } as never),
    ).rejects.toBeInstanceOf(NativeProtocolError);
    expect(port.posted).toEqual([]);

    const request = client.request({ type: "hello", requestId: "hello-1", protocolVersion: 1 });
    port.emitMessage({
      type: "hello_result",
      requestId: "hello-1",
      protocolVersion: 1,
      hostName: "Arthur native host",
      hostVersion: "0.1.0",
      unexpected: true,
    });
    await expect(request).rejects.toBeInstanceOf(NativeProtocolError);
    expect(port.disconnected).toBe(true);
  });

  it("reserves the chunk acknowledgement request ID from normal operations", async () => {
    const port = new FakeNativePort();
    const client = new NativeClient(port);

    await expect(client.request({ type: "hello", requestId: "chunk", protocolVersion: 1 })).rejects.toMatchObject({
      code: "invalid_native_state",
    });
    expect(port.posted).toEqual([]);
  });

  it("surfaces typed host errors and rejects all pending work on disconnect", async () => {
    const port = new FakeNativePort();
    const client = new NativeClient(port);
    const rejected = client.request({ type: "hello", requestId: "hello-1", protocolVersion: 1 });
    port.emitMessage({
      type: "error",
      requestId: "hello-1",
      code: "protocol_version_mismatch",
      message: "The native host protocol version is unsupported.",
    });
    await expect(rejected).rejects.toMatchObject({
      code: "protocol_version_mismatch",
      message: "The native host protocol version is unsupported.",
    } satisfies Partial<NativeHostError>);

    const disconnected = client.request({ type: "hello", requestId: "hello-2", protocolVersion: 1 });
    port.emitDisconnect();
    await expect(disconnected).rejects.toBeInstanceOf(NativeDisconnectedError);
  });

  it("surfaces a request-less chunk error to the sole in-flight chunk", async () => {
    const port = new FakeNativePort();
    const client = new NativeClient(port, { createRequestId: sequentialRequestIds() });
    await beginOpenMedia(client, port);

    const chunk = client.sendChunk({
      type: "media_chunk",
      sessionId: SESSION_ID,
      mediaId: MEDIA_ID,
      sequence: 0,
      data: "AQ==",
    });
    port.emitMessage({
      type: "error",
      sessionId: SESSION_ID,
      code: "invalid_chunk",
      message: "The media chunk is invalid.",
    });

    await expect(chunk).rejects.toMatchObject({ code: "invalid_chunk" } satisfies Partial<NativeHostError>);
  });

  it("reserves the sole save session before its begin acknowledgement arrives", async () => {
    const port = new FakeNativePort();
    let request = 0;
    const client = new NativeClient(port, { createRequestId: () => `request-${++request}` });
    const first = client.beginSave({
      sessionId: SESSION_ID,
      destination: "/Vault/Clippings",
      source: "https://example.test/article",
      title: "First",
      markdown: "First",
    });
    const second = client.beginSave({
      sessionId: "e0ddc6e9-9075-455f-9af0-2d2fd08dcc6d",
      destination: "/Vault/Clippings",
      source: "https://example.test/article",
      title: "Second",
      markdown: "Second",
    });
    const begins = port.posted.filter((message): message is { requestId: string; sessionId: string } =>
      (message as { type?: string }).type === "begin_save",
    );
    for (const begin of begins) {
      port.emitMessage({ type: "ack", requestId: begin.requestId, sessionId: begin.sessionId });
    }
    const [, secondResult] = await Promise.allSettled([first, second]);

    expect(begins).toHaveLength(1);
    expect(secondResult).toMatchObject({ status: "rejected", reason: { code: "invalid_native_state" } });
  });
});
