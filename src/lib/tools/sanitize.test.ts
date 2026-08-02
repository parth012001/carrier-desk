import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { loads } from "@/db/schema";
import { InMemoryLoadStore } from "@/lib/agent/ports/memory";

import { EXPOSED_LOAD_COLUMNS, WITHHELD_LOAD_COLUMNS, toAgentLoad } from "./sanitize";

const STORE = InMemoryLoadStore.fromSeed();
const ALL_LOADS = Array.from({ length: 40 }, (_, i) => STORE.snapshot(`LD-${10400 + i}`)!);

describe("toAgentLoad — the allowlist", () => {
  it("accounts for every column on the loads table", () => {
    // The point of this test: add a column to `loads` and it fails until
    // someone decides whether the agent may see it. Without it, a new
    // rate-adjacent column would reach the model the moment it is added, and
    // nothing would say so.
    const columns = Object.keys(getTableColumns(loads)).sort();
    const decided = [...EXPOSED_LOAD_COLUMNS, ...WITHHELD_LOAD_COLUMNS].sort();

    expect(decided).toEqual(columns);
  });

  it("puts no column on both sides", () => {
    const overlap = EXPOSED_LOAD_COLUMNS.filter((c) =>
      (WITHHELD_LOAD_COLUMNS as readonly string[]).includes(c),
    );
    expect(overlap).toEqual([]);
  });

  it("withholds the ceiling and the floor", () => {
    expect(WITHHELD_LOAD_COLUMNS).toContain("rateCeilingCents");
    expect(WITHHELD_LOAD_COLUMNS).toContain("rateFloorCents");
  });

  it("exposes market, which the agent is allowed to discuss", () => {
    expect(EXPOSED_LOAD_COLUMNS).toContain("rateMarketCents");
  });

  it("never carries the ceiling or the floor through, on any seeded load", () => {
    for (const load of ALL_LOADS) {
      const serialized = JSON.stringify(toAgentLoad(load));

      expect(serialized, `${load.ref} leaked its ceiling`).not.toContain(
        String(load.rateCeilingCents),
      );
      expect(serialized, `${load.ref} leaked its floor`).not.toContain(String(load.rateFloorCents));
      expect(serialized).not.toMatch(/ceiling/i);
      expect(serialized).not.toMatch(/floor/i);
    }
  });

  it("carries the details a carrier actually asks about", () => {
    const view = toAgentLoad(ALL_LOADS[0]);

    expect(view).toMatchObject({
      load_ref: "LD-10400",
      origin: "Laredo, TX",
      destination: "Chicago, IL",
      equipment: "dry_van",
      miles: 1380,
      status: "available",
    });
    expect(view.market_rate_cents).toBe(ALL_LOADS[0].rateMarketCents);
  });

  it("emits dates as strings, not Date objects", () => {
    // These cross a JSON boundary into the model. A Date would serialize
    // inconsistently depending on who did it.
    const view = toAgentLoad(ALL_LOADS[0]);
    expect(typeof view.pickup_start).toBe("string");
    expect(view.pickup_start).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
