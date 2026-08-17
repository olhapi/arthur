import type { ExtractedMedia } from "../article/extract.js";
import { MEDIA_LIMITS, NATIVE_CHUNK_BYTES } from "../shared/constants.js";
import { NativeClient, NativeDisconnectedError, type NativeMediaKind } from "./native-client.js";

export type PreparedMedia =
  | {
      status: "eligible";
      media: ExtractedMedia;
      response: Response;
      contentType: string;
      declaredBytes: number | undefined;
    }
  | {
      status: "fallback";
      media: ExtractedMedia;
      code: string;
      message: string;
    };

const STREAM_CONTENT_TYPES = new Set([
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "audio/mpegurl",
  "audio/x-mpegurl",
  "application/dash+xml",
]);
const FALLBACK_CHUNK_COUNT = Number.MAX_SAFE_INTEGER;
const MIME_TYPE = /^[^/\s]+\/[^/\s]+$/;

function isMediaKind(kind: string): kind is NativeMediaKind {
  return kind === "image" || kind === "audio" || kind === "video";
}

function fallback(media: ExtractedMedia, code: string, message: string): PreparedMedia {
  return { status: "fallback", media, code, message };
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : undefined;
}

function normalizeContentType(value: string | null): string | undefined {
  if (value === null) return "application/octet-stream";
  const contentType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return MIME_TYPE.test(contentType) ? contentType : undefined;
}

function isStreamingUrl(value: string): boolean {
  try {
    const extension = new URL(value).pathname.split(".").at(-1)?.toLowerCase();
    return extension === "m3u8" || extension === "mpd";
  } catch {
    return false;
  }
}

async function discardResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A rejected response is already a remote fallback. Cancellation is only
    // resource cleanup and must not turn that recoverable outcome fatal.
  }
}

async function discardedFallback(response: Response, media: ExtractedMedia, code: string, message: string): Promise<PreparedMedia> {
  await discardResponse(response);
  return fallback(media, code, message);
}

/**
 * Fetches only response headers and leaves an eligible body unread for the
 * session that will stream it to the native host.
 */
export async function preflightMedia(media: ExtractedMedia, fetcher: typeof fetch): Promise<PreparedMedia> {
  if (!isMediaKind(media.kind)) {
    return fallback(media, "unsupported_media", "The media type cannot be transferred.");
  }

  let response: Response;
  try {
    response = await fetcher(media.url);
  } catch {
    return fallback(media, "media_fetch_failed", "The media could not be fetched.");
  }
  if (!response.ok) {
    return discardedFallback(response, media, "media_http_failed", `The media server returned HTTP ${response.status}.`);
  }
  if (isStreamingUrl(response.url || media.url)) {
    return discardedFallback(response, media, "streaming_media", "The media is a stream and was retained as a remote link.");
  }

  const contentType = normalizeContentType(response.headers.get("content-type"));
  if (contentType === undefined) {
    return discardedFallback(response, media, "invalid_content_type", "The media server returned an invalid content type.");
  }
  if (STREAM_CONTENT_TYPES.has(contentType)) {
    return discardedFallback(response, media, "streaming_media", "The media is a stream and was retained as a remote link.");
  }

  const declaredBytes = parseContentLength(response.headers.get("content-length"));
  if (declaredBytes !== undefined && declaredBytes > MEDIA_LIMITS[media.kind]) {
    return discardedFallback(response, media, "media_limit_exceeded", "The media exceeds its configured size limit.");
  }
  return { status: "eligible", media, response, contentType, declaredBytes };
}

function toBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    result += alphabet[first >> 2];
    result += alphabet[((first & 0x03) << 4) | ((second ?? 0) >> 4)];
    result += second === undefined ? "=" : alphabet[((second & 0x0f) << 2) | ((third ?? 0) >> 6)];
    result += third === undefined ? "=" : alphabet[third & 0x3f];
  }
  return result;
}

function terminalReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new NativeDisconnectedError();
}

function throwIfTerminal(signal: AbortSignal): void {
  if (signal.aborted) throw terminalReason(signal);
}

function raceWithTerminal<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(terminalReason(signal));

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      complete();
    };
    const onAbort = (): void => finish(() => reject(terminalReason(signal)));
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      void operation().then(
        (result) => finish(() => {
          if (signal.aborted) reject(terminalReason(signal));
          else resolve(result);
        }),
        (error: unknown) => finish(() => reject(error)),
      );
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

function cancelWithTerminal(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<void> {
  let cancellation: Promise<void>;
  try {
    cancellation = reader.cancel();
  } catch (error) {
    return Promise.reject(error);
  }

  if (signal.aborted) {
    void cancellation.catch(() => undefined);
    return Promise.reject(terminalReason(signal));
  }
  return raceWithTerminal(() => cancellation, signal);
}

async function streamChunks(response: Response, client: NativeClient, mediaId: string): Promise<number> {
  const body = response.body;
  if (body === null) return 0;
  const reader = body.getReader();
  let pending = new Uint8Array(0);
  let sequence = 0;

  try {
    while (true) {
      const { done, value } = await raceWithTerminal(() => reader.read(), client.terminalSignal);
      throwIfTerminal(client.terminalSignal);
      if (done) break;
      if (value === undefined || value.byteLength === 0) continue;
      let offset = 0;
      while (offset < value.byteLength) {
        const length = Math.min(NATIVE_CHUNK_BYTES - pending.byteLength, value.byteLength - offset);
        const next = new Uint8Array(pending.byteLength + length);
        next.set(pending);
        next.set(value.subarray(offset, offset + length), pending.byteLength);
        pending = next;
        offset += length;
        if (pending.byteLength === NATIVE_CHUNK_BYTES) {
          await client.sendChunk({
            type: "media_chunk",
            sessionId: client.sessionId ?? "",
            mediaId,
            sequence,
            data: toBase64(pending),
          });
          sequence += 1;
          pending = new Uint8Array(0);
        }
      }
    }
    if (pending.byteLength > 0) {
      await client.sendChunk({
        type: "media_chunk",
        sessionId: client.sessionId ?? "",
        mediaId,
        sequence,
        data: toBase64(pending),
      });
      sequence += 1;
    }
    return sequence;
  } catch (error) {
    try {
      await cancelWithTerminal(reader, client.terminalSignal);
    } catch {
      // The original transfer error remains authoritative if cancellation
      // races a network failure or an already-closed response stream.
    }
    throwIfTerminal(client.terminalSignal);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Streams one prepared response with bounded chunks. Once begin_media has
 * succeeded, any local or remote streaming failure is completed with an
 * impossible chunk count so the native Vault records its remote fallback and
 * keeps the article transaction committable.
 */
export async function transferMedia(prepared: PreparedMedia, client: NativeClient): Promise<"saved" | "fallback"> {
  if (prepared.status === "fallback") return "fallback";

  let begun = false;
  try {
    if (!isMediaKind(prepared.media.kind)) {
      throw new TypeError("The media type cannot be transferred.");
    }
    await client.beginMedia({
      mediaId: prepared.media.id,
      source: prepared.media.url,
      kind: prepared.media.kind,
      contentType: prepared.contentType,
      declaredBytes: prepared.declaredBytes,
    });
    begun = true;
    const chunks = await streamChunks(prepared.response, client, prepared.media.id);
    const completion = await client.endMedia(prepared.media.id, chunks);
    return completion.type === "warning" ? "fallback" : "saved";
  } catch (error) {
    if (!begun) throw error;
    if (client.sessionId === undefined) throw error;
    const completion = await client.endMedia(prepared.media.id, FALLBACK_CHUNK_COUNT);
    if (completion.type === "warning") return "fallback";
    throw error;
  }
}
