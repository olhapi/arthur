import { describe, expect, it } from "vitest";

import { validateNativeBinary } from "./native-roundtrip.mjs";

describe("native-roundtrip", () => {
  it("rejects a non-native executable path", async () => {
    await expect(validateNativeBinary(process.execPath)).rejects.toThrow("not Arthur's direct Rust binary");
  });
});
