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

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  emitMessage(message: unknown): void {
    this.onMessage.emit(message);
  }

  emitDisconnect(): void {
    this.onDisconnect.emit(undefined);
  }
}

async function beginOpenMedia(client: NativeClient, port: FakeNativePort): Promise<void> {
  const save = client.beginSave({
    sessionId: SESSION_ID,
    destination: "/Vault/Clippings",
    source: "https://example.test/article",
    title: "Article",
    markdown: `arthur-media://${MEDIA_ID}`,
  });
  port.emitMessage({ type: "ack", requestId: "request-1", sessionId: SESSION_ID });
  await save;

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
    const client = new NativeClient(port, { createRequestId: (() => {
      let next = 0;
      return () => `request-${++next}`;
    })() });
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
      sequence: 1,
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    port.emitMessage({
      type: "ack",
      requestId: "chunk",
      sessionId: SESSION_ID,
      mediaId: MEDIA_ID,
      sequence: 0,
    });
    await expect(chunk).resolves.toMatchObject({ type: "ack", requestId: "chunk" });
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
    const client = new NativeClient(port, { createRequestId: (() => {
      let next = 0;
      return () => `request-${++next}`;
    })() });
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
