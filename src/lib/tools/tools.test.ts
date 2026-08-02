import { describe, expect, it } from "vitest";

import { MAX_COUNTERS } from "@/lib/negotiation/policy";

import {
  DOT_FOR_ALLOWED,
  MC_ALLOWED,
  MC_ALLOWED_OTHER,
  MC_BLOCKED,
  callTool,
  twoCleanCarriersSource,
  makeHarness,
} from "./harness";

const REF = "LD-10400";

describe("lookup_carrier", () => {
  it("clears a carrier with active authority", async () => {
    const h = makeHarness();

    const result = (await callTool(h.tools, "lookup_carrier", {
      mc_number: MC_ALLOWED,
    })) as { found: boolean; decision: string; carrier: { legal_name: string } };

    expect(result.found).toBe(true);
    expect(result.decision).toBe("allow");
    expect(result.carrier.legal_name).toBe("GENERAL TRANSPORT INC");
  });

  it("blocks the carrier whose authority is inactive, with the reasons", async () => {
    // LB 168 INC: entity still Active, 55 trucks, authority Inactive, prior
    // revocation on file. A company that looks alive and cannot legally haul.
    const h = makeHarness();

    const result = (await callTool(h.tools, "lookup_carrier", {
      mc_number: MC_BLOCKED,
    })) as { decision: string; reasons: { code: string }[] };

    expect(result.decision).toBe("block");
    expect(result.reasons.map((r) => r.code)).toContain("AUTHORITY_NOT_ACTIVE");
    expect(result.reasons.map((r) => r.code)).toContain("PRIOR_AUTHORITY_REVOCATION");
  });

  it("accepts a dirty MC number the way a carrier would say it", async () => {
    const h = makeHarness();

    for (const dirty of ["MC-186800", "mc 186800", " 00186800 "]) {
      const result = (await callTool(h.tools, "lookup_carrier", { mc_number: dirty })) as {
        found: boolean;
      };
      expect(result.found, dirty).toBe(true);
    }
  });

  it("flags a mismatch between the claimed DOT and the registered one", async () => {
    // Reciting a real company's MC while operating as someone else is the
    // identity-theft shape of double-brokering, and this is one of the few
    // signals available before any freight moves.
    const h = makeHarness();

    const result = (await callTool(h.tools, "lookup_carrier", {
      mc_number: MC_ALLOWED,
      claimed_dot: "9999999",
    })) as { decision: string; reasons: { code: string }[] };

    expect(result.decision).toBe("flag");
    expect(result.reasons.map((r) => r.code)).toContain("MC_DOT_MISMATCH");
  });

  it("says nothing when the claimed DOT agrees", async () => {
    const h = makeHarness();

    const result = (await callTool(h.tools, "lookup_carrier", {
      mc_number: MC_ALLOWED,
      claimed_dot: `DOT ${DOT_FOR_ALLOWED}`,
    })) as { decision: string; reasons: { code: string }[] };

    expect(result.decision).toBe("allow");
    expect(result.reasons.map((r) => r.code)).not.toContain("MC_DOT_MISMATCH");
  });

  it("blocks an MC with no FMCSA record at all", async () => {
    const h = makeHarness();

    const result = (await callTool(h.tools, "lookup_carrier", { mc_number: "9999999" })) as {
      found: boolean;
      decision: string;
      reasons: { code: string }[];
    };

    expect(result.found).toBe(false);
    expect(result.decision).toBe("block");
    expect(result.reasons.map((r) => r.code)).toEqual(["NOT_FOUND"]);
  });

  it("remembers the carrier across calls, which is the Day 7 memory beat", async () => {
    const h = makeHarness();

    const first = (await callTool(h.tools, "lookup_carrier", { mc_number: MC_ALLOWED })) as {
      previous_calls: number;
    };
    const second = (await callTool(h.tools, "lookup_carrier", { mc_number: MC_ALLOWED })) as {
      previous_calls: number;
    };

    expect(first.previous_calls).toBe(0);
    expect(second.previous_calls).toBe(1);
    expect(h.carriers.snapshot(MC_ALLOWED)?.totalCalls).toBe(2);
  });
});

describe("check_compliance", () => {
  it("refuses to imply a carrier is clean when it was never looked up", async () => {
    // "Never checked" is not "checked and fine". This is DECISIONS #10 and #13
    // one layer up: the agent must not be able to narrate a verification that
    // did not happen.
    const h = makeHarness();

    const result = (await callTool(h.tools, "check_compliance", {
      mc_number: MC_ALLOWED,
    })) as { verified: boolean; reason: string };

    expect(result.verified).toBe(false);
    expect(result.reason).toBe("not_looked_up");
  });

  it("restates the decision without contacting FMCSA again", async () => {
    let lookups = 0;
    const h = makeHarness();
    const original = h.deps.source.lookupByMc.bind(h.deps.source);
    h.deps.source.lookupByMc = async (mc: string) => {
      lookups++;
      return original(mc);
    };

    await callTool(h.tools, "lookup_carrier", { mc_number: MC_BLOCKED });
    const result = (await callTool(h.tools, "check_compliance", {
      mc_number: MC_BLOCKED,
    })) as { verified: boolean; decision: string };

    expect(result).toMatchObject({ verified: true, decision: "block" });
    expect(lookups).toBe(1);
  });
});

describe("get_load", () => {
  it("returns the agent's view of a real load", async () => {
    const h = makeHarness();

    const result = (await callTool(h.tools, "get_load", { load_ref: REF })) as {
      found: boolean;
      load: { origin: string; market_rate_cents: number };
    };

    expect(result.found).toBe(true);
    expect(result.load.origin).toBe("Laredo, TX");
  });

  it("says so when the reference is not on the board", async () => {
    const h = makeHarness();

    const result = (await callTool(h.tools, "get_load", { load_ref: "LD-00000" })) as {
      found: boolean;
    };

    expect(result.found).toBe(false);
  });
});

describe("counter_offer", () => {
  /** Every quote needs a cleared caller first — see the guard tests below. */
  async function verified() {
    const h = makeHarness();
    await callTool(h.tools, "lookup_carrier", { mc_number: MC_ALLOWED });
    return h;
  }

  it("refuses to quote before the caller has been verified", async () => {
    // Found by the Day 3 eval: the model interleaves lookup_carrier with other
    // calls in one parallel step, so the prompt's "verify first" is a
    // suggestion about ordering rather than a constraint on it. Booking was
    // never at risk — book_load checks compliance independently — but quoting
    // hands a rate to someone who might be blocked.
    const h = makeHarness();

    const result = (await callTool(h.tools, "counter_offer", { load_ref: REF, mc_number: MC_ALLOWED })) as {
      action: string;
      reason: string;
    };

    expect(result).toMatchObject({ action: "error", reason: "carrier_not_verified" });
    expect(h.state.countersUsed(REF)).toBe(0);
  });

  it("refuses to quote to a blocked carrier", async () => {
    const h = makeHarness();
    await callTool(h.tools, "lookup_carrier", { mc_number: MC_BLOCKED });

    const result = (await callTool(h.tools, "counter_offer", {
      load_ref: REF,
      mc_number: MC_BLOCKED,
    })) as { action: string; reason: string };

    expect(result).toMatchObject({ action: "error", reason: "carrier_not_verified" });
  });

  it("refuses a blocked carrier even when someone clean was looked up too", async () => {
    // The regression. The gate scanned every compliance result on the call and
    // returned true if any was not blocked, so one clean lookup unlocked rate
    // quoting for everyone — including the carrier the gate had just refused.
    // Scoping it needed the MC on the tool, not just better state: without an
    // argument naming who is being quoted, the check can only ever be call-wide.
    const h = makeHarness();
    await callTool(h.tools, "lookup_carrier", { mc_number: MC_ALLOWED });
    await callTool(h.tools, "lookup_carrier", { mc_number: MC_BLOCKED });

    const blocked = (await callTool(h.tools, "counter_offer", {
      load_ref: REF,
      mc_number: MC_BLOCKED,
    })) as { action: string; reason: string };

    expect(blocked).toMatchObject({ action: "error", reason: "carrier_not_verified" });
    expect(h.state.countersUsed(REF)).toBe(0);
    expect(h.negotiations.entries).toHaveLength(0);

    // And the carrier who did clear is still quotable.
    const cleared = (await callTool(h.tools, "counter_offer", {
      load_ref: REF,
      mc_number: MC_ALLOWED,
    })) as { action: string };
    expect(cleared.action).toBe("offer");
  });

  it("quotes to a flagged carrier, who is allowed to haul", async () => {
    // Flag means "a human should know", not "refuse". Blocking here would
    // stop the agent working with any carrier sharing a duplicated MC.
    const h = makeHarness();
    await callTool(h.tools, "lookup_carrier", { mc_number: MC_ALLOWED, claimed_dot: "9999999" });

    const result = (await callTool(h.tools, "counter_offer", { load_ref: REF, mc_number: MC_ALLOWED })) as {
      action: string;
    };

    expect(result.action).toBe("offer");
  });

  it("opens at the anchor when the carrier has not named a number", async () => {
    const h = await verified();
    const load = h.loads.snapshot(REF)!;

    const result = (await callTool(h.tools, "counter_offer", { load_ref: REF, mc_number: MC_ALLOWED })) as {
      action: string;
      rate_cents: number;
      counters_remaining: number;
    };

    expect(result.action).toBe("offer");
    expect(result.rate_cents).toBe(load.rateFloorCents);
    expect(result.counters_remaining).toBe(MAX_COUNTERS - 1);
  });

  it("concedes upward across the allowed counters, then walks", async () => {
    const h = await verified();
    const load = h.loads.snapshot(REF)!;
    const offers: number[] = [];

    for (let i = 0; i < MAX_COUNTERS; i++) {
      const result = (await callTool(h.tools, "counter_offer", {
        load_ref: REF,
        mc_number: MC_ALLOWED,
        carrier_asked_cents: load.rateCeilingCents * 2,
      })) as { action: string; rate_cents: number };
      expect(result.action).toBe("offer");
      offers.push(result.rate_cents);
    }

    const beyond = (await callTool(h.tools, "counter_offer", {
      load_ref: REF,
      mc_number: MC_ALLOWED,
      carrier_asked_cents: load.rateCeilingCents * 2,
    })) as { action: string; reason: string };

    expect(offers[0]).toBeLessThan(offers[1]);
    expect(offers[1]).toBeLessThan(offers[2]);
    expect(offers.at(-1)).toBeLessThan(load.rateCeilingCents);
    expect(beyond).toMatchObject({ action: "walk_away", reason: "max_counters_exhausted" });
  });

  it("takes the carrier's number when it is below what we were about to offer", async () => {
    const h = await verified();
    const load = h.loads.snapshot(REF)!;
    const bargain = load.rateFloorCents - 10_000;

    const result = (await callTool(h.tools, "counter_offer", {
      load_ref: REF,
      mc_number: MC_ALLOWED,
      carrier_asked_cents: bargain,
    })) as { action: string; rate_cents: number };

    expect(result).toMatchObject({ action: "accept", rate_cents: bargain });
  });

  it("does not burn a counter on a walked-away turn", async () => {
    // There is nothing to consume: we did not say a number.
    const h = await verified();
    for (let i = 0; i < MAX_COUNTERS; i++) {
      await callTool(h.tools, "counter_offer", { load_ref: REF, mc_number: MC_ALLOWED });
    }

    const before = h.state.countersUsed(REF);
    await callTool(h.tools, "counter_offer", { load_ref: REF, mc_number: MC_ALLOWED });

    expect(h.state.countersUsed(REF)).toBe(before);
  });

  it("counts counters per load, so a second load starts fresh", async () => {
    const h = await verified();
    await callTool(h.tools, "counter_offer", { load_ref: REF, mc_number: MC_ALLOWED });
    await callTool(h.tools, "counter_offer", { load_ref: REF, mc_number: MC_ALLOWED });

    const other = (await callTool(h.tools, "counter_offer", { load_ref: "LD-10401", mc_number: MC_ALLOWED })) as {
      counters_remaining: number;
    };

    expect(other.counters_remaining).toBe(MAX_COUNTERS - 1);
  });

  it("records every offer so policy can be proven afterwards", async () => {
    const h = await verified();
    await callTool(h.tools, "counter_offer", {
      load_ref: REF,
      mc_number: MC_ALLOWED,
      carrier_asked_cents: 999_999,
    });

    expect(h.negotiations.entries).toHaveLength(1);
    expect(h.negotiations.entries[0]).toMatchObject({
      runId: "run-test",
      turn: 1,
      carrierAskedCents: 999_999,
      accepted: false,
    });
  });

  it("refuses to quote a load that is not on the board", async () => {
    const h = await verified();

    const result = (await callTool(h.tools, "counter_offer", { load_ref: "LD-00000", mc_number: MC_ALLOWED })) as {
      action: string;
      reason: string;
    };

    expect(result).toMatchObject({ action: "error", reason: "load_not_found" });
  });
});

describe("book_load", () => {
  async function verifiedHarness() {
    const h = makeHarness();
    await callTool(h.tools, "lookup_carrier", { mc_number: MC_ALLOWED });
    return h;
  }

  it("books a verified carrier at an offered rate", async () => {
    const h = await verifiedHarness();
    const offer = (await callTool(h.tools, "counter_offer", { load_ref: REF, mc_number: MC_ALLOWED })) as {
      rate_cents: number;
    };

    const result = (await callTool(h.tools, "book_load", {
      load_ref: REF,
      mc_number: MC_ALLOWED,
      rate_cents: offer.rate_cents,
    })) as { booked: boolean; rate_cents: number };

    expect(result.booked).toBe(true);
    expect(result.rate_cents).toBe(offer.rate_cents);
    expect(h.loads.snapshot(REF)?.status).toBe("covered");
    expect(h.loads.snapshot(REF)?.bookedRateCents).toBe(offer.rate_cents);
  });

  it("refuses a carrier that was never verified", async () => {
    const h = makeHarness();

    const result = (await callTool(h.tools, "book_load", {
      load_ref: REF,
      mc_number: MC_ALLOWED,
      rate_cents: 240_000,
    })) as { booked: boolean; reason: string };

    expect(result).toMatchObject({ booked: false, reason: "carrier_not_verified" });
  });

  it("refuses a blocked carrier even at a perfectly legal rate", async () => {
    const h = makeHarness();
    await callTool(h.tools, "lookup_carrier", { mc_number: MC_BLOCKED });
    const offer = (await callTool(h.tools, "counter_offer", { load_ref: REF, mc_number: MC_ALLOWED })) as {
      rate_cents: number;
    };

    const result = (await callTool(h.tools, "book_load", {
      load_ref: REF,
      mc_number: MC_BLOCKED,
      rate_cents: offer.rate_cents,
    })) as { booked: boolean; reason: string };

    expect(result).toMatchObject({ booked: false, reason: "carrier_blocked" });
    expect(h.loads.snapshot(REF)?.status).toBe("available");
  });

  it("refuses a load someone else already took", async () => {
    const h = await verifiedHarness();
    const offer = (await callTool(h.tools, "counter_offer", { load_ref: REF, mc_number: MC_ALLOWED })) as {
      rate_cents: number;
    };
    await callTool(h.tools, "book_load", {
      load_ref: REF,
      mc_number: MC_ALLOWED,
      rate_cents: offer.rate_cents,
    });

    const again = (await callTool(h.tools, "book_load", {
      load_ref: REF,
      mc_number: MC_ALLOWED,
      rate_cents: offer.rate_cents,
    })) as { booked: boolean; reason: string };

    expect(again.booked).toBe(false);
  });
});

describe("end_call and escalate_to_human", () => {
  it("closes the run with the agent's outcome", async () => {
    const h = makeHarness();

    await callTool(h.tools, "end_call", { outcome: "rejected", summary: "Rate too low for them." });

    expect(h.runs.outcome()).toBe("rejected");
  });

  it("does not let the model overwrite a booking that actually happened", async () => {
    // The model's belief about what happened is not the record. A booking is.
    const h = makeHarness();
    await callTool(h.tools, "lookup_carrier", { mc_number: MC_ALLOWED });
    const offer = (await callTool(h.tools, "counter_offer", { load_ref: REF, mc_number: MC_ALLOWED })) as {
      rate_cents: number;
    };
    await callTool(h.tools, "book_load", {
      load_ref: REF,
      mc_number: MC_ALLOWED,
      rate_cents: offer.rate_cents,
    });

    const result = (await callTool(h.tools, "end_call", {
      outcome: "abandoned",
      summary: "Call dropped.",
    })) as { outcome: string };

    expect(result.outcome).toBe("booked");
    expect(h.runs.outcome()).toBe("booked");
    expect(h.runs.finished.at(-1)?.finalRateCents).toBe(offer.rate_cents);
  });

  it("marks an escalation as escalated", async () => {
    const h = makeHarness();

    await callTool(h.tools, "escalate_to_human", { reason: "FMCSA unreachable" });

    expect(h.runs.outcome()).toBe("escalated");
  });
});

describe("the trace", () => {
  it("writes one row per tool call, with args, result and duration", async () => {
    const h = makeHarness();

    await callTool(h.tools, "lookup_carrier", { mc_number: MC_ALLOWED });
    await callTool(h.tools, "get_load", { load_ref: REF });
    await callTool(h.tools, "counter_offer", { load_ref: REF, mc_number: MC_ALLOWED });

    const rows = h.trace.toolCalls();
    expect(rows.map((r) => r.name)).toEqual(["lookup_carrier", "get_load", "counter_offer"]);
    for (const row of rows) {
      expect(row.args).toBeDefined();
      expect(row.result).toBeDefined();
      expect(row.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("traces a rejected booking too, not just a successful one", async () => {
    // The rejections are the interesting rows. A trace that only shows what
    // worked cannot answer "why didn't it book?".
    const h = makeHarness();

    await callTool(h.tools, "book_load", {
      load_ref: REF,
      mc_number: MC_ALLOWED,
      rate_cents: 999_999_999,
    });

    expect(h.trace.toolCalls()).toHaveLength(1);
    expect(h.trace.toolCalls()[0].result).toMatchObject({ booked: false });
  });
});

/**
 * A second carrier on the call is ordinary — carriers ask about partners and
 * misread their own paperwork. Which of them the freight is tendered to is not
 * ordinary, and every test below is a regression: each of these shipped green.
 */
describe("two carriers on one call", () => {
  async function offerOn(h: Awaited<ReturnType<typeof makeHarness>>, ref = REF) {
    return (await callTool(h.tools, "counter_offer", { load_ref: ref, mc_number: MC_ALLOWED })) as {
      action: string;
      rate_cents: number;
    };
  }

  it("books against the carrier that cleared, not the one looked up last", async () => {
    // The defect: `state.carrier` was assigned on every successful lookup
    // before the decision was consulted, so the blocked carrier took the slot
    // and `loads.covered_by_carrier_id` recorded the freight against the entity
    // the gate had just rejected. The tool result said otherwise.
    const h = makeHarness();
    await callTool(h.tools, "lookup_carrier", { mc_number: MC_ALLOWED });
    await callTool(h.tools, "lookup_carrier", { mc_number: MC_BLOCKED });

    const cleared = h.carriers.snapshot(MC_ALLOWED);
    const blocked = h.carriers.snapshot(MC_BLOCKED);
    expect(blocked).not.toBeNull();

    const offer = await offerOn(h);
    const result = (await callTool(h.tools, "book_load", {
      load_ref: REF,
      mc_number: MC_ALLOWED,
      rate_cents: offer.rate_cents,
    })) as { booked: boolean };

    expect(result.booked).toBe(true);
    expect(h.loads.snapshot(REF)?.coveredByCarrierId).toBe(cleared?.id);
    expect(h.loads.snapshot(REF)?.coveredByCarrierId).not.toBe(blocked?.id);
  });

  it("refuses to book an MC that is clean but is not the caller we verified", async () => {
    // Compliance answers "is this MC clean". It does not answer "is this MC the
    // party we are on the phone with", and the carrier row book_load writes is
    // the answer to the second question. Both MCs here clear the gate, so the
    // block check cannot cover for the identity check.
    const h = makeHarness({ source: twoCleanCarriersSource() });

    await callTool(h.tools, "lookup_carrier", { mc_number: MC_ALLOWED_OTHER });
    await callTool(h.tools, "lookup_carrier", { mc_number: MC_ALLOWED });

    expect(h.state.complianceFor(MC_ALLOWED_OTHER)?.decision).toBe("allow");

    const offer = (await callTool(h.tools, "counter_offer", {
      load_ref: REF,
      mc_number: MC_ALLOWED,
    })) as { rate_cents: number };

    const result = (await callTool(h.tools, "book_load", {
      load_ref: REF,
      mc_number: MC_ALLOWED_OTHER,
      rate_cents: offer.rate_cents,
    })) as { booked: boolean; reason: string };

    expect(result).toMatchObject({ booked: false, reason: "carrier_not_verified" });
    expect(h.loads.snapshot(REF)?.status).toBe("available");
  });

  it("does not treat a lookup that failed to persist as a verified caller", async () => {
    // `rememberCompliance` runs before the carrier upsert, so a store that
    // throws leaves the gate's answer recorded with no carrier of record behind
    // it. Quoting off the compliance map alone would hand out a rate with
    // nothing to book it against.
    const h = makeHarness();
    h.deps.carriers.upsert = async () => {
      throw new Error("neon unavailable");
    };

    await expect(
      callTool(h.tools, "lookup_carrier", { mc_number: MC_ALLOWED }),
    ).rejects.toThrow("neon unavailable");

    expect(h.state.complianceFor(MC_ALLOWED)?.decision).toBe("allow");
    expect(h.state.hasClearedCarrier()).toBe(false);

    const result = (await callTool(h.tools, "counter_offer", {
      load_ref: REF,
      mc_number: MC_ALLOWED,
    })) as { action: string; reason: string };

    expect(result).toMatchObject({ action: "error", reason: "carrier_not_verified" });
  });

  it("does not let one clean lookup unlock quoting for a blocked caller", async () => {
    // `hasClearedCarrier` scanned every compliance result on the call and
    // returned true if any was not blocked, so a blocked caller only had to get
    // one legitimate MC read out to start hearing rates.
    const h = makeHarness();
    await callTool(h.tools, "lookup_carrier", { mc_number: MC_BLOCKED });

    const refused = await offerOn(h);
    expect(refused).toMatchObject({ action: "error", reason: "carrier_not_verified" });
    expect(h.negotiations.entries).toHaveLength(0);
  });
});

describe("counter_offer — an agreement is sticky", () => {
  it("does not counter upward after taking the carrier's number", async () => {
    // The defect: `nextOffer` recomputes from the schedule and knows nothing
    // about what was settled, so a carrier who accepted low and then reopened
    // was countered at the lane rate. We bid against ourselves.
    const h = makeHarness();
    await callTool(h.tools, "lookup_carrier", { mc_number: MC_ALLOWED });

    const lowball = 100_00;
    const accepted = (await callTool(h.tools, "counter_offer", {
      load_ref: REF,
      mc_number: MC_ALLOWED,
      carrier_asked_cents: lowball,
    })) as { action: string; rate_cents: number };

    expect(accepted).toMatchObject({ action: "accept", rate_cents: lowball });

    const reopened = (await callTool(h.tools, "counter_offer", {
      load_ref: REF,
      mc_number: MC_ALLOWED,
      carrier_asked_cents: 400_000,
    })) as { action: string; rate_cents: number };

    expect(reopened).toMatchObject({ action: "accept", rate_cents: lowball });

    // And the settled number is the most that can be booked.
    const overpay = (await callTool(h.tools, "book_load", {
      load_ref: REF,
      mc_number: MC_ALLOWED,
      rate_cents: lowball + 1,
    })) as { booked: boolean; reason: string };

    expect(overpay).toMatchObject({ booked: false, reason: "above_last_offer" });
  });
});

describe("the run outcome is not the model's to assert", () => {
  async function bookedHarness() {
    const h = makeHarness();
    await callTool(h.tools, "lookup_carrier", { mc_number: MC_ALLOWED });
    const offer = (await callTool(h.tools, "counter_offer", { load_ref: REF, mc_number: MC_ALLOWED })) as {
      rate_cents: number;
    };
    const booked = (await callTool(h.tools, "book_load", {
      load_ref: REF,
      mc_number: MC_ALLOWED,
      rate_cents: offer.rate_cents,
    })) as { booked: boolean };

    expect(booked.booked).toBe(true);
    return { h, rateCents: offer.rate_cents };
  }

  it("escalating after a booking cannot unwind it", async () => {
    // `end_call` guarded this; `escalate_to_human` set the outcome
    // unconditionally, so escalating overwrote a committed tender — and a
    // following end_call then saw a non-booked outcome and stamped whatever the
    // model claimed. The SDK can emit both tools in one parallel step.
    const { h, rateCents } = await bookedHarness();

    await callTool(h.tools, "escalate_to_human", { reason: "carrier disputed the rate" });
    expect(h.state.outcome).toBe("booked");

    await callTool(h.tools, "end_call", { outcome: "abandoned", summary: "hung up" });

    expect(h.state.outcome).toBe("booked");
    expect(h.runs.outcome()).toBe("booked");
    expect(h.runs.finished.at(-1)?.finalRateCents).toBe(rateCents);
  });

  it("points the run row at the load it actually booked", async () => {
    // `loadId: null` was passed at both call sites, so `runs.load_id` was never
    // non-null and no run could be joined to the freight it covered.
    const { h } = await bookedHarness();
    await callTool(h.tools, "end_call", { outcome: "booked", summary: "done" });

    expect(h.runs.finished.at(-1)?.loadId).toBe(h.loads.snapshot(REF)?.id);
  });

  it("refuses a booking the model merely believes happened", async () => {
    // end_call({outcome: "booked"}) with no book_load wrote outcome='booked'
    // with a null rate, a null load and no covered freight. Day 6's delta
    // counts those rows.
    const h = makeHarness();
    await callTool(h.tools, "lookup_carrier", { mc_number: MC_ALLOWED });

    const result = (await callTool(h.tools, "end_call", {
      outcome: "booked",
      summary: "we agreed on the phone",
    })) as { outcome: string };

    expect(result.outcome).toBe("abandoned");
    expect(h.state.outcome).toBe("abandoned");
    expect(h.runs.outcome()).toBe("abandoned");
    expect(h.loads.snapshot(REF)?.status).toBe("available");
  });
});
