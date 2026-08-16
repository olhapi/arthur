import { MEDIA_LIMITS, NATIVE_HOST_NAME, PROTOCOL_VERSION } from "../shared/constants.js";
import {
  ClientMessageSchema,
  HostMessageSchema,
  type ClientMessage,
  type HostMessage,
} from "../shared/protocol.js";

export type NativeMediaKind = "image" | "audio" | "video";

export interface NativePortAdapter {
  postMessage(message: unknown): void;
  onMessage: {
    addListener(listener: (message: unknown) => void): void;
  };
  onDisconnect: {
    addListener(listener: () => void): void;
  };
  disconnect(): void;
}

export interface NativeClientLimits {
  image: number;
  audio: number;
  video: number;
  total: number;
}

export interface NativeClientOptions {
  createRequestId?: () => string;
  limits?: NativeClientLimits;
}

export interface BeginSaveRequest {
  sessionId: string;
  destination: string;
  source: string;
  title: string;
  markdown: string;
}

export interface BeginMediaRequest {
  mediaId: string;
  source: string;
  kind: NativeMediaKind;
  contentType: string;
  declaredBytes: number | undefined;
}

type RequestMessage = Exclude<ClientMessage, { type: "media_chunk" }>;
type ChunkMessage = Extract<ClientMessage, { type: "media_chunk" }>;

interface ActiveMedia {
  kind: NativeMediaKind;
  bytes: number;
}

interface ActiveSession {
  id: string;
  bytes: number;
  media: Map<string, ActiveMedia>;
}

interface PendingOperation {
  resolve: (message: HostMessage) => void;
  reject: (error: Error) => void;
}

interface PendingRequest extends PendingOperation {
  request: RequestMessage;
}

interface PendingChunk extends PendingOperation {
  sessionId: string;
  mediaId: string;
  sequence: number;
}

const DEFAULT_LIMITS: NativeClientLimits = {
  image: MEDIA_LIMITS.image,
  audio: MEDIA_LIMITS.audio,
  video: MEDIA_LIMITS.video,
  total: MEDIA_LIMITS.total,
};

export class NativeClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NativeProtocolError extends NativeClientError {
  constructor(message = "The native host sent an invalid protocol message.") {
    super("invalid_native_message", message);
  }
}

export class NativeHostError extends NativeClientError {}

export class NativeDisconnectedError extends NativeClientError {
  constructor() {
    super("native_disconnected", "The native host disconnected before the operation completed.");
  }
}

export class NativeStateError extends NativeClientError {
  constructor(message: string) {
    super("invalid_native_state", message);
  }
}

export class NativeLimitError extends NativeClientError {
  constructor(message: string) {
    super("media_limit_exceeded", message);
  }
}

function isMediaKind(value: string): value is NativeMediaKind {
  return value === "image" || value === "audio" || value === "video";
}

function decodedBase64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

function expectAck(message: HostMessage, requestId: string, sessionId: string): void {
  if (message.type !== "ack" || message.requestId !== requestId || message.sessionId !== sessionId) {
    throw new NativeProtocolError("The native host returned an unexpected acknowledgement.");
  }
}

function requestSessionId(message: RequestMessage): string | undefined {
  return "sessionId" in message ? message.sessionId : undefined;
}

function responseMatchesRequest(response: HostMessage, request: RequestMessage): boolean {
  switch (request.type) {
    case "hello":
      return response.type === "hello_result";
    case "test_destination":
      return response.type === "test_destination_result";
    case "begin_save":
    case "begin_media":
    case "abort_save":
      return response.type === "ack" && response.sessionId === request.sessionId;
    case "end_media":
      return (
        ((response.type === "ack" && response.mediaId === request.mediaId) || response.type === "warning") &&
        response.sessionId === request.sessionId
      );
    case "commit_save":
      return response.type === "save_result" && response.sessionId === request.sessionId;
  }
}

function errorMatchesRequest(response: Extract<HostMessage, { type: "error" }>, request: RequestMessage): boolean {
  const sessionId = requestSessionId(request);
  return response.sessionId === undefined || response.sessionId === sessionId;
}

/**
 * Correlates validated native-messaging requests with host responses. It keeps
 * accounting private to one active save session so a service-worker lifetime
 * cannot leak transfer quotas across saves.
 */
export class NativeClient {
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private pendingChunk: PendingChunk | undefined;
  private session: ActiveSession | undefined;
  private beginning = false;
  private closed = false;
  private terminalError: Error | undefined;
  private readonly createRequestId: () => string;
  private readonly limits: NativeClientLimits;

  constructor(
    private readonly port: NativePortAdapter,
    options: NativeClientOptions = {},
  ) {
    this.createRequestId = options.createRequestId ?? (() => crypto.randomUUID());
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.port.onMessage.addListener((message) => this.handleMessage(message));
    this.port.onDisconnect.addListener(() => this.handleDisconnect());
  }

  get sessionId(): string | undefined {
    return this.session?.id;
  }

  request(message: RequestMessage): Promise<HostMessage> {
    const parsed = ClientMessageSchema.safeParse(message);
    if (!parsed.success) {
      return Promise.reject(new NativeProtocolError("The native request violates the shared protocol."));
    }
    const outgoing = parsed.data;
    if (outgoing.type === "media_chunk") {
      return Promise.reject(new NativeProtocolError("The native request violates the shared protocol."));
    }
    if (outgoing.requestId === "chunk") {
      return Promise.reject(new NativeStateError("The chunk acknowledgement request ID is reserved."));
    }
    if (this.closed) return Promise.reject(this.terminalError ?? new NativeDisconnectedError());
    if (this.pendingRequests.has(outgoing.requestId)) {
      return Promise.reject(new NativeStateError("A request with this request ID is already pending."));
    }

    return new Promise<HostMessage>((resolve, reject) => {
      this.pendingRequests.set(outgoing.requestId, { resolve, reject, request: outgoing });
      try {
        this.port.postMessage(outgoing);
      } catch {
        this.terminate(new NativeDisconnectedError());
      }
    });
  }

  sendChunk(message: ChunkMessage): Promise<HostMessage> {
    const parsed = ClientMessageSchema.safeParse(message);
    if (!parsed.success) {
      return Promise.reject(new NativeProtocolError("The media chunk violates the shared protocol."));
    }
    const chunk = parsed.data;
    if (chunk.type !== "media_chunk") {
      return Promise.reject(new NativeProtocolError("The media chunk violates the shared protocol."));
    }
    if (this.closed) return Promise.reject(this.terminalError ?? new NativeDisconnectedError());
    if (this.pendingChunk !== undefined) {
      return Promise.reject(new NativeStateError("Only one media chunk may be in flight."));
    }
    const session = this.requireSession();
    if (chunk.sessionId !== session.id) {
      return Promise.reject(new NativeStateError("The chunk does not belong to the active save session."));
    }
    const activeMedia = session.media.get(chunk.mediaId);
    if (activeMedia === undefined) {
      return Promise.reject(new NativeStateError("The chunk does not belong to open media."));
    }
    const byteLength = decodedBase64Bytes(chunk.data);
    if (activeMedia.bytes + byteLength > this.limits[activeMedia.kind]) {
      return Promise.reject(new NativeLimitError("The media exceeds its configured size limit."));
    }
    if (session.bytes + byteLength > this.limits.total) {
      return Promise.reject(new NativeLimitError("The save exceeds its configured total media limit."));
    }

    // Account before posting. If the host has accepted a chunk but its reply is
    // lost, later transfers still cannot use that uncertainty to exceed a save
    // budget. Abort/commit/begin reset this session-scoped accounting.
    activeMedia.bytes += byteLength;
    session.bytes += byteLength;

    const pending = new Promise<HostMessage>((resolve, reject) => {
      const pending: PendingChunk = {
        resolve,
        reject,
        sessionId: chunk.sessionId,
        mediaId: chunk.mediaId,
        sequence: chunk.sequence,
      };
      this.pendingChunk = pending;
      try {
        this.port.postMessage(chunk);
      } catch {
        this.terminate(new NativeDisconnectedError());
      }
    });
    return pending.then((response) => {
      this.throwIfTerminal();
      return response;
    });
  }

  async hello(): Promise<Extract<HostMessage, { type: "hello_result" }>> {
    const requestId = this.nextRequestId();
    const response = await this.request({ type: "hello", requestId, protocolVersion: PROTOCOL_VERSION });
    this.throwIfTerminal();
    if (response.type !== "hello_result" || response.requestId !== requestId) {
      throw new NativeProtocolError("The native host returned an unexpected hello response.");
    }
    return response;
  }

  async beginSave(input: BeginSaveRequest): Promise<void> {
    if (this.session !== undefined || this.beginning) {
      throw new NativeStateError("A save session is already active.");
    }
    this.resetSession();
    this.beginning = true;
    try {
      const requestId = this.nextRequestId();
      const response = await this.request({ type: "begin_save", requestId, ...input });
      this.throwIfTerminal();
      expectAck(response, requestId, input.sessionId);
      this.session = { id: input.sessionId, bytes: 0, media: new Map() };
    } finally {
      this.beginning = false;
    }
  }

  async beginMedia(input: BeginMediaRequest): Promise<void> {
    const session = this.requireSession();
    if (session.media.has(input.mediaId)) {
      throw new NativeStateError("This media item is already open.");
    }
    if (input.declaredBytes !== undefined && input.declaredBytes > this.limits[input.kind]) {
      throw new NativeLimitError("The media exceeds its configured size limit.");
    }
    if (input.declaredBytes !== undefined && session.bytes + input.declaredBytes > this.limits.total) {
      throw new NativeLimitError("The save exceeds its configured total media limit.");
    }
    const requestId = this.nextRequestId();
    const response = await this.request({
      type: "begin_media",
      requestId,
      sessionId: session.id,
      mediaId: input.mediaId,
      source: input.source,
      kind: input.kind,
      contentType: input.contentType,
      byteLength: input.declaredBytes ?? 0,
    });
    this.throwIfTerminal();
    expectAck(response, requestId, session.id);
    session.media.set(input.mediaId, { kind: input.kind, bytes: 0 });
  }

  async endMedia(mediaId: string, chunks: number): Promise<Extract<HostMessage, { type: "ack" | "warning" }>> {
    const session = this.requireSession();
    if (!session.media.has(mediaId)) {
      throw new NativeStateError("This media item is not open.");
    }
    const requestId = this.nextRequestId();
    const response = await this.request({
      type: "end_media",
      requestId,
      sessionId: session.id,
      mediaId,
      chunks,
    });
    this.throwIfTerminal();
    if (
      (response.type !== "ack" && response.type !== "warning") ||
      response.requestId !== requestId ||
      response.sessionId !== session.id ||
      (response.type === "ack" && response.mediaId !== mediaId)
    ) {
      throw new NativeProtocolError("The native host returned an unexpected media completion response.");
    }
    session.media.delete(mediaId);
    return response;
  }

  async commitSave(): Promise<string> {
    const session = this.requireSession();
    const requestId = this.nextRequestId();
    try {
      const response = await this.request({ type: "commit_save", requestId, sessionId: session.id });
      this.throwIfTerminal();
      if (response.type !== "save_result" || response.requestId !== requestId || response.sessionId !== session.id) {
        throw new NativeProtocolError("The native host returned an unexpected save result.");
      }
      return response.savedPath;
    } finally {
      this.resetSession();
    }
  }

  async abortSave(reason?: string): Promise<void> {
    const session = this.requireSession();
    const requestId = this.nextRequestId();
    try {
      const request: Extract<ClientMessage, { type: "abort_save" }> = {
        type: "abort_save",
        requestId,
        sessionId: session.id,
        ...(reason === undefined ? {} : { reason }),
      };
      const response = await this.request(request);
      this.throwIfTerminal();
      expectAck(response, requestId, session.id);
    } finally {
      this.resetSession();
    }
  }

  close(): void {
    this.terminate(new NativeDisconnectedError());
  }

  private nextRequestId(): string {
    const requestId = this.createRequestId();
    if (requestId.trim() === "") throw new NativeStateError("The request ID factory returned an empty ID.");
    if (requestId === "chunk") throw new NativeStateError("The chunk acknowledgement request ID is reserved.");
    return requestId;
  }

  private requireSession(): ActiveSession {
    this.throwIfTerminal();
    if (this.session === undefined) throw new NativeStateError("No save session is active.");
    return this.session;
  }

  private handleMessage(message: unknown): void {
    if (this.closed) return;
    const parsed = HostMessageSchema.safeParse(message);
    if (!parsed.success) {
      this.terminate(new NativeProtocolError());
      return;
    }
    const response = parsed.data;
    if (response.type === "ack" && response.requestId === "chunk") {
      const pending = this.pendingChunk;
      if (
        pending !== undefined &&
        response.sessionId === pending.sessionId &&
        response.mediaId === pending.mediaId &&
        response.sequence === pending.sequence
      ) {
        this.pendingChunk = undefined;
        pending.resolve(response);
      } else if (this.hasActiveSession()) {
        this.terminate(new NativeProtocolError("The native host returned an unexpected chunk acknowledgement."));
      }
      return;
    }
    if (response.type === "error") {
      const error = new NativeHostError(response.code, response.message);
      if (response.requestId !== undefined) {
        const pending = this.pendingRequests.get(response.requestId);
        if (pending !== undefined && errorMatchesRequest(response, pending.request)) {
          this.rejectRequest(response.requestId, error);
        } else if (this.hasActiveSession()) {
          this.terminate(new NativeProtocolError("The native host returned an uncorrelated error."));
        }
        return;
      }
      const pending = this.pendingChunk;
      if (pending !== undefined && response.sessionId === pending.sessionId) {
        this.pendingChunk = undefined;
        pending.reject(error);
      } else if (this.hasActiveSession()) {
        this.terminate(new NativeProtocolError("The native host returned an uncorrelated error."));
      }
      return;
    }
    if (response.requestId === undefined) {
      if (this.hasActiveSession()) {
        this.terminate(new NativeProtocolError("The native host returned an uncorrelated response."));
      }
      return;
    }
    const pending = this.pendingRequests.get(response.requestId);
    if (pending !== undefined && responseMatchesRequest(response, pending.request)) {
      this.resolveRequest(response.requestId, response);
    } else if (this.hasActiveSession()) {
      this.terminate(new NativeProtocolError("The native host returned an unexpected correlated response."));
    }
  }

  private handleDisconnect(): void {
    if (this.closed) return;
    const error = new NativeDisconnectedError();
    this.closed = true;
    this.terminalError = error;
    this.failAll(error);
  }

  private hasActiveSession(): boolean {
    return this.beginning || this.session !== undefined;
  }

  private terminate(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.terminalError = error;
    try {
      this.port.disconnect();
    } catch {
      // Closing is best effort, but all local operations and accounting must
      // still be failed and cleared if the adapter also throws here.
    } finally {
      this.failAll(error);
    }
  }

  private throwIfTerminal(): void {
    if (this.terminalError !== undefined) throw this.terminalError;
  }

  private resolveRequest(requestId: string, response: HostMessage): void {
    const pending = this.pendingRequests.get(requestId);
    if (pending === undefined) return;
    this.pendingRequests.delete(requestId);
    pending.resolve(response);
  }

  private rejectRequest(requestId: string, error: Error): void {
    const pending = this.pendingRequests.get(requestId);
    if (pending === undefined) return;
    this.pendingRequests.delete(requestId);
    pending.reject(error);
  }

  private failAll(error: Error): void {
    for (const pending of this.pendingRequests.values()) pending.reject(error);
    this.pendingRequests.clear();
    if (this.pendingChunk !== undefined) {
      this.pendingChunk.reject(error);
      this.pendingChunk = undefined;
    }
    this.resetSession();
  }

  private resetSession(): void {
    this.session = undefined;
    this.beginning = false;
  }
}

export type NativePortFactory = (hostName: string) => NativePortAdapter;

/** Connects production code through the same adapter seam that unit tests use. */
export function connectNativeClient(factory: NativePortFactory): NativeClient {
  return new NativeClient(factory(NATIVE_HOST_NAME));
}
