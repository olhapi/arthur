export const NATIVE_HOST_NAME = "com.olhapi.arthur";
export const PROTOCOL_VERSION = 1;
export const NATIVE_CHUNK_BYTES = 256 * 1024;
export const MEDIA_LIMITS = {
  image: 100 * 1024 * 1024,
  audio: 2 * 1024 * 1024 * 1024,
  video: 2 * 1024 * 1024 * 1024,
  total: 4 * 1024 * 1024 * 1024,
} as const;
