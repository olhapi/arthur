import { describe, expect, it } from "vitest";

import { validateBuildArtifacts } from "./check-builds.mjs";

describe("check-builds", () => {
  it("rejects a manifest with an action popup", async () => {
    await expect(validateBuildArtifacts({ root: "/missing-arthur-build" })).rejects.toThrow();
  });
});
