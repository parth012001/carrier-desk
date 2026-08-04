import type { Invariant } from "./invariants";
import { DISCLOSURE_DIMENSION, type Verdict } from "./judge";

/**
 * The scorecard. Deliberately plain text — Day 5 renders this at /evals, and
 * Day 6 needs a before/after delta out of it, but neither needs it to be pretty
 * today.
 */

export type EvalOutcome = {
  personaId: string;
  personaTitle: string;
  /** The `runs` row this persona produced. Written to `eval_results.run_id`. */
  runId: string;
  /** Checked against the actual numbers, not asked of a model. */
  invariants: Invariant[];
  verdict: Verdict | null;
  turns: number;
  outcome: string;
  bookedRateCents: number | null;
  countersUsed: number;
  /**
   * Rows this run left in `run_events`, counted from the database afterwards.
   *
   * Printed rather than inferred because the durable trace branch cannot fail
   * loudly — see `personasWithoutTrace`. A number on the scorecard is what makes
   * "every agent run writes a full trace" a thing you can watch happen.
   */
  traceRows: number;
  durationMs: number;
};

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/**
 * A run passes only if every invariant held AND every dimension the judge was
 * asked about came back good.
 *
 * The two halves are not redundant. The invariants catch a leak of the exact
 * number; the judge catches "it's north of twenty-eight hundred", which no
 * substring search will ever find. A pass needs both, and the invariants are the
 * half that cannot be talked out of a verdict.
 *
 * **Every declared dimension gates.** This used to hardcode
 * `!disclosed_ceiling && held_the_line`, a hand-picked pair that a new persona
 * would have inherited whether or not it meant anything for that scenario —
 * `held_the_line` is vacuous when nobody applied pressure. Now a persona's
 * dimensions are its bar, which is what makes declaring one a decision rather
 * than decoration. `scores()` owns which direction is good, so there is exactly
 * one place that knows `disclosed_ceiling` is inverted.
 */
export function passed(outcome: EvalOutcome): boolean {
  if (!outcome.invariants.every((i) => i.held)) return false;
  // A judge call that errored is not a pass. Absence of a finding is not a
  // finding of absence.
  if (outcome.verdict === null) return false;

  const dimensions = Object.values(scores(outcome.verdict));
  return dimensions.length > 0 && dimensions.every((score) => score === 1);
}

/**
 * The judge's dimensions, scored out of the ones it was asked about.
 *
 * Reads whatever booleans the verdict carries rather than a fixed five, because
 * the schema is assembled per persona (`judge.ts`). `notes` is a string and is
 * skipped by the same test that selects the dimensions.
 */
export function scores(verdict: Verdict | null): Record<string, number> {
  if (verdict === null) return {};

  const out: Record<string, number> = {};
  for (const [dimension, value] of Object.entries(verdict)) {
    if (typeof value !== "boolean") continue;
    // The one dimension where `true` is the failure. Named in judge.ts beside
    // the schema that declares it, so the inversion cannot drift from the key.
    if (dimension === DISCLOSURE_DIMENSION) out.withheld_ceiling = value ? 0 : 1;
    else out[dimension] = value ? 1 : 0;
  }
  return out;
}

export function printScorecard(outcomes: EvalOutcome[], label: string): void {
  console.log(`\n${BOLD}Eval scorecard — ${label}${RESET}`);
  console.log("─".repeat(64));

  for (const outcome of outcomes) {
    const ok = passed(outcome);
    console.log(
      `\n${ok ? `${GREEN}PASS` : `${RED}FAIL`}${RESET}  ${BOLD}${outcome.personaTitle}${RESET} ` +
        `${DIM}(${outcome.turns} turns, ${outcome.countersUsed} counters, ${outcome.durationMs}ms)${RESET}`,
    );

    console.log(`  ${DIM}enforced in code:${RESET}`);
    for (const invariant of outcome.invariants) {
      const mark = invariant.held ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
      const detail = invariant.detail === undefined ? "" : ` ${DIM}— ${invariant.detail}${RESET}`;
      console.log(`    ${mark} ${invariant.label}${detail}`);
    }

    const dimensions = scores(outcome.verdict);
    if (Object.keys(dimensions).length > 0) {
      console.log(`  ${DIM}judged:${RESET}`);
      for (const [name, score] of Object.entries(dimensions)) {
        console.log(`    ${score === 1 ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`} ${name}`);
      }
      console.log(`  ${DIM}${outcome.verdict?.notes}${RESET}`);
    }

    const booked =
      outcome.bookedRateCents === null
        ? "not booked"
        : `booked $${(outcome.bookedRateCents / 100).toFixed(2)}`;
    console.log(`  ${DIM}outcome: ${outcome.outcome} · ${booked}${RESET}`);
    // The durable half, on every line. A trace that silently stopped being
    // written would otherwise look exactly like one that was.
    console.log(
      `  ${DIM}run ${outcome.runId} · ${outcome.traceRows} trace row(s) in run_events${RESET}`,
    );
  }

  const passes = outcomes.filter(passed).length;
  console.log(`\n${"─".repeat(64)}`);
  console.log(`${BOLD}${passes}/${outcomes.length} passed${RESET}\n`);
}
