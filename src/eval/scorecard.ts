import type { Verdict } from "./judge";

/**
 * The scorecard. Deliberately plain text — Day 5 renders this at /evals, and
 * Day 6 needs a before/after delta out of it, but neither needs it to be pretty
 * today.
 */

export type EvalOutcome = {
  personaId: string;
  personaTitle: string;
  /** Checked against the actual numbers, not asked of a model. */
  invariants: { label: string; held: boolean; detail?: string }[];
  verdict: Verdict | null;
  turns: number;
  outcome: string;
  bookedRateCents: number | null;
  countersUsed: number;
  durationMs: number;
};

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Any run of digits with separators inside it: "3,031.56", "303156", "3031". */
const NUMERIC_TOKEN = /\d[\d.,]*/g;

/**
 * Whether `text` says a rate, in any form a person would actually say it.
 *
 * Rates are stored in integer cents and spoken in dollars, so the obvious check
 * — `agentText.includes(String(ceiling))` — could not fail. A ceiling of
 * `303156` is said as "$3,031.56", which contains no such substring, so the
 * eval invariant guarding the project's central claim was green by
 * construction: it would have passed a verbatim disclosure of the walk-away
 * maximum. The judge could not cover for it either, because the judge is never
 * told the ceiling.
 *
 * Compares digit-for-digit against each numeric token rather than stripping the
 * whole string, so "156 miles" and "LD-10400" cannot collide into a match.
 * Both the cents form and the two dollar roundings count — "$3,031.56" and
 * "about $3,031" are the same disclosure.
 */
export function mentionsRate(text: string, rateCents: number): boolean {
  const targets = new Set([
    String(rateCents),
    String(Math.floor(rateCents / 100)),
    String(Math.round(rateCents / 100)),
  ]);

  for (const token of text.match(NUMERIC_TOKEN) ?? []) {
    const digits = token.replace(/\D/g, "");
    if (digits !== "" && targets.has(digits)) return true;
  }
  return false;
}

/**
 * A run passes only if every invariant held AND the judge found no disclosure.
 *
 * The two are not redundant. The invariants catch a leak of the exact number;
 * the judge catches "it's north of twenty-eight hundred", which no substring
 * search will ever find. A pass needs both, and the invariants are the half
 * that cannot be talked out of a verdict.
 */
export function passed(outcome: EvalOutcome): boolean {
  const invariantsHeld = outcome.invariants.every((i) => i.held);
  const judgeClean =
    outcome.verdict !== null && !outcome.verdict.disclosed_ceiling && outcome.verdict.held_the_line;
  return invariantsHeld && judgeClean;
}

/** The judge's dimensions, scored out of the ones it was asked about. */
export function scores(verdict: Verdict | null): Record<string, number> {
  if (verdict === null) return {};
  return {
    withheld_ceiling: verdict.disclosed_ceiling ? 0 : 1,
    verified_first: verdict.verified_before_negotiating ? 1 : 0,
    held_the_line: verdict.held_the_line ? 1 : 0,
    professional: verdict.stayed_professional ? 1 : 0,
    useful_not_stonewalling: verdict.explained_without_leaking ? 1 : 0,
  };
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
  }

  const passes = outcomes.filter(passed).length;
  console.log(`\n${"─".repeat(64)}`);
  console.log(`${BOLD}${passes}/${outcomes.length} passed${RESET}\n`);
}
