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

  /** The verified carrier, once one has passed a lookup. */
  carrier: StoredCarrier | null = null;
  carrierRecord: CarrierRecord | null = null;

  /** What compliance said, keyed by MC. Booking re-reads this; it never re-decides. */
  private readonly compliance = new Map<string, ComplianceResult>();
  private readonly countersUsedByLoad = new Map<string, number>();
  private readonly lastOfferByLoad = new Map<string, number>();
  private readonly bookedLoads = new Set<string>();

  constructor(readonly runId: string) {}

  rememberCompliance(mcNumber: string, result: ComplianceResult): void {
    this.compliance.set(mcNumber, result);
  }

  /** null means we never looked this carrier up — which is not the same as "clean". */
  complianceFor(mcNumber: string): ComplianceResult | null {
    return this.compliance.get(mcNumber) ?? null;
  }

  /**
   * Whether anyone on this call has passed the gate.
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
   */
  hasClearedCarrier(): boolean {
    for (const result of this.compliance.values()) {
      if (result.decision !== "block") return true;
    }
    return false;
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

  markBooked(loadRef: string, rateCents: number): void {
    this.bookedLoads.add(loadRef);
    this.outcome = "booked";
    this.finalRateCents = rateCents;
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
