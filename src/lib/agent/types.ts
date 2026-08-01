import type { Load } from "@/db/schema";
import type { CarrierCacheStore } from "@/lib/carriers/cache";
import type { CarrierDataSource, CarrierRecord } from "@/lib/carriers/types";

import type { TraceSink } from "./trace";

/**
 * The ports the agent runs against.
 *
 * Nothing under `src/lib/agent` or `src/lib/tools` may import `@/db`: that
 * module throws at load time when DATABASE_URL is unset, so importing it makes
 * a file untestable. `DrizzleCacheStore` already solved this by taking `db` as
 * a constructor argument; the tool layer follows the same rule, and the only
 * file that touches a database is `ports/drizzle.ts`.
 *
 * Everything here is write-mostly. The *working* state of a call — how many
 * counters we have made, what compliance said — lives in CallState, in memory.
 * The database is the record of a call, not its working memory.
 */

/** in_progress is the starting state; the rest are terminal. */
export type RunOutcome =
  | "in_progress"
  | "booked"
  | "rejected"
  | "blocked"
  | "escalated"
  | "abandoned";

export interface LoadStore {
  byRef(ref: string): Promise<Load | null>;
  /**
   * Marks a load covered. Returns false if someone else took it first — a
   * check-then-write would let two concurrent calls both book the same trailer,
   * so the decision has to be made where the write happens.
   */
  cover(input: {
    loadId: string;
    carrierId: string | null;
    bookedRateCents: number;
  }): Promise<boolean>;
}

export interface CarrierStore {
  /** Creates or refreshes the carrier row from a real FMCSA record. */
  upsert(record: CarrierRecord): Promise<StoredCarrier>;
}

export type StoredCarrier = {
  id: string;
  mcNumber: string;
  /** Bumped on every call. This is what makes call #2 different from call #1. */
  totalCalls: number;
  totalBooked: number;
  lastRateAcceptedCents: number | null;
  memories: string[];
};

export interface NegotiationSink {
  /** Every offer and counter, so we can prove afterwards that policy held. */
  record(entry: {
    runId: string;
    loadId: string | null;
    turn: number;
    carrierAskedCents: number | null;
    agentOfferedCents: number | null;
    accepted: boolean;
  }): Promise<void>;
}

export interface RunSink {
  finish(input: {
    runId: string;
    outcome: RunOutcome;
    finalRateCents: number | null;
    carrierId: string | null;
    loadId: string | null;
  }): Promise<void>;
}

export type AgentDeps = {
  /** Where carrier identity comes from. Socrata today, QCMobile behind the same interface. */
  source: CarrierDataSource;
  cache: CarrierCacheStore;
  carriers: CarrierStore;
  loads: LoadStore;
  negotiations: NegotiationSink;
  runs: RunSink;
  trace: TraceSink;
  /**
   * Injected rather than read from the clock. Compliance takes a `now` for the
   * same reason: this machine's clock runs ~2.5 days slow, and a rule that
   * reads the system clock in a test is a rule that fails on a Tuesday.
   */
  now: () => Date;
};

export type { CarrierRecord, CarrierDataSource, CarrierCacheStore, Load };
