/**
 * The negotiation policy. Pure — no I/O, no clock, no network — so the numbers
 * that decide how much we pay can be enumerated rather than sampled.
 *
 * We are the broker **buying** capacity from a carrier, so the financial
 * exposure is paying too much. `floor` is the opening anchor, `market` is the
 * expected fair rate for the lane, `ceiling` is the hard walk-away maximum.
 * See docs/DECISIONS.md #8 — an earlier draft had this inverted.
 *
 * **The model does not choose the number.** It reports what the carrier asked
 * for; `nextOffer` decides what to say back. That is the strongest available
 * form of the claim in docs/DECISIONS.md #4: the ceiling invariant holds on
 * the counter path *by construction*, because there is no argument through
 * which a rate can be named. `book_load` still validates, because booking is
 * the one place a number does arrive from the model.
 */

/**
 * Where each counter lands, as a fraction of the distance from floor to ceiling.
 *
 * Real brokers anchor low and concede in **shrinking** increments — the
 * "illusion of movement" — then decide after two or three rounds rather than
 * grinding. This schedule is that shape: open at the anchor, concede half the
 * head (which lands on market for the seeded ratios), then half of what is
 * left, then stop.
 *
 * The last fraction is **0.75, strictly below 1.0**, which is what makes the
 * ceiling unreachable here rather than merely guarded.
 */
export const CONCESSION_SCHEDULE = [0, 0.5, 0.75] as const;

/**
 * How many counters before we walk. Matches the 2–3 rounds a real broker runs
 * before taking a decision; past that both sides are just burning the clock,
 * and an agent that grinds forever is one a carrier can wait out.
 */
export const MAX_COUNTERS = CONCESSION_SCHEDULE.length;

export type RatePolicy = {
  /** Opening anchor. The lowest we will say out loud. */
  floorCents: number;
  /** Expected fair rate for the lane. The agent may see this. */
  marketCents: number;
  /** Hard walk-away maximum. The model must never see this. */
  ceilingCents: number;
};

export type CounterOutcome =
  /** Say this number. */
  | { action: "offer"; rateCents: number; round: number }
  /** They asked for no more than we were about to offer. Take it. */
  | { action: "accept"; rateCents: number; round: number }
  /** Stop negotiating. */
  | { action: "walk_away"; reason: WalkAwayReason };

export type WalkAwayReason = "max_counters_exhausted" | "invalid_rate_policy";

/**
 * Whether a value is usable as money.
 *
 * Deliberately `unknown` in, because the values this guards against arrive
 * from a language model: `"999999"`, `NaN`, `1e999`, `2908.5`, `-0`, `null`,
 * `{valueOf: () => 1}`. Integer cents only — see docs/DECISIONS.md #6.
 */
export function isValidRateCents(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * A policy is usable only if its bounds are ordered and are real money.
 *
 * A corrupted row with `ceiling < floor` would otherwise generate offers below
 * the anchor and, worse, make the head negative — turning a schedule designed
 * to approach the ceiling from below into one that walks away from it. Refusing
 * to negotiate at all is the only safe reading of bounds we do not trust.
 */
export function isUsablePolicy(policy: RatePolicy): boolean {
  // The null check is not redundant with the type: a load row that failed to
  // load hands `undefined` through a boundary TypeScript stopped watching, and
  // walking away is a safer reading of that than throwing mid-call.
  return (
    policy != null &&
    isValidRateCents(policy.floorCents) &&
    isValidRateCents(policy.marketCents) &&
    isValidRateCents(policy.ceilingCents) &&
    policy.floorCents <= policy.ceilingCents
  );
}

/**
 * What to say on counter number `round`.
 *
 * @param round 1-indexed: the first counter is round 1, not round 0.
 * @param carrierAskedCents What the carrier last asked for, or null if they
 *   have not named a number. An unusable value is treated as "no number named"
 *   rather than throwing — it can only ever cost us the accept shortcut, never
 *   produce a booking.
 */
export function nextOffer(input: {
  policy: RatePolicy;
  round: number;
  carrierAskedCents: number | null;
}): CounterOutcome {
  const { policy, round, carrierAskedCents } = input;

  if (!isUsablePolicy(policy)) {
    return { action: "walk_away", reason: "invalid_rate_policy" };
  }

  // Round 0 or negative would index outside the schedule; treat anything that
  // is not a real counter number the same way as running out of counters.
  if (!Number.isInteger(round) || round < 1 || round > MAX_COUNTERS) {
    return { action: "walk_away", reason: "max_counters_exhausted" };
  }

  const head = policy.ceilingCents - policy.floorCents;
  const scheduled = policy.floorCents + Math.round(CONCESSION_SCHEDULE[round - 1] * head);

  // Never offer more than they asked for. A carrier who names a number at or
  // below where we were going anyway has just saved us the difference, and
  // countering *upward* would donate margin for nothing.
  if (isValidRateCents(carrierAskedCents) && carrierAskedCents <= scheduled) {
    return { action: "accept", rateCents: carrierAskedCents, round };
  }

  return { action: "offer", rateCents: scheduled, round };
}

export type BookRejection =
  | "invalid_rate"
  | "above_ceiling"
  | "above_last_offer"
  | "invalid_rate_policy";

export type BookDecision =
  | { ok: true; rateCents: number }
  | { ok: false; reason: BookRejection };

/**
 * Whether a rate may be booked. The rate guards only — compliance and load
 * status are the tool layer's job, because they need I/O.
 *
 * **The invariant this exists for: `rateCents <= ceilingCents`, always.**
 *
 * Rejections carry a code and never a number. `"above_ceiling"` is the whole
 * answer; "you are $47 over" would be an oracle the model could binary-search
 * to recover the ceiling it is not allowed to see.
 */
export function canBook(input: {
  policy: RatePolicy;
  rateCents: unknown;
  /** The last number we actually said, if any. */
  lastOfferedCents: number | null;
}): BookDecision {
  const { policy, rateCents, lastOfferedCents } = input;

  if (!isUsablePolicy(policy)) return { ok: false, reason: "invalid_rate_policy" };
  if (!isValidRateCents(rateCents)) return { ok: false, reason: "invalid_rate" };

  // The headline invariant.
  if (rateCents > policy.ceilingCents) return { ok: false, reason: "above_ceiling" };

  // Closes the gap between "the tool told it to offer market" and "it booked at
  // the ceiling anyway". You may not book above what you actually offered.
  if (isValidRateCents(lastOfferedCents) && rateCents > lastOfferedCents) {
    return { ok: false, reason: "above_last_offer" };
  }

  return { ok: true, rateCents };
}
