import { describe, expect, it } from "vitest";

import { carrierLookupCache } from "@/db/schema";

/**
 * Guards the test harness itself. If the "@/*" alias or the node environment
 * regresses, this fails first and says why, instead of every other suite
 * failing with a confusing module-resolution error.
 */
describe("test harness", () => {
  it("runs in the node environment, not a browser shim", () => {
    expect(typeof window).toBe("undefined");
  });

  it('resolves the "@/*" alias to src/', () => {
    expect(carrierLookupCache).toBeDefined();
  });
});
