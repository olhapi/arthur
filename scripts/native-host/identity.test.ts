import { describe, expect, it } from "vitest";

import {
  CHROMIUM_EXTENSION_ID,
  CHROMIUM_PUBLIC_KEY_DER_BASE64,
  getChromiumExtensionId,
} from "./identity.mjs";

describe("Chromium native-host identity", () => {
  it("derives the committed extension ID from the committed 2048-bit public DER key", () => {
    expect(getChromiumExtensionId(CHROMIUM_PUBLIC_KEY_DER_BASE64)).toBe(CHROMIUM_EXTENSION_ID);
  });

  it("rejects malformed public keys", () => {
    expect(() => getChromiumExtensionId("not base64")).toThrow(/base64|DER|public key/i);
    expect(() => getChromiumExtensionId(Buffer.from("not a DER key").toString("base64"))).toThrow(/DER|public key/i);
  });
});
