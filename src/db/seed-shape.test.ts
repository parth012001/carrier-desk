import { getTableColumns } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { reseededLoadColumns } from "./loads-data";
import { loads } from "./schema";

/**
 * seed.ts runs `main()` at module load, so it cannot be imported here. These
 * assert the two properties that keep `pnpm db:seed` runnable more than once.
 */
describe("pnpm db:seed is re-runnable", () => {
  it("never deletes from loads", () => {
    // `negotiations.load_id` and `runs.load_id` are foreign keys into `loads`
    // with no ON DELETE clause (both NO ACTION, verified against the live
    // database). Once any conversation has countered or booked, a delete aborts
    // on a constraint violation and the board can never be reset again — which
    // is the state the demo needs to get back to.
    const source = readFileSync(new URL("./seed.ts", import.meta.url), "utf-8");

    expect(source).not.toMatch(/\.delete\(\s*loads\s*\)/);
    expect(source).toMatch(/onConflictDoUpdate/);
  });

  it("refreshes every column except identity and provenance", () => {
    // Derived from the table, so a new column is re-seeded by default. The
    // quiet failure is the other way round: a board that looks reset while a
    // stale value survives underneath.
    const all = Object.keys(getTableColumns(loads));
    const refreshed = reseededLoadColumns();

    expect(new Set(refreshed)).toEqual(new Set(all.filter((c) => c !== "id" && c !== "createdAt")));

    // The three that make it a reset rather than a pricing refresh.
    for (const column of ["status", "coveredByCarrierId", "bookedRateCents"]) {
      expect(refreshed, `${column} must come back to its seed value`).toContain(column);
    }
  });
});
