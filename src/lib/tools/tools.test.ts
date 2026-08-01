import { describe, expect, it } from "vitest";

import { MAX_COUNTERS } from "@/lib/negotiation/policy";

import {
  DOT_FOR_ALLOWED,
  MC_ALLOWED,
  MC_BLOCKED,
  callTool,
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
  it("opens at the anchor when the carrier has not named a number", async () => {
    const h = makeHarness();
    const load = h.loads.snapshot(REF)!;

    const result = (await callTool(h.tools, "counter_offer", { load_ref: REF })) as {
      action: string;
      rate_cents: number;
      counters_remaining: number;
    };

    expect(result.action).toBe("offer");
    expect(result.rate_cents).toBe(load.rateFloorCents);
    expect(result.counters_remaining).toBe(MAX_COUNTERS - 1);
  });

  it("concedes upward across the allowed counters, then walks", async () => {
    const h = makeHarness();
    const load = h.loads.snapshot(REF)!;
    const offers: number[] = [];

    for (let i = 0; i < MAX_COUNTERS; i++) {
      const result = (await callTool(h.tools, "counter_offer", {
        load_ref: REF,
        carrier_asked_cents: load.rateCeilingCents * 2,
      })) as { action: string; rate_cents: number };
      expect(result.action).toBe("offer");
      offers.push(result.rate_cents);
    }

    const beyond = (await callTool(h.tools, "counter_offer", {
      load_ref: REF,
      carrier_asked_cents: load.rateCeilingCents * 2,
    })) as { action: string; reason: string };

    expect(offers[0]).toBeLessThan(offers[1]);
    expect(offers[1]).toBeLessThan(offers[2]);
    expect(offers.at(-1)).toBeLessThan(load.rateCeilingCents);
    expect(beyond).toMatchObject({ action: "walk_away", reason: "max_counters_exhausted" });
  });

  it("takes the carrier's number when it is below what we were about to offer", async () => {
    const h = makeHarness();
    const load = h.loads.snapshot(REF)!;
    const bargain = load.rateFloorCents - 10_000;

    const result = (await callTool(h.tools, "counter_offer", {
      load_ref: REF,
      carrier_asked_cents: bargain,
    })) as { action: string; rate_cents: number };

    expect(result).toMatchObject({ action: "accept", rate_cents: bargain });
  });

  it("does not burn a counter on a walked-away turn", async () => {
    // There is nothing to consume: we did not say a number.
    const h = makeHarness();
    for (let i = 0; i < MAX_COUNTERS; i++) {
      await callTool(h.tools, "counter_offer", { load_ref: REF });
    }

    const before = h.state.countersUsed(REF);
    await callTool(h.tools, "counter_offer", { load_ref: REF });

    expect(h.state.countersUsed(REF)).toBe(before);
  });

  it("counts counters per load, so a second load starts fresh", async () => {
    const h = makeHarness();
    await callTool(h.tools, "counter_offer", { load_ref: REF });
    await callTool(h.tools, "counter_offer", { load_ref: REF });

    const other = (await callTool(h.tools, "counter_offer", { load_ref: "LD-10401" })) as {
      counters_remaining: number;
    };

    expect(other.counters_remaining).toBe(MAX_COUNTERS - 1);
  });

  it("records every offer so policy can be proven afterwards", async () => {
    const h = makeHarness();
    await callTool(h.tools, "counter_offer", { load_ref: REF, carrier_asked_cents: 999_999 });

    expect(h.negotiations.entries).toHaveLength(1);
    expect(h.negotiations.entries[0]).toMatchObject({
      runId: "run-test",
      turn: 1,
      carrierAskedCents: 999_999,
      accepted: false,
    });
  });

  it("refuses to quote a load that is not on the board", async () => {
    const h = makeHarness();

    const result = (await callTool(h.tools, "counter_offer", { load_ref: "LD-00000" })) as {
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
    const offer = (await callTool(h.tools, "counter_offer", { load_ref: REF })) as {
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
    const offer = (await callTool(h.tools, "counter_offer", { load_ref: REF })) as {
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
    const offer = (await callTool(h.tools, "counter_offer", { load_ref: REF })) as {
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
    const offer = (await callTool(h.tools, "counter_offer", { load_ref: REF })) as {
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
    await callTool(h.tools, "counter_offer", { load_ref: REF });

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
