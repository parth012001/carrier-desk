import { and, eq, max, sql } from "drizzle-orm";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";

import * as schema from "@/db/schema";
import { carriers, loads, negotiations, runEvents, runs } from "@/db/schema";
import type { Load } from "@/db/schema";
import type { CarrierRecord } from "@/lib/carriers/types";

import type { TraceEventInput, TraceSink } from "../trace";
import type {
  CarrierStore,
  LoadStore,
  NegotiationSink,
  RunSink,
  StoredCarrier,
} from "../types";

/**
 * The Drizzle-backed ports. **This is the only file under src/lib/agent that
 * touches a database**, and it takes `db` as a constructor argument rather than
 * importing the `@/db` singleton — that module throws at load time when
 * DATABASE_URL is unset, which would make everything downstream of it
 * untestable. Same rule DrizzleCacheStore already follows.
 */

export type AgentDb = NeonHttpDatabase<typeof schema>;

export class DrizzleLoadStore implements LoadStore {
  constructor(private readonly db: AgentDb) {}

  async byRef(ref: string): Promise<Load | null> {
    const row = await this.db.query.loads.findFirst({ where: eq(loads.ref, ref) });
    return row ?? null;
  }

  /**
   * The availability check and the write are one statement.
   *
   * A read-then-write would let two calls that both saw "available" each book
   * the same trailer — and unlike most races this one ends with two drivers at
   * one dock. The `status = 'available'` predicate lives in the WHERE clause so
   * the database decides, and `returning()` tells us who won.
   */
  async cover(input: {
    loadId: string;
    carrierId: string | null;
    bookedRateCents: number;
  }): Promise<boolean> {
    const updated = await this.db
      .update(loads)
      .set({
        status: "covered",
        coveredByCarrierId: input.carrierId,
        bookedRateCents: input.bookedRateCents,
      })
      .where(and(eq(loads.id, input.loadId), eq(loads.status, "available")))
      .returning({ id: loads.id });

    return updated.length === 1;
  }
}

export class DrizzleCarrierStore implements CarrierStore {
  constructor(private readonly db: AgentDb) {}

  /**
   * Writes the compliance snapshot exactly as the source reported it —
   * including nulls.
   *
   * `isOutOfService` is `boolean | null` where null means "this source cannot
   * determine it" (docs/DECISIONS.md #10). The column was `NOT NULL DEFAULT
   * false` until this commit, which would have persisted every keyless Socrata
   * lookup as "checked, not out of service" — a claim about a question that was
   * never asked. Coalescing here would reintroduce the same bug in code after
   * fixing it in the schema.
   */
  async upsert(record: CarrierRecord): Promise<StoredCarrier> {
    const snapshot = {
      dotNumber: record.dotNumber,
      legalName: record.legalName,
      dbaName: record.dbaName,
      phone: record.phone,
      authorityStatus: record.authorityStatus,
      isOutOfService: record.isOutOfService,
      safetyRating: record.safetyRating,
      powerUnits: record.powerUnits,
      authorizedForHire: record.authorizedForHire,
      priorRevocation: record.priorRevocation,
      lastSource: record.source,
      lastSeenAt: new Date(),
    };

    const [row] = await this.db
      .insert(carriers)
      .values({ mcNumber: record.mcNumber, ...snapshot, totalCalls: 1 })
      .onConflictDoUpdate({
        target: carriers.mcNumber,
        set: {
          ...snapshot,
          // Incremented in SQL, not read-modify-written in JS: two concurrent
          // calls from the same carrier would otherwise both write the same
          // number and one call would vanish from the count.
          totalCalls: sql`${carriers.totalCalls} + 1`,
        },
      })
      .returning();

    return {
      id: row.id,
      mcNumber: row.mcNumber,
      totalCalls: row.totalCalls,
      totalBooked: row.totalBooked,
      lastRateAcceptedCents: row.lastRateAcceptedCents,
      memories: row.memories,
    };
  }
}

export class DrizzleNegotiationSink implements NegotiationSink {
  constructor(private readonly db: AgentDb) {}

  async record(entry: Parameters<NegotiationSink["record"]>[0]): Promise<void> {
    await this.db.insert(negotiations).values(entry);
  }
}

export class DrizzleRunSink implements RunSink {
  constructor(private readonly db: AgentDb) {}

  async start(input: Parameters<RunSink["start"]>[0]): Promise<string> {
    const [row] = await this.db
      .insert(runs)
      .values({
        mcClaimed: input.mcClaimed,
        isEval: input.isEval,
        evalPersona: input.evalPersona,
        channel: "chat",
        outcome: "in_progress",
      })
      .returning({ id: runs.id });

    return row.id;
  }

  async finish(input: Parameters<RunSink["finish"]>[0]): Promise<void> {
    await this.db
      .update(runs)
      .set({
        outcome: input.outcome,
        finalRateCents: input.finalRateCents,
        carrierId: input.carrierId,
        loadId: input.loadId,
        endedAt: new Date(),
      })
      .where(eq(runs.id, input.runId));
  }
}

/**
 * Writes the trace to `run_events`.
 *
 * Sequence numbers are assigned here rather than by callers, for the same
 * reason InMemoryTraceSink does it: it is the only place that can hand out a
 * number no other writer will use. Writes are awaited in order so the sequence
 * a reader sees matches the order things happened — a trace whose rows arrive
 * out of order is worse than one that is slightly slower to write.
 *
 * **Numbering starts from what is already stored, not from zero — and this is
 * hardening, not a repair.** No shipped path builds two sinks for one run:
 * `startCall` builds one per call and the turn route reuses that instance, and
 * a missing session is a 409 rather than a rebuild, so a second sink for a
 * given `runId` is not constructible today. An in-process counter would still
 * be correct.
 *
 * It will not stay that way. Day 7 owes a durable `SessionStore`, and the point
 * of that store is that a call survives the process that started it — at which
 * moment a second sink for one run is not just constructible but ordinary, and
 * a counter starting at 0 would collide with rows already in the table. A crash
 * and restart mid-call reaches the same place today. Resolving from `max(seq)`
 * costs one read per call and removes the assumption rather than documenting
 * it; `(run_id, seq)` is a unique index, so a collision would be a failed
 * insert and a hole in the trace rather than two rows claiming one position.
 */
export class DrizzleTraceSink implements TraceSink {
  /** Resolves to the next unused seq. Null until the first write asks. */
  private nextSeq: Promise<number> | null = null;

  constructor(
    private readonly db: AgentDb,
    private readonly runId: string,
  ) {}

  /**
   * Hands out the next sequence number.
   *
   * The advance is synchronous even though the value is a promise, which is
   * what makes it safe under concurrency: the model issues tool calls in
   * parallel within a step, so two `write` calls genuinely do overlap, and a
   * read-then-increment would hand both the same number.
   */
  private reserve(): Promise<number> {
    const current = this.nextSeq ?? this.readNextSeq();
    const advanced = current.then((seq) => seq + 1);
    // If `current` rejects then so does `advanced`, and `readNextSeq` has
    // already cleared the chain — so nothing will ever await it. Mark it
    // handled: a dropped trace row must not surface as an unhandled rejection
    // and take the process down. Anyone still holding it gets the rejection.
    advanced.catch(() => {});
    this.nextSeq = advanced;
    return current;
  }

  private async readNextSeq(): Promise<number> {
    try {
      const [row] = await this.db
        .select({ highest: max(runEvents.seq) })
        .from(runEvents)
        .where(eq(runEvents.runId, this.runId));
      return (row?.highest ?? -1) + 1;
    } catch (error) {
      // Never guess. Numbering from 0 after a failed read is precisely the
      // duplicate this method exists to prevent, and `(run_id, seq)` is unique
      // now, so a guess would be rejected anyway. Clearing the chain lets the
      // next row retry instead of inheriting a rejected promise for the rest
      // of the call; `writeTrace` drops and logs this one.
      this.nextSeq = null;
      throw error;
    }
  }

  async write(event: TraceEventInput): Promise<void> {
    const seq = await this.reserve();
    await this.db.insert(runEvents).values({
      runId: this.runId,
      seq,
      type: event.type,
      name: event.name ?? null,
      // jsonb columns; undefined would drop the key entirely, and a trace with
      // a missing `args` reads as "no arguments" rather than "not recorded".
      args: event.args ?? null,
      result: event.result ?? null,
      durationMs: event.durationMs ?? null,
    });
  }
}
