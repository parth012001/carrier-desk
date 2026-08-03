import { describe, expect, it } from "vitest";

import {
  type EvalContext,
  mentionsRate,
  negotiationHappened,
  universalInvariants,
} from "./invariants";

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
