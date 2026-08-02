import { describe, expect, it } from "vitest";

import { buildLoads } from "@/db/loads-data";
import {
  CONCESSION_SCHEDULE,
  MAX_COUNTERS,
  type RatePolicy,
  canBook,
  isValidRateCents,
  nextOffer,
} from "./policy";

/**
 * This is the money. A wrong number here overpays on every load, and a wrong
 * `ok` in canBook books freight above the walk-away maximum — so the boundary
 * is enumerated rather than sampled, the same standard evaluateCompliance is
 * held to.
 *
 * Everything runs against the real 40 seeded loads, not a hand-written example,
 * so a policy that happens to work on one set of ratios cannot pass.
 */

/** Fixed: buildLoad takes an injected clock, and this machine's runs slow. */
const SEEDED = buildLoads(new Date("2026-08-01T00:00:00.000Z"));

const policyOf = (load: (typeof SEEDED)[number]): RatePolicy => ({
  floorCents: load.rateFloorCents,
  marketCents: load.rateMarketCents,
  ceilingCents: load.rateCeilingCents,
});

const POLICIES = SEEDED.map(policyOf);

/** Values a language model can emit that are not money. */
const HOSTILE_RATES: [label: string, value: unknown][] = [
  ["numeric string", "999999"],
  ["overflowing literal", 1e999],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["-Infinity", Number.NEGATIVE_INFINITY],
  ["past MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER + 1],
  ["negative zero", -0],
  ["zero", 0],
  ["negative", -1],
  ["fractional cents", 2908.5],
  ["null", null],
  ["undefined", undefined],
  ["boxed number", { valueOf: () => 1 }],
  ["array", [1]],
  ["boolean", true],
];

describe("isValidRateCents", () => {
  it.each(HOSTILE_RATES)("rejects %s", (_label, value) => {
    expect(isValidRateCents(value)).toBe(false);
  });

  it("accepts a positive integer number of cents", () => {
    for (const value of [1, 100, 290_800, Number.MAX_SAFE_INTEGER]) {
      expect(isValidRateCents(value)).toBe(true);
    }
  });
});

describe("the concession schedule", () => {
  it("does not read the ceiling at all — move it and every offer is unchanged", () => {
    // The structural form of the claim, and stronger than the one it replaces.
    //
    // The old assertion was that the top fraction is below 1.0 of the
    // floor-to-ceiling head. That bounds the offer but does not hide the
    // ceiling: interpolating floor→ceiling made every offer an exact affine
    // function of it, so with the old [0, 0.5, 0.75] schedule the observed
    // offers satisfied `ceiling = r3 + (r3 - r2)` identically. A model that was
    // never told the ceiling could recover it to the cent from two numbers the
    // tool layer handed it.
    //
    // Interpolating floor→market instead makes the ceiling an input to nothing
    // on this path, which is a property a test can actually pin: vary the
    // ceiling across three orders of magnitude and the offers must not move. If
    // anyone reintroduces a ceiling term, this goes red on the first policy.
    for (const policy of POLICIES) {
      const offersFor = (ceilingCents: number) =>
        Array.from({ length: MAX_COUNTERS }, (_, i) => {
          const outcome = nextOffer({
            policy: { ...policy, ceilingCents },
            round: i + 1,
            carrierAskedCents: null,
          });
          if (outcome.action !== "offer") throw new Error("expected an offer");
          return outcome.rateCents;
        });

      const baseline = offersFor(policy.ceilingCents);
      expect(offersFor(policy.marketCents)).toEqual(baseline);
      expect(offersFor(policy.ceilingCents * 10)).toEqual(baseline);
      expect(offersFor(policy.ceilingCents * 1000)).toEqual(baseline);
    }
  });

  it("tops out at market, which is what keeps every offer under the ceiling", () => {
    // With the ceiling out of the arithmetic, the bound comes from the ordering
    // isUsablePolicy enforces: offers reach market at most, and market <= ceiling.
    expect(Math.max(...CONCESSION_SCHEDULE)).toBe(1);
    for (const policy of POLICIES) {
      expect(policy.marketCents).toBeLessThanOrEqual(policy.ceilingCents);
    }
  });

  it("opens at the anchor", () => {
    expect(CONCESSION_SCHEDULE[0]).toBe(0);
  });

  it("concedes in shrinking increments", () => {
    // Real brokers manufacture the feel of movement while giving away less each
    // time. A schedule with growing steps would telegraph that waiting pays.
    const deltas = CONCESSION_SCHEDULE.slice(1).map((f, i) => f - CONCESSION_SCHEDULE[i]);
    for (let i = 1; i < deltas.length; i++) {
      expect(deltas[i]).toBeLessThan(deltas[i - 1]);
    }
  });

  it("has exactly MAX_COUNTERS entries", () => {
    expect(CONCESSION_SCHEDULE.length).toBe(MAX_COUNTERS);
  });

  it("is the schedule we chose, pinned to literals", () => {
    // Found by mutation testing: every other test in this file derives its
    // expectations from MAX_COUNTERS and CONCESSION_SCHEDULE, so adding a
    // fourth counter moved the tests along with the code and all 88 stayed
    // green. Tautology, not coverage.
    //
    // Three counters is a domain choice — real brokers run two or three rounds
    // and then decide, and an agent that grinds forever is one a carrier can
    // simply wait out. Changing it should mean re-arguing that, which is what
    // a literal assertion forces.
    expect(MAX_COUNTERS).toBe(3);
    expect([...CONCESSION_SCHEDULE]).toEqual([0, 0.6, 1]);
  });
});

describe("nextOffer — across every seeded load", () => {
  it("never offers at or above the ceiling", () => {
    for (const policy of POLICIES) {
      for (let round = 1; round <= MAX_COUNTERS; round++) {
        const outcome = nextOffer({ policy, round, carrierAskedCents: null });
        if (outcome.action !== "offer") throw new Error(`expected an offer at round ${round}`);
        expect(outcome.rateCents).toBeLessThan(policy.ceilingCents);
      }
    }
  });

  it("never offers below the anchor", () => {
    for (const policy of POLICIES) {
      for (let round = 1; round <= MAX_COUNTERS; round++) {
        const outcome = nextOffer({ policy, round, carrierAskedCents: null });
        if (outcome.action !== "offer") throw new Error("expected an offer");
        expect(outcome.rateCents).toBeGreaterThanOrEqual(policy.floorCents);
      }
    }
  });

  it("offers whole cents only", () => {
    for (const policy of POLICIES) {
      for (let round = 1; round <= MAX_COUNTERS; round++) {
        const outcome = nextOffer({ policy, round, carrierAskedCents: null });
        if (outcome.action !== "offer") throw new Error("expected an offer");
        expect(Number.isSafeInteger(outcome.rateCents)).toBe(true);
      }
    }
  });

  it("moves upward, and by less each time", () => {
    for (const policy of POLICIES) {
      const offers = Array.from({ length: MAX_COUNTERS }, (_, i) => {
        const outcome = nextOffer({ policy, round: i + 1, carrierAskedCents: null });
        if (outcome.action !== "offer") throw new Error("expected an offer");
        return outcome.rateCents;
      });

      const deltas = offers.slice(1).map((v, i) => v - offers[i]);
      for (const delta of deltas) expect(delta).toBeGreaterThan(0);
      for (let i = 1; i < deltas.length; i++) {
        expect(deltas[i]).toBeLessThan(deltas[i - 1]);
      }
    }
  });

  it("opens at the floor", () => {
    for (const policy of POLICIES) {
      const outcome = nextOffer({ policy, round: 1, carrierAskedCents: null });
      expect(outcome).toEqual({ action: "offer", rateCents: policy.floorCents, round: 1 });
    }
  });

  it("closes on market at the last counter, and stays under it before that", () => {
    // Market is the top of the ladder now, not a waypoint on the way to the
    // ceiling. Every earlier round has to sit strictly below it, or the
    // shrinking-concession shape is a fiction. Tolerance is for independent
    // rounding of the three columns, not slack.
    for (const policy of POLICIES) {
      for (let round = 1; round < MAX_COUNTERS; round++) {
        const early = nextOffer({ policy, round, carrierAskedCents: null });
        if (early.action !== "offer") throw new Error("expected an offer");
        expect(early.rateCents).toBeLessThan(policy.marketCents);
      }

      const last = nextOffer({ policy, round: MAX_COUNTERS, carrierAskedCents: null });
      if (last.action !== "offer") throw new Error("expected an offer");
      expect(Math.abs(last.rateCents - policy.marketCents)).toBeLessThanOrEqual(2);
    }
  });
});

describe("nextOffer — the counter cap at N-1 / N / N+1", () => {
  const policy = POLICIES[0];

  it("counters at N-1", () => {
    expect(nextOffer({ policy, round: MAX_COUNTERS - 1, carrierAskedCents: null }).action).toBe(
      "offer",
    );
  });

  it("counters at N", () => {
    expect(nextOffer({ policy, round: MAX_COUNTERS, carrierAskedCents: null }).action).toBe("offer");
  });

  it("walks at N+1", () => {
    expect(nextOffer({ policy, round: MAX_COUNTERS + 1, carrierAskedCents: null })).toEqual({
      action: "walk_away",
      reason: "max_counters_exhausted",
    });
  });

  it("walks rather than indexing outside the schedule", () => {
    // Round 0 and friends would read CONCESSION_SCHEDULE[-1] and offer NaN.
    for (const round of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 999]) {
      expect(
        nextOffer({ policy, round, carrierAskedCents: null }).action,
        `round ${round}`,
      ).toBe("walk_away");
    }
  });

  it("names no number at all once counters are exhausted", () => {
    // The walk-away path must not become a back door for naming a rate: a
    // carrier who grinds past the cap and then asks for the moon gets silence,
    // not a counter.
    for (const p of POLICIES) {
      const outcome = nextOffer({
        policy: p,
        round: MAX_COUNTERS + 1,
        carrierAskedCents: p.ceilingCents * 10,
      });

      expect(outcome).toEqual({ action: "walk_away", reason: "max_counters_exhausted" });
      expect(outcome).not.toHaveProperty("rateCents");
    }
  });

  it("walks rather than crashing on a missing rate policy", () => {
    // Reachable: a load row that failed to load hands `undefined` through a
    // boundary TypeScript stopped watching. Walking away is the safe reading;
    // throwing mid-call is not.
    const missing = undefined as unknown as RatePolicy;

    expect(nextOffer({ policy: missing, round: 1, carrierAskedCents: null })).toEqual({
      action: "walk_away",
      reason: "invalid_rate_policy",
    });
    expect(canBook({ policy: missing, rateCents: 1, lastOfferedCents: null })).toEqual({
      ok: false,
      reason: "invalid_rate_policy",
    });
  });
});

describe("nextOffer — taking what the carrier asked for", () => {
  const policy = POLICIES[0];

  it("accepts at the carrier's number when it is below our scheduled offer", () => {
    // Countering upward here would donate margin for nothing.
    const scheduled = policy.floorCents;
    const outcome = nextOffer({ policy, round: 1, carrierAskedCents: scheduled - 5_000 });

    expect(outcome).toEqual({ action: "accept", rateCents: scheduled - 5_000, round: 1 });
  });

  it("accepts at exact equality", () => {
    const outcome = nextOffer({ policy, round: 1, carrierAskedCents: policy.floorCents });
    expect(outcome).toEqual({ action: "accept", rateCents: policy.floorCents, round: 1 });
  });

  it("counters when the carrier is asking for more", () => {
    const outcome = nextOffer({ policy, round: 1, carrierAskedCents: policy.ceilingCents * 2 });
    expect(outcome).toEqual({ action: "offer", rateCents: policy.floorCents, round: 1 });
  });

  it("accepts nothing above the ceiling, at any round", () => {
    // The accept branch takes the carrier's number, so it is the one place a
    // carrier-supplied value could become a booking. It can only ever fire
    // below our own scheduled offer, which is itself below the ceiling.
    for (const p of POLICIES) {
      for (let round = 1; round <= MAX_COUNTERS; round++) {
        for (const asked of [p.ceilingCents, p.ceilingCents + 1, p.ceilingCents * 3]) {
          const outcome = nextOffer({ policy: p, round, carrierAskedCents: asked });
          if (outcome.action === "walk_away") continue;
          expect(outcome.rateCents).toBeLessThan(p.ceilingCents);
        }
      }
    }
  });

  it.each(HOSTILE_RATES)("ignores a %s ask rather than accepting it", (_label, value) => {
    const outcome = nextOffer({
      policy,
      round: 1,
      carrierAskedCents: value as number | null,
    });

    expect(outcome.action).toBe("offer");
  });
});

describe("nextOffer — untrustworthy bounds", () => {
  it("refuses to negotiate when the ceiling is below the floor", () => {
    // A negative head would invert the schedule: a design that approaches the
    // ceiling from below would start walking away from it instead.
    const inverted: RatePolicy = { floorCents: 300_000, marketCents: 280_000, ceilingCents: 250_000 };

    expect(nextOffer({ policy: inverted, round: 1, carrierAskedCents: null })).toEqual({
      action: "walk_away",
      reason: "invalid_rate_policy",
    });
  });

  it.each(HOSTILE_RATES)("refuses to negotiate when the ceiling is %s", (_label, value) => {
    const policy = { ...POLICIES[0], ceilingCents: value as number };

    expect(nextOffer({ policy, round: 1, carrierAskedCents: null })).toEqual({
      action: "walk_away",
      reason: "invalid_rate_policy",
    });
  });
});

describe("canBook — the ceiling invariant, enumerated", () => {
  const LAST_OFFERS = ["none", "floor", "market", "ceiling"] as const;

  function lastOfferFor(policy: RatePolicy, kind: (typeof LAST_OFFERS)[number]): number | null {
    if (kind === "none") return null;
    if (kind === "floor") return policy.floorCents;
    if (kind === "market") return policy.marketCents;
    return policy.ceilingCents;
  }

  it("never books above the ceiling — every load, every boundary, every history", () => {
    let checked = 0;

    for (const policy of POLICIES) {
      const candidates = [
        policy.ceilingCents - 1,
        policy.ceilingCents,
        policy.ceilingCents + 1,
        policy.floorCents,
        policy.marketCents,
        policy.ceilingCents * 2,
        1,
      ];

      for (const rateCents of candidates) {
        for (const kind of LAST_OFFERS) {
          const decision = canBook({
            policy,
            rateCents,
            lastOfferedCents: lastOfferFor(policy, kind),
          });
          checked++;

          if (decision.ok) {
            expect(
              decision.rateCents,
              `booked ${decision.rateCents} over ceiling ${policy.ceilingCents}`,
            ).toBeLessThanOrEqual(policy.ceilingCents);
          }
        }
      }
    }

    // 40 loads x 7 candidates x 4 histories. Guards against a refactor that
    // silently narrows the sweep and leaves the assertion looking healthy.
    expect(checked).toBe(POLICIES.length * 7 * LAST_OFFERS.length);
  });

  it("rejects at exactly one cent over, and accepts at exactly the ceiling", () => {
    // `lastOfferedCents` is set beyond the ceiling so that only the ceiling
    // guard can reject. It is not a number the tool layer can produce — offers
    // top out at market — which is the point: this drives the backstop
    // directly, so deleting the ceiling check cannot leave the suite green.
    for (const policy of POLICIES) {
      const lastOfferedCents = policy.ceilingCents * 4;

      expect(canBook({ policy, rateCents: policy.ceilingCents, lastOfferedCents })).toEqual({
        ok: true,
        rateCents: policy.ceilingCents,
      });
      expect(canBook({ policy, rateCents: policy.ceilingCents + 1, lastOfferedCents })).toEqual({
        ok: false,
        reason: "above_ceiling",
      });
    }
  });

  it("refuses to book anything at all when no offer was ever made", () => {
    // The regression. `isValidRateCents(null)` is false, so the whole
    // above_last_offer branch used to fall through and a call could go straight
    // from lookup_carrier to book_load at the full walk-away maximum, with zero
    // negotiation and every test still green.
    for (const policy of POLICIES) {
      for (const rateCents of [1, policy.floorCents, policy.marketCents, policy.ceilingCents]) {
        expect(canBook({ policy, rateCents, lastOfferedCents: null })).toEqual({
          ok: false,
          reason: "no_offer_made",
        });
      }
    }
  });

  it("answers the same way above the offer whether or not the ceiling is in reach", () => {
    // The oracle. A rejected booking costs nothing and consumes no counter, so
    // the model could probe as often as it liked; with the ceiling checked
    // first, `above_ceiling` past the maximum and `above_last_offer` below it
    // formed a one-bit comparator that binary-searches straight to the ceiling.
    // Checking the offer first makes every rejection above what we said carry
    // the same code no matter where the ceiling sits.
    for (const policy of POLICIES) {
      const lastOfferedCents = policy.marketCents;
      const probes = [
        lastOfferedCents + 1,
        Math.round((lastOfferedCents + policy.ceilingCents) / 2),
        policy.ceilingCents,
        policy.ceilingCents + 1,
        policy.ceilingCents * 2,
      ];

      const reasons = new Set(
        probes.map((rateCents) => {
          const decision = canBook({ policy, rateCents, lastOfferedCents });
          if (decision.ok) throw new Error(`expected a rejection at ${rateCents}`);
          return decision.reason;
        }),
      );

      expect([...reasons]).toEqual(["above_last_offer"]);
    }
  });

  it.each(HOSTILE_RATES)("rejects a %s rate", (_label, value) => {
    for (const policy of POLICIES.slice(0, 5)) {
      const decision = canBook({ policy, rateCents: value, lastOfferedCents: null });
      expect(decision.ok).toBe(false);
    }
  });

  it("refuses to book above what we actually offered", () => {
    // Closes the gap between "the tool told it to offer market" and "it booked
    // at the ceiling anyway".
    for (const policy of POLICIES) {
      const decision = canBook({
        policy,
        rateCents: policy.ceilingCents,
        lastOfferedCents: policy.marketCents,
      });

      expect(decision).toEqual({ ok: false, reason: "above_last_offer" });
    }
  });

  it("allows booking below the last offer", () => {
    for (const policy of POLICIES) {
      expect(
        canBook({
          policy,
          rateCents: policy.floorCents,
          lastOfferedCents: policy.marketCents,
        }),
      ).toEqual({ ok: true, rateCents: policy.floorCents });
    }
  });

  it("refuses to book against untrustworthy bounds", () => {
    const inverted: RatePolicy = { floorCents: 300_000, marketCents: 280_000, ceilingCents: 250_000 };

    expect(canBook({ policy: inverted, rateCents: 100, lastOfferedCents: null })).toEqual({
      ok: false,
      reason: "invalid_rate_policy",
    });
  });

  it("leaks no number in a rejection", () => {
    // "You are $47 over" would be an oracle the model could binary-search to
    // recover a ceiling it is not allowed to see. The reason code is the whole
    // answer.
    for (const policy of POLICIES) {
      for (const rateCents of [policy.ceilingCents + 1, policy.ceilingCents * 2, -1, Number.NaN]) {
        const decision = canBook({ policy, rateCents, lastOfferedCents: policy.floorCents });
        expect(JSON.stringify(decision)).toMatch(/^\{"ok":false,"reason":"[a-z_]+"\}$/);
      }
    }
  });
});
