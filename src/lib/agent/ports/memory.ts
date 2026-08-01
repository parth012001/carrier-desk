import { buildLoads } from "@/db/loads-data";
import type { Load } from "@/db/schema";
import type { CarrierRecord } from "@/lib/carriers/types";

import type {
  CarrierStore,
  LoadStore,
  NegotiationSink,
  RunOutcome,
  RunSink,
  StoredCarrier,
} from "../types";

/**
 * In-memory ports, for tests and the eval harness.
 *
 * These are the reference implementations of the interfaces in types.ts. The
 * eval suite runs hundreds of turns through them, which is a second reason they
 * exist: a Day 5 run should not need a database, and should not be able to
 * corrupt one.
 */

/** Deterministic ids. A random uuid would make trace assertions unreproducible. */
function syntheticId(prefix: string, i: number): string {
  return `${prefix}-${String(i).padStart(4, "0")}`;
}

export class InMemoryLoadStore implements LoadStore {
  private readonly loads = new Map<string, Load>();

  constructor(loads: Load[]) {
    for (const load of loads) this.loads.set(load.ref, load);
  }

  /** The real 40-lane board, so tests exercise real rate policies. */
  static fromSeed(now = new Date("2026-08-01T00:00:00.000Z")): InMemoryLoadStore {
    return new InMemoryLoadStore(
      buildLoads(now).map((row, i) => ({
        id: syntheticId("load", i),
        ref: row.ref,
        originCity: row.originCity,
        originState: row.originState,
        destCity: row.destCity,
        destState: row.destState,
        equipment: row.equipment,
        weightLbs: row.weightLbs,
        miles: row.miles,
        commodity: row.commodity ?? null,
        pickupStart: row.pickupStart,
        pickupEnd: row.pickupEnd,
        deliveryStart: row.deliveryStart ?? null,
        deliveryEnd: row.deliveryEnd ?? null,
        rateMarketCents: row.rateMarketCents,
        rateFloorCents: row.rateFloorCents,
        rateCeilingCents: row.rateCeilingCents,
        status: row.status ?? "available",
        coveredByCarrierId: null,
        bookedRateCents: null,
        createdAt: now,
      })),
    );
  }

  async byRef(ref: string): Promise<Load | null> {
    return this.loads.get(ref) ?? null;
  }

  /**
   * Mirrors the Drizzle adapter's conditional update: the availability check
   * and the write are one step, so two calls cannot both book the same trailer.
   */
  async cover(input: {
    loadId: string;
    carrierId: string | null;
    bookedRateCents: number;
  }): Promise<boolean> {
    for (const load of this.loads.values()) {
      if (load.id !== input.loadId) continue;
      if (load.status !== "available") return false;

      this.loads.set(load.ref, {
        ...load,
        status: "covered",
        coveredByCarrierId: input.carrierId,
        bookedRateCents: input.bookedRateCents,
      });
      return true;
    }
    return false;
  }

  /** For assertions. Not part of the port. */
  snapshot(ref: string): Load | null {
    return this.loads.get(ref) ?? null;
  }
}

export class InMemoryCarrierStore implements CarrierStore {
  private readonly carriers = new Map<string, StoredCarrier>();

  async upsert(record: CarrierRecord): Promise<StoredCarrier> {
    const existing = this.carriers.get(record.mcNumber);
    const next: StoredCarrier = existing
      ? { ...existing, totalCalls: existing.totalCalls + 1 }
      : {
          id: syntheticId("carrier", this.carriers.size),
          mcNumber: record.mcNumber,
          totalCalls: 1,
          totalBooked: 0,
          lastRateAcceptedCents: null,
          memories: [],
        };

    this.carriers.set(record.mcNumber, next);
    return next;
  }

  snapshot(mcNumber: string): StoredCarrier | null {
    return this.carriers.get(mcNumber) ?? null;
  }
}

export class InMemoryNegotiationSink implements NegotiationSink {
  readonly entries: Parameters<NegotiationSink["record"]>[0][] = [];

  async record(entry: Parameters<NegotiationSink["record"]>[0]): Promise<void> {
    this.entries.push(entry);
  }
}

export class InMemoryRunSink implements RunSink {
  readonly finished: Parameters<RunSink["finish"]>[0][] = [];

  async finish(input: Parameters<RunSink["finish"]>[0]): Promise<void> {
    this.finished.push(input);
  }

  outcome(): RunOutcome | null {
    return this.finished.at(-1)?.outcome ?? null;
  }
}
