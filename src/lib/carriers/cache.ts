import { parseMcNumber } from "./normalize";
import type { CarrierDataSource, LookupResult, SourceId } from "./types";

/**
 * Read-through cache for carrier lookups.
 *
 * The demo cannot depend on a live government API being up during an interview,
 * so every response is persisted and replayed. Cached payloads go back through
 * the source's own `normalize`, which means a cached lookup and a live lookup
 * produce an identical CarrierRecord — including the duplicate-MC resolution
 * ordering, which lives inside normalize for exactly this reason.
 */

export type CachedLookup = {
  mcNumber: string;
  source: SourceId;
  /** false = the API confirmed no such carrier. Distinct from "never asked". */
  found: boolean;
  payload: unknown;
  fetchedAt: Date;
};

export interface CarrierCacheStore {
  read(mcNumber: string, source: SourceId): Promise<CachedLookup | null>;
  write(entry: CachedLookup): Promise<void>;
}

export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export type ReadThroughOptions = {
  ttlMs?: number;
  now?: Date;
  /** Skip the cache read but still write the result. Used by the refresh path. */
  forceRefresh?: boolean;
  /** Called when the store misbehaves. Defaults to console.warn. */
  onCacheError?: (stage: "read" | "replay" | "write", error: unknown) => void;
};

/**
 * Look up a carrier, preferring cache.
 *
 * Failures are never cached. A 503 is a fact about the network at one moment,
 * not about the carrier, and persisting it would keep a real carrier blocked
 * for the whole TTL. `not_found` *is* cached — a nonexistent MC must not hammer
 * the API on every retry.
 */
export async function readThrough(
  rawMcNumber: string,
  source: CarrierDataSource,
  store: CarrierCacheStore,
  options: ReadThroughOptions = {},
): Promise<LookupResult & { cached: boolean }> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? new Date();
  const onCacheError =
    options.onCacheError ??
    ((stage, error) => console.warn(`[carrier-cache] ${stage} failed, continuing:`, error));

  // Canonicalize BEFORE touching the store. Callers hand us whatever the carrier
  // said on the phone ("MC-186800", " 00186800 "), but writes key on the parsed
  // record's mcNumber. Reading with the raw string made every dirty input a
  // permanent miss, which silently put a live government API call in the path of
  // every real lookup — the exact dependency the cache exists to remove.
  const mcNumber = parseMcNumber(rawMcNumber);
  if (mcNumber === null) {
    return {
      status: "error",
      mcNumber: String(rawMcNumber),
      message: `"${rawMcNumber}" is not a valid MC number`,
      cached: false,
    };
  }

  if (!options.forceRefresh) {
    // The cache is an optimization. A database blip must never take down a
    // carrier call — degrade to a live lookup instead. Caught for real: Neon
    // intermittently exceeded undici's connect timeout during Day 2
    // verification and crashed the whole lookup.
    // CarrierCacheStore is a public interface, so a store that round-trips
    // through JSON hands back fetchedAt as a string — .getTime() would throw
    // past the guard. That is why the freshness check is guarded too, below.
    let hit: CachedLookup | null = null;
    try {
      hit = await store.read(mcNumber, source.id);
    } catch (error) {
      onCacheError("read", error);
    }

    // Replay is a separate stage with its own error label. Folding it into the
    // read's catch would report a crash inside the *source's* normalize as a
    // database failure, sending whoever debugs it to Neon.
    try {
      if (hit !== null && isFresh(hit, now, ttlMs)) {
        const record = replay(hit, source);
        // A cached payload we can no longer normalize means the source's shape
        // changed. Fall through to a live lookup rather than serving a record we
        // cannot vouch for.
        if (record !== null) return { ...record, cached: true };
      }
    } catch (error) {
      onCacheError("replay", error);
    }
  }

  const result = await source.lookupByMc(mcNumber);

  const entry: CachedLookup | null =
    result.status === "found"
      ? {
          mcNumber: result.record.mcNumber,
          source: source.id,
          found: true,
          payload: result.raw,
          fetchedAt: now,
        }
      : result.status === "not_found"
        ? { mcNumber: result.mcNumber, source: source.id, found: false, payload: null, fetchedAt: now }
        : null;

  if (entry !== null) {
    // Likewise on the way out: failing to persist costs us a cache hit next
    // time, nothing more. It must not turn a good lookup into an error.
    try {
      await store.write(entry);
    } catch (error) {
      onCacheError("write", error);
    }
  }

  return { ...result, cached: false };
}

/**
 * A cached row counts as fresh only if its age is inside the TTL *and*
 * non-negative. A future-dated `fetchedAt` would otherwise read as fresh
 * forever. That is reachable here, not theoretical: this machine's clock runs
 * slow (docs/STATE.md) while a deployed instance writes to the same table, so
 * rows legitimately arrive dated ahead of the reader.
 */
function isFresh(hit: CachedLookup, now: Date, ttlMs: number): boolean {
  const ageMs = now.getTime() - hit.fetchedAt.getTime();
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < ttlMs;
}

function replay(hit: CachedLookup, source: CarrierDataSource): LookupResult | null {
  if (!hit.found) return { status: "not_found", mcNumber: hit.mcNumber };

  const record = source.normalize(hit.payload, hit.mcNumber);
  if (record === null) return null;

  return { status: "found", record, raw: hit.payload };
}

/** For tests and scripts. Production uses DrizzleCacheStore. */
export class InMemoryCacheStore implements CarrierCacheStore {
  private readonly entries = new Map<string, CachedLookup>();

  async read(mcNumber: string, source: SourceId): Promise<CachedLookup | null> {
    return this.entries.get(`${source}:${mcNumber}`) ?? null;
  }

  async write(entry: CachedLookup): Promise<void> {
    this.entries.set(`${entry.source}:${entry.mcNumber}`, entry);
  }

  get size(): number {
    return this.entries.size;
  }
}
