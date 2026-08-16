import { describe, expect, it } from "vitest";

import fixtures from "../../tests/contracts/native-messages.json" with { type: "json" };
import { ClientMessageSchema, HostMessageSchema } from "./protocol.js";

describe("native protocol contract fixtures", () => {
  it("keeps the canonical Zod client contract aligned", () => {
    for (const message of fixtures.validClientMessages) expect(ClientMessageSchema.safeParse(message).success).toBe(true);
    for (const message of fixtures.invalidClientMessages) expect(ClientMessageSchema.safeParse(message).success).toBe(false);
  });
  it("keeps the canonical Zod host contract aligned", () => {
    for (const message of fixtures.validHostMessages) expect(HostMessageSchema.safeParse(message).success).toBe(true);
    for (const message of fixtures.invalidHostMessages) expect(HostMessageSchema.safeParse(message).success).toBe(false);
  });
});
