const MAX_STEM_BYTES = 180;
const FALLBACK_STEM = "attachment";

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  "audio/flac": "flac",
  "audio/m4a": "m4a",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "image/avif": "avif",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/ogg": "ogv",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

const RECOGNIZED_EXTENSIONS = new Set([
  "avif",
  "flac",
  "gif",
  "jpeg",
  "jpg",
  "m4a",
  "mov",
  "mp3",
  "mp4",
  "ogg",
  "ogv",
  "png",
  "svg",
  "wav",
  "webm",
  "webp",
]);

function truncateUtf8(value: string, maximumBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maximumBytes) {
      break;
    }
    result += character;
    bytes += characterBytes;
  }
  return result;
}

export function sanitizeFilenameStem(value: string): string {
  const cleaned = value
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, "")
    .replace(/^[.\s]+|[.\s]+$/gu, "");
  const truncated = truncateUtf8(cleaned, MAX_STEM_BYTES);

  return truncated === "" ? FALLBACK_STEM : truncated;
}

export function extensionForMedia(originalName: string, contentType: string): string {
  const withoutQuery = originalName.split(/[?#]/u, 1)[0] ?? "";
  const basename = withoutQuery.slice(withoutQuery.lastIndexOf("/") + 1);
  const separator = basename.lastIndexOf(".");
  const urlExtension = separator > 0 ? basename.slice(separator + 1).toLowerCase() : "";
  if (RECOGNIZED_EXTENSIONS.has(urlExtension)) {
    return urlExtension;
  }

  return MIME_EXTENSIONS[contentType.trim().toLowerCase()] ?? "bin";
}

export function contentAddressedFilename(
  stem: string,
  digestHex: string,
  extension: string,
): string {
  const digest = digestHex.toLowerCase();
  const normalizedExtension = extension.toLowerCase();
  if (!/^[a-f0-9]{12,}$/u.test(digest)) {
    throw new TypeError("Digest must be at least 12 hexadecimal characters");
  }
  if (!/^[a-z0-9]+$/u.test(normalizedExtension)) {
    throw new TypeError("Extension must contain only lowercase letters and digits");
  }

  return `${sanitizeFilenameStem(stem)}--${digest.slice(0, 12)}.${normalizedExtension}`;
}
