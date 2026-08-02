import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { loads } from "@/db/schema";
import { InMemoryLoadStore } from "@/lib/agent/ports/memory";

import {
  BROKER_EXPOSED_LOAD_COLUMNS,
  BROKER_WITHHELD_LOAD_COLUMNS,
  EXPOSED_LOAD_COLUMNS,
  WITHHELD_LOAD_COLUMNS,
  toAgentLoad,
  toBrokerLoad,
} from "./sanitize";

const STORE = InMemoryLoadStore.fromSeed();
const ALL_LOADS = Array.from({ length: 40 }, (_, i) => STORE.snapshot(`LD-${10400 + i}`)!);

/**
 * Both audiences, checked the same way. A new column on `loads` has to be
 * decided about twice — once for the model, once for the broker's screen —
 * because they are two boundaries with two different answers, and the whole
 * lesson of DECISIONS #19 is that the second one is easy to forget.
 */
const AUDIENCES = [
  { who: "agent", exposed: EXPOSED_LOAD_COLUMNS, withheld: WITHHELD_LOAD_COLUMNS },
  { who: "broker", exposed: BROKER_EXPOSED_LOAD_COLUMNS, withheld: BROKER_WITHHELD_LOAD_COLUMNS },
] as const;

describe.each(AUDIENCES)("the $who allowlist", ({ exposed, withheld }) => {
  it("accounts for every column on the loads table", () => {
    // The point of this test: add a column to `loads` and it fails until
    // someone decides whether this audience may see it. Without it, a new
    // rate-adjacent column would reach them the moment it is added, and
    // nothing would say so.
    const columns = Object.keys(getTableColumns(loads)).sort();
    const decided = [...exposed, ...withheld].sort();

    expect(decided).toEqual(columns);
  });

  it("puts no column on both sides", () => {
    const overlap = (exposed as readonly string[]).filter((c) =>
      (withheld as readonly string[]).includes(c),
    );
    expect(overlap).toEqual([]);
  });
});

describe("toAgentLoad — the allowlist", () => {

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

describe("toBrokerLoad — the human's view", () => {
  it("carries the band the agent is not allowed to see", () => {
    // The difference between the two audiences, stated as a test. A broker
    // watching a call needs the ceiling on screen; that is the point of having
    // a second projection rather than reusing the model's.
    const view = toBrokerLoad(ALL_LOADS[0]);

    expect(view.floorCents).toBe(ALL_LOADS[0].rateFloorCents);
    expect(view.marketCents).toBe(ALL_LOADS[0].rateMarketCents);
    expect(view.ceilingCents).toBe(ALL_LOADS[0].rateCeilingCents);
  });

  it("keeps the band ordered, which is what makes the ladder readable", () => {
    for (const load of ALL_LOADS) {
      const view = toBrokerLoad(load);
      expect(view.floorCents, view.ref).toBeLessThanOrEqual(view.marketCents);
      expect(view.marketCents, view.ref).toBeLessThanOrEqual(view.ceilingCents);
    }
  });

  it("leaves internal identifiers behind", () => {
    // A uuid on a screen is noise, and `coveredByCarrierId` says nothing a
    // person can read. `ref` is the key humans use out loud, so it is the key
    // the interface uses too.
    const serialized = JSON.stringify(toBrokerLoad(ALL_LOADS[0]));

    expect(serialized).not.toContain(ALL_LOADS[0].id);
    expect(Object.keys(toBrokerLoad(ALL_LOADS[0]))).not.toContain("coveredByCarrierId");
  });

  it("emits dates as strings, so a server component can hand it to a client one", () => {
    const view = toBrokerLoad(ALL_LOADS[0]);
    expect(typeof view.pickupStart).toBe("string");
    expect(view.pickupStart).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("names the rate fields differently from the agent's view", () => {
    // Same row, two readers. The rate fields are where the audiences actually
    // diverge, so they are the ones that must not be confusable: a value typed
    // as one view cannot be passed where the other is expected, and grepping
    // for `ceilingCents` finds every place a human is shown the walk-away.
    const agent = Object.keys(toAgentLoad(ALL_LOADS[0]));
    const broker = Object.keys(toBrokerLoad(ALL_LOADS[0]));

    expect(broker).toContain("ceilingCents");
    expect(broker).toContain("floorCents");
    expect(agent).not.toContain("ceilingCents");
    expect(agent).not.toContain("floorCents");

    const rateKeys = (keys: string[]) => keys.filter((k) => /rate|cents/i.test(k));
    expect(rateKeys(agent)).toEqual(["market_rate_cents"]);
    expect(rateKeys(broker).some((key) => agent.includes(key))).toBe(false);
  });
});
