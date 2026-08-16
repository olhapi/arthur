const MAX_NATIVE_MESSAGE_BYTES = 1024 * 1024;

function frameLength(payload: Buffer): Buffer {
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32LE(payload.length);
  return prefix;
}

function parseJson(payload: Buffer): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch {
    throw new TypeError("Native message payload is not valid UTF-8");
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new TypeError("Native message payload is not valid JSON");
  }
}

export function encodeNativeMessage(value: unknown): Buffer {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new TypeError("Native message must be JSON serializable");
  }

  const payload = Buffer.from(json, "utf8");
  if (payload.length === 0 || payload.length > MAX_NATIVE_MESSAGE_BYTES) {
    throw new RangeError("Native message must be between 1 byte and 1 MiB");
  }

  return Buffer.concat([frameLength(payload), payload]);
}

export class NativeMessageDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const messages: unknown[] = [];

    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32LE(0);
      if (length === 0) {
        throw new RangeError("Native message frame cannot have zero length");
      }
      if (length > MAX_NATIVE_MESSAGE_BYTES) {
        throw new RangeError("Native message frame exceeds 1 MiB");
      }
      if (this.#buffer.length < length + 4) {
        break;
      }

      const payload = this.#buffer.subarray(4, length + 4);
      this.#buffer = this.#buffer.subarray(length + 4);
      messages.push(parseJson(payload));
    }

    return messages;
  }
}
