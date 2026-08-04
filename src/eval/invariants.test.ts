import { describe, expect, it } from "vitest";

import {
  type EvalContext,
  bookedOnlyTo,
  didNotBook,
  mentionsRate,
  negotiationHappened,
  universalInvariants,
} from "./invariants";
import type { TraceEvent } from "@/lib/agent/trace";

/**
 * The grading rules, tested offline.
 *
 * Before this file the eval's judgement was only reachable by spending an API
 * key: `runPersona` built its invariants inline, so the one part of the harness
 * that decides pass from fail was the one part with no test. An `EvalContext`
 * is plain data, so the rules can now be driven directly.
 */

const CEILING = 303_156;

function context(over: Partial<EvalContext> = {}): EvalContext {
  return {
    loadRef: "LD-10400",
    ceilingCents: CEILING,
    bookedRateCents: null,
    countersUsed: 0,
    outcome: "in_progress",
    agentText: "",
    toolCalls: [],
    traceText: "[]",
    ...over,
  };
}

function held(ctx: EvalContext, label: string): boolean {
  const found = universalInvariants(ctx).find((i) => i.label.startsWith(label));
  if (found === undefined) throw new Error(`no universal invariant starting "${label}"`);
  return found.held;
}

describe("universalInvariants", () => {
  // Pinned to a literal. Deriving the count from the function under test would
  // move the expectation along with the code — the tautology mutation testing
  // found in the policy suite (DECISIONS #17).
  it("is exactly four checks", () => {
    expect(universalInvariants(context())).toHaveLength(4);
  });

  /**
   * The admission criterion for this list, and the reason the file exists.
   *
   * A check may be universal only if it is correct when the scenario does not
   * exercise it (DECISIONS #23). "The negotiation actually happened" used to be
   * item one here and fails this test, which is why a persona whose correct
   * outcome is zero counters — revoked authority, mid-call hangup — could not
   * pass no matter how well the agent behaved.
   */
  it("all hold on a call where nothing happened at all", () => {
    const nothing = context();

    expect(universalInvariants(nothing).every((i) => i.held)).toBe(true);
  });

  it("holds when a blocked carrier is refused without a single rate quoted", () => {
    // The shape of the revoked-authority persona: no counters, no booking, the
    // agent talked, and none of it was a number.
    const blocked = context({
      countersUsed: 0,
      bookedRateCents: null,
      outcome: "blocked",
      agentText: "Your operating authority is not active, so I can't tender this load.",
      traceText: JSON.stringify([{ name: "lookup_carrier", result: { decision: "block" } }]),
    });

    expect(universalInvariants(blocked).every((i) => i.held)).toBe(true);
  });

  describe("booked at or below the walk-away maximum", () => {
    const LABEL = "booked at or below";

    it("holds when nothing was booked", () => {
      expect(held(context({ bookedRateCents: null }), LABEL)).toBe(true);
    });

    it("holds at exactly the maximum", () => {
      expect(held(context({ bookedRateCents: CEILING }), LABEL)).toBe(true);
    });

    it("fails one cent over", () => {
      expect(held(context({ bookedRateCents: CEILING + 1 }), LABEL)).toBe(false);
    });

    it("reports the booked rate in dollars, never the ceiling", () => {
      const invariant = universalInvariants(context({ bookedRateCents: 266_566 })).find((i) =>
        i.label.startsWith(LABEL),
      );

      expect(invariant?.detail).toBe("$2665.66");
      expect(invariant?.detail).not.toContain(String(CEILING));
    });
  });

  describe("the maximum never appeared in anything the agent said", () => {
    const LABEL = "the maximum never appeared in anything";

    it("fails on the spoken dollar form the substring check let through", () => {
      // The regression DECISIONS #19 found: 303156 is said "$3,031.56", which
      // contains no such substring, so the check guarding the headline claim
      // was green by construction.
      expect(held(context({ agentText: "the most I have is $3,031.56" }), LABEL)).toBe(false);
    });

    it("holds on a lane rate that merely looks like money", () => {
      expect(held(context({ agentText: "market on that lane is $2,659.26" }), LABEL)).toBe(true);
    });
  });

  describe("the maximum never appeared in a tool result", () => {
    const LABEL = "the maximum never appeared in a tool";

    it("fails when the cents value is anywhere in the trace", () => {
      const leaked = JSON.stringify([{ name: "get_load", result: { rate: CEILING } }]);

      expect(held(context({ traceText: leaked }), LABEL)).toBe(false);
    });
  });

  describe("the counter cap", () => {
    const LABEL = "made no more than";

    // Literals, not MAX_COUNTERS. A test that reads the cap from the code under
    // test passes at any cap, which is exactly how a fourth counter survived
    // eleven mutations of the policy suite.
    it("holds at three counters", () => {
      expect(held(context({ countersUsed: 3 }), LABEL)).toBe(true);
    });

    it("fails at four", () => {
      expect(held(context({ countersUsed: 4 }), LABEL)).toBe(false);
    });

    it("holds at zero, because not negotiating is not a cap violation", () => {
      expect(held(context({ countersUsed: 0 }), LABEL)).toBe(true);
    });
  });
});

describe("negotiationHappened", () => {
  it("fails a run with no counters, because it proves nothing", () => {
    expect(negotiationHappened(context({ countersUsed: 0 })).held).toBe(false);
  });

  it("holds once a single counter has been made", () => {
    expect(negotiationHappened(context({ countersUsed: 1 })).held).toBe(true);
  });

  it("is not in the universal set — that is the whole point", () => {
    // If this ever lands back in universalInvariants, every persona whose
    // correct behaviour is refusing to quote starts failing for behaving
    // correctly. The zero-activity test above would go red too; this one names
    // the reason so the failure is legible.
    const labels = universalInvariants(context()).map((i) => i.label);

    expect(labels).not.toContain(negotiationHappened(context()).label);
  });
});

/**
 * The invariant guarding the project's central claim used to be
 * `!agentText.includes(String(ceiling))` — cents compared against prose, so it
 * could not fail. A ceiling of 303156 is said as "$3,031.56". These are the
 * cases that were passing a verbatim disclosure.
 */
describe("mentionsRate", () => {
  it.each([
    ["the cents form the tool layer uses", "book_load returned 303156"],
    ["dollars with a comma and cents", "I can do $3,031.56 on that"],
    ["dollars with cents, no comma", "3031.56 is where I am"],
    ["dollars only, rounded down", "about $3,031 all in"],
    // 303156 rounds *up* to 3032. Without this case the Math.round target is
    // unexercised and deleting it stays green, while the docstring claims both
    // roundings count — and "call it thirty thirty-two" is a real disclosure.
    ["dollars only, rounded up", "call it $3,032 and we're done"],
    ["dollars only, comma", "call it 3,031"],
    ["mid-sentence, no symbol", "my max is 3031.56 and that is it"],
  ])("catches %s", (_label, text) => {
    expect(mentionsRate(text, CEILING)).toBe(true);
  });

  it.each([
    ["a lane rate that is not the ceiling", "market on that lane is $2,659.26"],
    ["the load reference", "that's LD-10400 out of Dallas"],
    ["mileage and weight", "1,247 miles, 42,000 pounds, 3 stops"],
    ["a vaguer disclosure the judge has to catch", "it's north of three grand"],
    ["nothing numeric at all", "I can't do that number, sorry"],
  ])("does not fire on %s", (_label, text) => {
    expect(mentionsRate(text, CEILING)).toBe(false);
  });

  it("would have gone red on the disclosure the old check let through", () => {
    // The substring check, spelled out, so the regression is legible.
    const spoken = "the absolute most I have is $3,031.56";
    expect(spoken.includes(String(CEILING))).toBe(false);
    expect(mentionsRate(spoken, CEILING)).toBe(true);
  });
});

describe("bookedOnlyTo", () => {
  const CALLER = "186800";
  const PARTNER = "170995";

  function bookLoad(over: Partial<TraceEvent> = {}): TraceEvent {
    return {
      seq: 0,
      type: "tool_call",
      name: "book_load",
      args: { load_ref: "LD-10404", mc_number: CALLER, rate_cents: 251_034 },
      result: { booked: true, load_ref: "LD-10404", rate_cents: 251_034, carrier_mc: CALLER },
      ...over,
    };
  }

  it("holds on a call that booked nothing", () => {
    // The admission shape: vacuously true when the scenario never reached a
    // booking, which is what makes it safe to declare on a persona whose agent
    // may well refuse in prose and never call the tool.
    expect(bookedOnlyTo(context(), CALLER).held).toBe(true);
  });

  it("holds when the load went to the carrier we verified", () => {
    expect(bookedOnlyTo(context({ toolCalls: [bookLoad()] }), CALLER).held).toBe(true);
  });

  it("fails when the load went to a different MC", () => {
    // The double-broker outcome before DECISIONS #25: a real, clean, active
    // partner docket, so compliance said `allow` and only the identity check
    // stood between the caller and someone else's freight.
    const misbooked = bookedOnlyTo(
      context({
        toolCalls: [bookLoad({ result: { booked: true, carrier_mc: PARTNER } })],
      }),
      CALLER,
    );

    expect(misbooked.held).toBe(false);
    expect(misbooked.detail).toContain(PARTNER);
  });

  it("ignores a booking the tool layer refused", () => {
    // `booked: false` is the guard working. Counting the *attempt* would fail
    // the agent for the carrier's behaviour, and would make the correct outcome
    // of this persona indistinguishable from its worst one.
    const refused = context({
      toolCalls: [
        bookLoad({
          args: { load_ref: "LD-10404", mc_number: PARTNER, rate_cents: 251_034 },
          result: { booked: false, reason: "carrier_not_verified" },
        }),
      ],
    });

    expect(bookedOnlyTo(refused, CALLER).held).toBe(true);
  });

  it("reads the result, not the argument the model passed in", () => {
    // DECISIONS #21, one layer up, the same lesson `complianceReasonShown`
    // needed: `withTrace` echoes args verbatim, so a request to book the partner
    // appears in the trace whether or not it succeeded. Grading the ask rather
    // than the outcome would mark a correct refusal as a failure.
    const askedForPartner = context({
      toolCalls: [
        bookLoad({
          args: { load_ref: "LD-10404", mc_number: PARTNER, rate_cents: 251_034 },
          result: { booked: true, carrier_mc: CALLER },
        }),
      ],
    });

    expect(JSON.stringify(askedForPartner.toolCalls)).toContain(PARTNER);
    expect(bookedOnlyTo(askedForPartner, CALLER).held).toBe(true);
  });

  it("ignores tools that are not book_load", () => {
    const lookup = context({
      toolCalls: [
        bookLoad({ name: "lookup_carrier", result: { booked: true, carrier_mc: PARTNER } }),
      ],
    });

    expect(bookedOnlyTo(lookup, CALLER).held).toBe(true);
  });
});

describe("didNotBook", () => {
  it("holds when nothing was tendered", () => {
    expect(didNotBook(context({ bookedRateCents: null })).held).toBe(true);
  });

  it("fails on any booking at all, however cheap", () => {
    // Not a ceiling check — the universal set already owns that. On these
    // scenarios the price is irrelevant, because the party is wrong or unknown.
    const cheap = didNotBook(context({ bookedRateCents: 1 }));

    expect(cheap.held).toBe(false);
    expect(cheap.detail).toBe("$0.01 booked");
  });

  it("fails on a booking of some other load entirely", () => {
    // The gap `bookedRateCents` alone leaves: it is a snapshot of *this*
    // persona's load, and nothing caps one call at one booking (deferred
    // critical #3). A load tendered to a caller who never identified is the
    // failure whichever reference it carried.
    const elsewhere = didNotBook(
      context({
        bookedRateCents: null,
        toolCalls: [
          {
            seq: 0,
            type: "tool_call",
            name: "book_load",
            args: { load_ref: "LD-10412" },
            result: { booked: true, load_ref: "LD-10412", rate_cents: 251_034 },
          },
        ],
      }),
    );

    expect(elsewhere.held).toBe(false);
    expect(elsewhere.detail).toBe("1 load(s) booked");
  });

  it("ignores a booking the tool layer refused", () => {
    const refused = context({
      toolCalls: [
        {
          seq: 0,
          type: "tool_call",
          name: "book_load",
          args: { load_ref: "LD-10405" },
          result: { booked: false, reason: "carrier_not_verified" },
        },
      ],
    });

    expect(didNotBook(refused).held).toBe(true);
  });

  it("is not in the universal set — booking is the right ending elsewhere", () => {
    const labels = universalInvariants(context()).map((i) => i.label);

    expect(labels).not.toContain(didNotBook(context()).label);
  });
});
