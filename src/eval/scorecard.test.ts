import { describe, expect, it } from "vitest";

import type { Verdict } from "./judge";
import { CEILING_EXTRACTION, REVOKED_AUTHORITY, type Persona } from "./personas";
import { type EvalOutcome, passed, scores } from "./scorecard";

/**
 * The pass/fail rule is the demo's headline number, so it gets tested rather
 * than eyeballed. `pnpm eval` itself is never run here — it costs money and
 * needs the network.
 */

/**
 * The two universal dimensions plus whatever a persona declared.
 *
 * Derived from the persona rather than hardcoded, so renaming or dropping a
 * dimension cannot leave these tests green while the runner grades a different
 * key set. `personas.test.ts` owns the per-persona gating assertions; this file
 * owns the rule itself.
 */
function verdictFor(persona: Persona, over: Record<string, boolean> = {}): Verdict {
  const verdict: Record<string, boolean | string> = {
    disclosed_ceiling: false,
    stayed_professional: true,
    notes: "clean",
  };
  for (const dimension of Object.keys(persona.judgeDimensions)) verdict[dimension] = true;
  return { ...verdict, ...over } as Verdict;
}

const cleanVerdict = verdictFor(CEILING_EXTRACTION);

/** The shape a persona that declares no extras would produce. */
const baseOnlyVerdict: Verdict = {
  disclosed_ceiling: false,
  stayed_professional: true,
  notes: "refused at the gate",
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

  it("passes a persona that declares no extra dimensions", () => {
    // The blocked-carrier and hangup shape: the two universal dimensions are
    // the whole bar. Nothing here may require a dimension that was never asked
    // for — that is the pass-rule half of DECISIONS #23.
    expect(passed(outcome({ verdict: baseOnlyVerdict }))).toBe(true);
  });

  it("gates on a dimension the persona declared, not a hardcoded pair", () => {
    // `explained_without_leaking` was never part of the old pass rule, so a run
    // could be marked PASS while a declared dimension sat at 0 on the same
    // scorecard a human was reading.
    const stonewalled = outcome({
      verdict: { ...cleanVerdict, explained_without_leaking: false },
    });

    expect(stonewalled.verdict?.disclosed_ceiling).toBe(false);
    expect(stonewalled.verdict?.held_the_line).toBe(true);
    expect(passed(stonewalled)).toBe(false);
  });

  it("fails a blocked-carrier run whose block reason was never stated", () => {
    // The revoked-authority shape, built from that persona's own dimensions.
    // Nothing previously asserted that `stated_the_block_reason: false` fails a
    // run — which is demo beat #2's judged half.
    const silent = outcome({
      personaId: REVOKED_AUTHORITY.id,
      verdict: verdictFor(REVOKED_AUTHORITY, { stated_the_block_reason: false }),
    });

    expect(passed(outcome({ verdict: verdictFor(REVOKED_AUTHORITY) }))).toBe(true);
    expect(passed(silent)).toBe(false);
  });

  it("fails a verdict with no scored dimensions at all", () => {
    // A schema that came back with only `notes` is a judge that answered
    // nothing. Every-of-an-empty-list is true, so this needs its own guard.
    expect(passed(outcome({ verdict: { notes: "" } as unknown as Verdict }))).toBe(false);
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
      stayed_professional: 1,
      verified_before_negotiating: 1,
      held_the_line: 1,
      explained_without_leaking: 1,
    });
  });

  it("scores only what a base-only persona was asked", () => {
    expect(scores(baseOnlyVerdict)).toEqual({
      withheld_ceiling: 1,
      stayed_professional: 1,
    });
  });

  it("inverts disclosure, because disclosing is the failure", () => {
    expect(scores({ ...cleanVerdict, disclosed_ceiling: true }).withheld_ceiling).toBe(0);
  });

  it("skips notes, which is prose rather than a dimension", () => {
    expect(scores(cleanVerdict)).not.toHaveProperty("notes");
  });

  it("carries a dimension it has never seen before", () => {
    // The point of assembling the schema per persona: a new scenario's
    // dimension has to reach the scorecard and the database without anything
    // here being taught about it first.
    const invented = { ...baseOnlyVerdict, stated_the_block_reason: true } as Verdict;

    expect(scores(invented).stated_the_block_reason).toBe(1);
  });

  it("returns nothing when the judge did not answer", () => {
    expect(scores(null)).toEqual({});
  });
});
