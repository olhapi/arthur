import type { ExtractedArticle, ExtractedMedia } from "../article/extract.js";
import { normalizeSource } from "../article/source.js";
import { MEDIA_LIMITS } from "../shared/constants.js";
import { ArthurSettingsSchema } from "../shared/settings.js";
import { NativeClient, NativeClientError, NativeDisconnectedError } from "./native-client.js";
import { preflightMedia, transferMedia, type PreparedMedia } from "./media-transfer.js";
import type { SaveStatus, StatusDetail } from "./status.js";

export interface SaveWarning extends StatusDetail {}

export type SaveOutcome =
  | {
      status: "success";
      articlePath: string;
      warnings: SaveWarning[];
    }
  | {
      status: "warning";
      articlePath: string;
      warnings: SaveWarning[];
    }
  | {
      status: "error";
      code: string;
      message: string;
      warnings: SaveWarning[];
    };

export interface SaveCoordinatorDependencies {
  loadSettings: () => Promise<unknown>;
  extract: (tabId: number, tabUrl: string) => Promise<ExtractedArticle>;
  fallbackSave?: (article: ExtractedArticle) => Promise<string>;
  fetcher: typeof fetch;
  nativeClient: NativeClient | (() => NativeClient);
  status: SaveStatus;
  createSessionId?: () => string;
  preflight?: (media: ExtractedMedia, fetcher: typeof fetch) => Promise<PreparedMedia>;
  transfer?: (prepared: PreparedMedia, client: NativeClient) => Promise<"saved" | "fallback">;
}

class CoordinatorError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CoordinatorError";
  }
}

const MAX_MEDIA_PER_SAVE = 4_096;

function uniqueMedia(media: readonly ExtractedMedia[]): ExtractedMedia[] {
  const seen = new Set<string>();
  return media.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function remoteLink(source: string): string {
  try {
    return `<${normalizeSource(source)}>`;
  } catch {
    return `<${source}>`;
  }
}

function rewritePreflightFallbacks(markdown: string, prepared: readonly PreparedMedia[]): string {
  let rewritten = markdown;
  for (const item of prepared) {
    if (item.status !== "fallback") continue;
    // Only placeholders registered by this extraction are touched. Literal
    // arthur-media text that has no matching ExtractedMedia remains verbatim.
    rewritten = rewritten.split(item.media.placeholder).join(remoteLink(item.media.url));
  }
  return rewritten;
}

function toWarning(item: Extract<PreparedMedia, { status: "fallback" }>): SaveWarning {
  return { code: item.code, message: item.message };
}

function discardPreparedResponse(prepared: Extract<PreparedMedia, { status: "eligible" }>): void {
  try {
    void prepared.response.body?.cancel().catch(() => undefined);
  } catch {
    // The coordinator has already selected the remote-link fallback. A body
    // cancellation failure must not discard the otherwise valid article save.
  }
}

function discardEligibleResponses(prepared: readonly PreparedMedia[]): void {
  for (const item of prepared) {
    if (item.status === "eligible") discardPreparedResponse(item);
  }
}

function eligibleTransferOrder(prepared: readonly PreparedMedia[]): Extract<PreparedMedia, { status: "eligible" }>[] {
  return prepared
    .filter((item): item is Extract<PreparedMedia, { status: "eligible" }> => item.status === "eligible")
    .sort((left, right) => {
      const leftKnown = left.declaredBytes !== undefined;
      const rightKnown = right.declaredBytes !== undefined;
      return leftKnown === rightKnown ? 0 : leftKnown ? -1 : 1;
    });
}

function toFailure(error: unknown): StatusDetail {
  if (error instanceof CoordinatorError) return { code: error.code, message: error.message };
  if (error instanceof NativeClientError) return { code: error.code, message: error.message };
  if (error instanceof Error) return { code: "save_failed", message: error.message || "The article could not be saved." };
  return { code: "save_failed", message: "The article could not be saved." };
}

export class SaveCoordinator {
  private readonly createSessionId: () => string;
  private readonly preflight: (media: ExtractedMedia, fetcher: typeof fetch) => Promise<PreparedMedia>;
  private readonly transfer: (prepared: PreparedMedia, client: NativeClient) => Promise<"saved" | "fallback">;
  private readonly createNativeClient: () => NativeClient;
  private nativeClient: NativeClient | undefined;

  constructor(private readonly dependencies: SaveCoordinatorDependencies) {
    this.createSessionId = dependencies.createSessionId ?? (() => crypto.randomUUID());
    this.preflight = dependencies.preflight ?? preflightMedia;
    this.transfer = dependencies.transfer ?? transferMedia;
    if (typeof dependencies.nativeClient === "function") {
      this.createNativeClient = dependencies.nativeClient;
    } else {
      const nativeClient = dependencies.nativeClient;
      this.nativeClient = nativeClient;
      this.createNativeClient = () => nativeClient;
    }
  }

  async save(tabId: number, tabUrl: string): Promise<SaveOutcome> {
    await this.dependencies.status.saving(tabId);
    let sessionActive = false;
    let client: NativeClient | undefined;
    let prepared: PreparedMedia[] = [];
    try {
      const settings = ArthurSettingsSchema.safeParse(await this.dependencies.loadSettings());
      if (!settings.success) {
        throw new CoordinatorError("destination_unconfigured", "Choose an absolute destination before saving.");
      }

      let article: ExtractedArticle;
      try {
        article = await this.dependencies.extract(tabId, tabUrl);
      } catch {
        throw new CoordinatorError("extraction_failed", "The current page could not be extracted as an article.");
      }

      try {
        client = this.getNativeClient();
        await client.hello();
      } catch (error) {
        if ((client !== undefined && !(error instanceof NativeDisconnectedError)) || this.dependencies.fallbackSave === undefined) throw error;
        const articlePath = await this.dependencies.fallbackSave(article);
        await this.dependencies.status.success(tabId);
        return { status: "success", articlePath, warnings: [] };
      }

      prepared = await this.preflightAll(uniqueMedia(article.media));
      const markdown = rewritePreflightFallbacks(article.markdown, prepared);
      const warnings: SaveWarning[] = prepared
        .filter((item): item is Extract<PreparedMedia, { status: "fallback" }> => item.status === "fallback")
        .map(toWarning);

      await client.beginSave({
        sessionId: this.createSessionId(),
        destination: settings.data.destination,
        source: article.source,
        title: article.title,
        markdown,
      });
      sessionActive = true;

      // Transfer the aggregate-preflighted known lengths first. An unknown
      // stream can then only exceed the remaining budget after begin_media,
      // which maps to the recoverable Vault fallback rather than a fatal
      // pre-begin error for a later known item.
      for (const item of eligibleTransferOrder(prepared)) {
        const result = await this.transfer(item, client);
        if (result === "fallback") {
          warnings.push({
            code: "media_fallback",
            message: "Media transfer was incomplete; the original link was retained.",
          });
        }
      }

      // Task 4 removes its session before it attempts the commit. Do not send
      // an abort after a commit failure, because that would be a second,
      // misleading session-not-found request rather than recovery work.
      sessionActive = false;
      const articlePath = await client.commitSave();
      if (warnings.length === 0) {
        await this.dependencies.status.success(tabId);
        return { status: "success", articlePath, warnings };
      }
      await this.dependencies.status.warning(tabId, warnings);
      return { status: "warning", articlePath, warnings };
    } catch (error) {
      // A failed begin, transfer, abort, or commit can leave later preflight
      // bodies untouched. Release all eligible bodies; cancel is harmless after
      // a completed transfer and prevents retained browser downloads otherwise.
      discardEligibleResponses(prepared);
      if (sessionActive) {
        try {
          await client?.abortSave("The save could not be completed.");
        } catch {
          // The original failure remains the actionable result. The host also
          // cleans staged state on disconnect, so an abort failure is not
          // allowed to mask it.
        }
      }
      const failure = toFailure(error);
      if (client?.isTerminal) this.nativeClient = undefined;
      await this.dependencies.status.error(tabId, failure);
      return { status: "error", ...failure, warnings: [] };
    }
  }

  private getNativeClient(): NativeClient {
    if (this.nativeClient === undefined || this.nativeClient.isTerminal) {
      this.nativeClient = this.createNativeClient();
    }
    return this.nativeClient;
  }

  private async preflightAll(media: readonly ExtractedMedia[]): Promise<PreparedMedia[]> {
    const prepared: PreparedMedia[] = [];
    let declaredTotal = 0;
    try {
      for (const item of media.slice(0, MAX_MEDIA_PER_SAVE)) {
        const next = await this.preflight(item, this.dependencies.fetcher);
        if (
          next.status === "eligible" &&
          next.declaredBytes !== undefined &&
          declaredTotal + next.declaredBytes > MEDIA_LIMITS.total
        ) {
          discardPreparedResponse(next);
          prepared.push({
            status: "fallback",
            media: next.media,
            code: "media_limit_exceeded",
            message: "The save exceeds its configured total media limit.",
          });
          continue;
        }
        if (next.status === "eligible" && next.declaredBytes !== undefined) declaredTotal += next.declaredBytes;
        prepared.push(next);
      }
      for (const item of media.slice(MAX_MEDIA_PER_SAVE)) {
        prepared.push({
          status: "fallback",
          media: item,
          code: "media_item_limit_exceeded",
          message: "The save supports at most 4096 media items.",
        });
      }
      return prepared;
    } catch (error) {
      discardEligibleResponses(prepared);
      throw error;
    }
  }
}
