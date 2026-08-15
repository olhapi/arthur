import { describe, expect, it } from "vitest";

import { ArthurSettingsSchema } from "./settings.js";

describe("ArthurSettingsSchema", () => {
  it("rejects a destination that is not an absolute path", () => {
    expect(() =>
      ArthurSettingsSchema.parse({ destination: "relative/path" }),
    ).toThrow();
  });

  it("accepts an absolute destination without adding defaults", () => {
    expect(ArthurSettingsSchema.parse({ destination: "/Vault/Clippings" })).toEqual({
      destination: "/Vault/Clippings",
    });
  });

  it("rejects unrecognized settings fields", () => {
    expect(() =>
      ArthurSettingsSchema.parse({
        destination: "/Vault/Clippings",
        unexpected: true,
      }),
    ).toThrow();
  });
});
