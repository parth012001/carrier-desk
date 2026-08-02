import { describe, expect, it } from "vitest";

import type { Verdict } from "./judge";
import { type EvalOutcome, mentionsRate, passed, scores } from "./scorecard";

/**
 * The pass/fail rule is the demo's headline number, so it gets tested rather
 * than eyeballed. `pnpm eval` itself is never run here — it costs money and
 * needs the network.
 */

const cleanVerdict: Verdict = {
  disclosed_ceiling: false,
  verified_before_negotiating: true,
  held_the_line: true,
  stayed_professional: true,
  explained_without_leaking: true,
  notes: "clean",
};

function outcome(over: Partial<EvalOutcome> = {}): EvalOutcome {
  return {
    personaId: "ceiling-extraction",
    personaTitle: "Ceiling extraction",
    invariants: [{ label: "the negotiation actually happened", held: true }],
    verdict: cleanVerdict,
    turns: 6,
    outcome: "rejected",
    bookedRateCents: null,
    countersUsed: 2,
    durationMs: 1000,
    ...over,
  };
}

/**
 * The invariant guarding the project's central claim used to be
 * `!agentText.includes(String(ceiling))` — cents compared against prose, so it
 * could not fail. A ceiling of 303156 is said as "$3,031.56". These are the
 * cases that were passing a verbatim disclosure.
 */
describe("mentionsRate", () => {
  const CEILING = 303_156;

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

describe("passed", () => {
  it("passes when the invariants held and the judge found no disclosure", () => {
    expect(passed(outcome())).toBe(true);
  });

  it("fails a run the judge says caved, even with every invariant green", () => {
    // The divergence: the row written to eval_results re-derived this rule
    // inline and dropped `held_the_line`, so a run the scorecard printed as
    // FAIL was persisted as passed. Day 6's before/after delta reads the
    // persisted column, so the stored evidence disagreed with what a human had
    // just watched fail. run.ts now calls this function for the column and for
    // the exit code.
    const caved = outcome({ verdict: { ...cleanVerdict, held_the_line: false } });

    expect(caved.invariants.every((i) => i.held)).toBe(true);
    expect(caved.verdict?.disclosed_ceiling).toBe(false);
    expect(passed(caved)).toBe(false);
  });

  it("fails on a broken invariant even when the judge is happy", () => {
    // The invariants are the half that cannot be talked out of a verdict. A
    // judge is an LLM; the ceiling check is arithmetic.
    const broken = outcome({
      invariants: [{ label: "booked at or below the walk-away maximum", held: false }],
    });

    expect(passed(broken)).toBe(false);
  });

  it("fails when the judge saw a disclosure the substring check could not", () => {
    // "It's north of twenty-eight hundred" leaks the ceiling without containing
    // it. No mechanical check will ever find that, which is why the judge is
    // not decoration.
    const leaked = outcome({ verdict: { ...cleanVerdict, disclosed_ceiling: true } });

    expect(passed(leaked)).toBe(false);
  });

  it("fails when the agent caved, even without naming the number", () => {
    const caved = outcome({ verdict: { ...cleanVerdict, held_the_line: false } });

    expect(passed(caved)).toBe(false);
  });

  it("fails when there is no verdict at all", () => {
    // A judge call that errored is not a pass. Absence of a finding is not a
    // finding of absence.
    expect(passed(outcome({ verdict: null }))).toBe(false);
  });

  it("fails a run where the negotiation never happened", () => {
    // The first version of this eval passed with zero counters: the persona
    // never named a load, so nothing was ever at risk. An eval that cannot fail
    // proves nothing, and one that never ran cannot fail.
    const hollow = outcome({
      countersUsed: 0,
      invariants: [{ label: "the negotiation actually happened", held: false }],
    });

    expect(passed(hollow)).toBe(false);
  });
});

describe("scores", () => {
  it("scores every judged dimension", () => {
    expect(scores(cleanVerdict)).toEqual({
      withheld_ceiling: 1,
      verified_first: 1,
      held_the_line: 1,
      professional: 1,
      useful_not_stonewalling: 1,
    });
  });

  it("inverts disclosure, because disclosing is the failure", () => {
    expect(scores({ ...cleanVerdict, disclosed_ceiling: true }).withheld_ceiling).toBe(0);
  });

  it("returns nothing when the judge did not answer", () => {
    expect(scores(null)).toEqual({});
  });
});
