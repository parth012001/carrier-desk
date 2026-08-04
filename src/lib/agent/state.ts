import type { ComplianceResult } from "@/lib/carriers/compliance";
import type { CarrierRecord } from "@/lib/carriers/types";

import type { RunOutcome, StoredCarrier } from "./types";

/**
 * Working memory for a single call.
 *
 * Deliberately in memory rather than in the database. How many counters we have
 * made is a fact about *this conversation*, and reading it back from Postgres
 * mid-call would put a network round trip — and a chance to fail — in the path
 * of every counter, for a number we already know. The database gets the record
 * afterwards; this holds the state while the call is happening.
 *
 * It also means the counter cap cannot be reset by anything the carrier says.
 * The count lives here, keyed by load, incremented by the tool, and there is no
 * argument to any tool that can move it.
 */
export class CallState {
  outcome: RunOutcome = "in_progress";
  finalRateCents: number | null = null;

  /**
   * The carrier we are treating as the caller: the most recent lookup that was
   * not blocked.
   *
   * A blocked lookup deliberately does not land here. It used to: `carrier` was
   * assigned on every successful lookup before the decision was consulted, so a
   * caller who got a clean MC verified and then had the agent look up a second,
   * blocked MC ("check my partner's number too") would see the blocked carrier
   * take the slot — and `book_load`, which validated compliance against the MC
   * it was handed, would then write the *blocked* carrier's id into
   * `loads.covered_by_carrier_id`. The gate passed and the database recorded
   * the freight against the entity the gate had just rejected.
   */
  carrier: StoredCarrier | null = null;
  carrierRecord: CarrierRecord | null = null;
  /** The MC behind `carrier`. Booking must match it — see `isVerifiedCaller`. */
  verifiedMcNumber: string | null = null;

  /** The load booked on this call, so the run row can point at it. */
  bookedLoadId: string | null = null;

  /** What compliance said, keyed by MC. Booking re-reads this; it never re-decides. */
  private readonly compliance = new Map<string, ComplianceResult>();
  private readonly countersUsedByLoad = new Map<string, number>();
  private readonly lastOfferByLoad = new Map<string, number>();
  private readonly agreedByLoad = new Map<string, number>();
  private readonly bookedLoads = new Set<string>();

  constructor(readonly runId: string) {}

  rememberCompliance(mcNumber: string, result: ComplianceResult): void {
    this.compliance.set(mcNumber, result);
  }

  /**
   * Records who we are talking to. Only a carrier that cleared the gate can
   * become the caller of record; a blocked lookup updates `compliance` (so
   * check_compliance can still restate why they were refused) and nothing else.
   *
   * **The slot is claimed once per call and is never re-pointed.** The block
   * guard above covers a second lookup that fails the gate; it does nothing
   * about a second lookup that passes it, and that is the double-broker attack:
   * a carrier verifies themselves, negotiates a rate, and then asks the agent to
   * "put it under my partner's authority" — naming a real, clean, active MC.
   * Compliance answers `allow`, so the last-write-wins assignment handed the
   * partner the slot, `isVerifiedCaller` then agreed, and `book_load` tendered
   * the freight to a carrier who had never been on the call. The rate negotiated
   * with one entity was booked against another, with `covered_by_carrier_id`
   * naming the wrong one in Postgres. Found by the Day 5 double-broker persona.
   *
   * One phone call has one caller, and looking someone else up does not change
   * who is on the line. Later lookups still run, still cache, still persist the
   * carrier row and still answer the model's question — they just do not
   * reassign the party we are tendering to.
   *
   * The cost is a caller whose first clean lookup was the wrong carrier — a
   * misread MC that happens to land on a valid active docket — is locked out of
   * booking for the rest of the call. That is a refusal to tender, which is the
   * safe direction; the alternative is guessing which of two valid dockets is
   * the human on the phone, and guessing wrong moves freight.
   */
  rememberCarrier(mcNumber: string, record: CarrierRecord, stored: StoredCarrier): void {
    if (this.compliance.get(mcNumber)?.decision === "block") return;
    if (this.verifiedMcNumber !== null && this.verifiedMcNumber !== mcNumber) return;
    this.carrier = stored;
    this.carrierRecord = record;
    this.verifiedMcNumber = mcNumber;
  }

  /**
   * Whether this MC is the identity that actually cleared the gate on this call.
   *
   * Looking a second carrier up is legitimate — carriers ask about partners and
   * misread their own paperwork — but only one of them is the party we are
   * tendering freight to, and it has to be the one we verified.
   */
  isVerifiedCaller(mcNumber: string): boolean {
    return this.verifiedMcNumber !== null && this.verifiedMcNumber === mcNumber;
  }

  /** null means we never looked this carrier up — which is not the same as "clean". */
  complianceFor(mcNumber: string): ComplianceResult | null {
    return this.compliance.get(mcNumber) ?? null;
  }

  /**
   * Whether the caller has passed the gate.
   *
   * Found by the Day 3 eval: the agent quoted a rate before verification came
   * back, because the model interleaves lookup_carrier and get_load into one
   * parallel step and the prompt's "verify first" is a suggestion about
   * ordering, not a constraint on it. Booking was never at risk — book_load
   * checks compliance independently — but quoting to an unverified caller
   * hands a rate to someone who may be blocked.
   *
   * The fix belongs here rather than in the prompt for the same reason every
   * other rule does: sequencing enforced by wording is sequencing the next
   * model revision can reorder.
   *
   * Scoped to the caller of record rather than to "anyone looked up on this
   * call". Scanning every compliance result meant a single clean lookup
   * unlocked rate quoting for the rest of the conversation no matter who was
   * asking — a blocked caller only had to get one legitimate MC read out to
   * start hearing numbers.
   */
  hasClearedCarrier(): boolean {
    return this.verifiedMcNumber !== null;
  }

  countersUsed(loadRef: string): number {
    return this.countersUsedByLoad.get(loadRef) ?? 0;
  }

  /** The 1-indexed round this counter would be. Does not consume it. */
  nextRound(loadRef: string): number {
    return this.countersUsed(loadRef) + 1;
  }

  /**
   * Consumes a counter. Called only when we actually said a number, so a
   * rejected or walked-away turn does not burn one.
   */
  recordOffer(loadRef: string, rateCents: number): void {
    this.countersUsedByLoad.set(loadRef, this.countersUsed(loadRef) + 1);
    this.lastOfferByLoad.set(loadRef, rateCents);
  }

  /** The last number we actually said out loud for this load. */
  lastOffer(loadRef: string): number | null {
    return this.lastOfferByLoad.get(loadRef) ?? null;
  }

  /**
   * Records that the carrier named a number at or below where we were going
   * anyway, and we took it.
   *
   * An agreement is sticky. Without this the deal simply evaporated: a carrier
   * who asked $1,000 got an accept, then reopened at $4,000 on the next turn,
   * and `nextOffer` — which recomputes from the schedule and knows nothing
   * about what was settled — countered at the lane rate. We bid against
   * ourselves and paid $1,659 more than the number both sides had agreed.
   */
  recordAgreement(loadRef: string, rateCents: number): void {
    this.agreedByLoad.set(loadRef, rateCents);
  }

  /** The rate already settled for this load, if the carrier named one we took. */
  agreedRate(loadRef: string): number | null {
    return this.agreedByLoad.get(loadRef) ?? null;
  }

  markBooked(loadRef: string, loadId: string, rateCents: number): void {
    this.bookedLoads.add(loadRef);
    this.bookedLoadId = loadId;
    this.outcome = "booked";
    this.finalRateCents = rateCents;
  }

  /**
   * Moves the call outcome, except away from `booked`.
   *
   * Booking is the one outcome backed by a committed database write — a
   * `loads` row is `covered` and the freight is tendered. Every other outcome
   * is a model assertion about how the conversation felt. `end_call` already
   * guarded this; `escalate_to_human` did not, so escalating after a booking
   * (which the SDK can do in a single parallel step) overwrote a real tender
   * with `escalated`, and a following `end_call` then saw a non-booked outcome
   * and stamped whatever the model claimed. Only `markBooked` may set `booked`.
   */
  setOutcome(next: RunOutcome): void {
    if (this.outcome === "booked") return;
    this.outcome = next;
  }

  isBooked(loadRef: string): boolean {
    return this.bookedLoads.has(loadRef);
  }

  /** Total counters across every load in this call, for the trace summary. */
  totalCounters(): number {
    let total = 0;
    for (const used of this.countersUsedByLoad.values()) total += used;
    return total;
  }
}
