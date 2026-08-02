import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { carriers } from "@/db/schema";
import { MC_ALLOWED, callTool, makeHarness } from "@/lib/tools/harness";

/**
 * Persisting a looked-up carrier is where docs/DECISIONS.md #10 could quietly
 * be undone.
 *
 * `CarrierRecord.isOutOfService` is `boolean | null`, where **null means "this
 * source cannot determine it", never "not out of service"**. The Socrata census
 * file has no out-of-service column among its 148, so every keyless lookup
 * returns null — and the `carriers` column was `NOT NULL DEFAULT false` until
 * this commit. Writing to it would have recorded "checked and clean" about a
 * question nobody asked, on every single carrier, which is the exact failure
 * #10 exists to prevent and the exact failure #13 caught one level down.
 */
describe("the carriers compliance snapshot", () => {
  it("keeps is_out_of_service nullable", () => {
    // The schema-level assertion. A future migration that re-adds NOT NULL
    // fails here rather than silently at the first lookup.
    expect(getTableColumns(carriers).isOutOfService.notNull).toBe(false);
  });

  it("keeps every three-valued compliance field nullable", () => {
    const columns = getTableColumns(carriers);
    for (const field of [
      "isOutOfService",
      "safetyRating",
      "powerUnits",
      "authorizedForHire",
      "priorRevocation",
    ] as const) {
      expect(columns[field].notNull, `${field} must be able to say "unknown"`).toBe(false);
    }
  });

  it("stores an unanswerable question as null, not as false", async () => {
    const h = makeHarness();

    await callTool(h.tools, "lookup_carrier", { mc_number: MC_ALLOWED });
    const stored = h.carriers.recordFor(MC_ALLOWED);

    expect(stored).not.toBeNull();
    // Socrata genuinely cannot answer this, and says so twice: the value is
    // null AND the capability is false.
    expect(stored?.isOutOfService).toBeNull();
    expect(stored?.capabilities.outOfService).toBe(false);
  });

  it("writes a carrier on first contact and counts the call", async () => {
    const h = makeHarness();

    await callTool(h.tools, "lookup_carrier", { mc_number: MC_ALLOWED });

    expect(h.carriers.snapshot(MC_ALLOWED)).toMatchObject({
      mcNumber: MC_ALLOWED,
      totalCalls: 1,
    });
  });

  it("does not create a carrier row for an MC with no FMCSA record", async () => {
    // Nothing is known about this entity, so there is nothing to remember.
    // Writing a shell row would make a nonexistent carrier look like a known one.
    const h = makeHarness();

    await callTool(h.tools, "lookup_carrier", { mc_number: "9999999" });

    expect(h.carriers.snapshot("9999999")).toBeNull();
  });

  it("still records a carrier that was blocked", async () => {
    // Blocked carriers are exactly the ones worth remembering across calls —
    // the whole point of the Day 7 memory beat is that call #2 knows about
    // call #1, and a bad actor calling back is the interesting case.
    const h = makeHarness();

    await callTool(h.tools, "lookup_carrier", { mc_number: "1175378" });

    expect(h.carriers.snapshot("1175378")?.totalCalls).toBe(1);
    expect(h.carriers.recordFor("1175378")?.authorityStatus).toBe("inactive");
  });
});
