import { z } from "zod";

import { MEDIA_LIMITS, NATIVE_CHUNK_BYTES, PROTOCOL_VERSION } from "./constants.js";
import { AbsoluteDestinationSchema } from "./settings.js";

const RequestIdSchema = z.string().trim().min(1).max(128);
const SessionIdSchema = z.uuid();
const MediaIdSchema = z.string().trim().min(1).max(128);
const MessageCodeSchema = z.string().trim().min(1).max(128);
const MessageTextSchema = z.string().trim().min(1).max(4_096);
const TitleSchema = z.string().trim().min(1).max(512);
const MarkdownSchema = z.string().max(20 * 1024 * 1024);
const PathSchema = AbsoluteDestinationSchema;
const MediaKindSchema = z.enum(["image", "audio", "video"]);
const ContentTypeSchema = z
  .string()
  .trim()
  .regex(/^[^/\s]+\/[^/\s]+$/, "Content type must be a MIME type")
  .max(255);
const Base64ChunkSchema = z
  .string()
  .min(1)
  .max(Math.ceil(NATIVE_CHUNK_BYTES / 3) * 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, {
    message: "Chunk data must be base64",
  })
  .refine((value) => {
    const paddingBytes = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
    const decodedBytes = (value.length / 4) * 3 - paddingBytes;
    return decodedBytes <= NATIVE_CHUNK_BYTES;
  }, "Chunk data exceeds the decoded byte limit");

const HttpSourceSchema = z.string().trim().max(2_048).transform((value, context) => {
  try {
    const source = new URL(value);
    if (source.protocol !== "http:" && source.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    return source.href;
  } catch {
    context.addIssue({
      code: "custom",
      message: "Source must be an HTTP(S) URL",
    });
    return z.NEVER;
  }
});

const BeginMediaSchema = z
  .object({
    type: z.literal("begin_media"),
    requestId: RequestIdSchema,
    sessionId: SessionIdSchema,
    mediaId: MediaIdSchema,
    source: HttpSourceSchema,
    kind: MediaKindSchema,
    contentType: ContentTypeSchema,
    byteLength: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((message, context) => {
    if (message.byteLength > MEDIA_LIMITS[message.kind]) {
      context.addIssue({
        code: "custom",
        message: "Media exceeds its configured size limit",
        path: ["byteLength"],
      });
    }
  });

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("hello"),
      requestId: RequestIdSchema,
      protocolVersion: z.literal(PROTOCOL_VERSION),
    })
    .strict(),
  z
    .object({
      type: z.literal("test_destination"),
      requestId: RequestIdSchema,
      destination: AbsoluteDestinationSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("begin_save"),
      requestId: RequestIdSchema,
      sessionId: SessionIdSchema,
      destination: AbsoluteDestinationSchema,
      source: HttpSourceSchema,
      title: TitleSchema,
      markdown: MarkdownSchema,
    })
    .strict(),
  BeginMediaSchema,
  z
    .object({
      type: z.literal("media_chunk"),
      sessionId: SessionIdSchema,
      mediaId: MediaIdSchema,
      sequence: z.number().int().nonnegative(),
      data: Base64ChunkSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("end_media"),
      requestId: RequestIdSchema,
      sessionId: SessionIdSchema,
      mediaId: MediaIdSchema,
      chunks: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal("commit_save"),
      requestId: RequestIdSchema,
      sessionId: SessionIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("abort_save"),
      requestId: RequestIdSchema,
      sessionId: SessionIdSchema,
      reason: MessageTextSchema.optional(),
    })
    .strict(),
]);

export const HostMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("hello_result"),
      requestId: RequestIdSchema,
      protocolVersion: z.literal(PROTOCOL_VERSION),
      hostName: z.string().trim().min(1).max(255),
      hostVersion: z.string().trim().min(1).max(128),
    })
    .strict(),
  z
    .object({
      type: z.literal("test_destination_result"),
      requestId: RequestIdSchema,
      destination: PathSchema,
      writable: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("save_result"),
      requestId: RequestIdSchema,
      sessionId: SessionIdSchema,
      savedPath: PathSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("ack"),
      requestId: RequestIdSchema,
      sessionId: SessionIdSchema.optional(),
      mediaId: MediaIdSchema.optional(),
      sequence: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("warning"),
      requestId: RequestIdSchema.optional(),
      sessionId: SessionIdSchema.optional(),
      code: MessageCodeSchema,
      message: MessageTextSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("error"),
      requestId: RequestIdSchema.optional(),
      sessionId: SessionIdSchema.optional(),
      code: MessageCodeSchema,
      message: MessageTextSchema,
    })
    .strict(),
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type HostMessage = z.infer<typeof HostMessageSchema>;
