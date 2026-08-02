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

/**
 * How far past the TTL a cached entry may be served when the live lookup fails.
 *
 * Two thresholds, not one. The TTL governs the happy path: inside it, the cache
 * is simply the answer. This governs the degraded path: when a government API
 * times out, an FMCSA record from last Tuesday is a far better basis for a
 * compliance decision than no record at all, and authority status does not
 * usually turn over inside a week. Past the cap we stop guessing and let the
 * gate block, because at some age "what we last saw" stops being evidence about
 * what is true now.
 *
 * The staleness is never silent: the caller gets `staleAgeMs` and the gate
 * raises STALE_LOOKUP. See docs/DECISIONS.md #16.
 */
export const DEFAULT_STALE_FALLBACK_MS = 7 * 24 * 60 * 60 * 1000;

export type ReadThroughOptions = {
  ttlMs?: number;
  now?: Date;
  /** Skip the cache read but still write the result. Used by the refresh path. */
  forceRefresh?: boolean;
  /** Max age of a cache entry served after a failed live lookup. */
  staleFallbackMs?: number;
  /** Called when the store misbehaves. Defaults to console.warn. */
  onCacheError?: (stage: "read" | "replay" | "write", error: unknown) => void;
};

export type ReadThroughResult = LookupResult & {
  cached: boolean;
  /**
   * Age of the served payload, set ONLY when the live lookup failed and a
   * past-TTL entry was used instead. Absent on the happy path and absent when
   * the fallback happened to land on a still-fresh entry — that data is not
   * stale, so claiming it was would be its own kind of lie.
   */
  staleAgeMs?: number;
};

/**
 * Look up a carrier, preferring cache.
 *
 * Failures are never cached. A 503 is a fact about the network at one moment,
 * not about the carrier, and persisting it would keep a real carrier blocked
 * for the whole TTL. `not_found` *is* cached — a nonexistent MC must not hammer
 * the API on every retry.
 *
 * A failure does, however, get to *read* the cache: see the degraded path below.
 */
export async function readThrough(
  rawMcNumber: string,
  source: CarrierDataSource,
  store: CarrierCacheStore,
  options: ReadThroughOptions = {},
): Promise<ReadThroughResult> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const staleFallbackMs = options.staleFallbackMs ?? DEFAULT_STALE_FALLBACK_MS;
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

  // The cache is an optimization. A database blip must never take down a
  // carrier call — degrade to a live lookup instead. Caught for real: Neon
  // intermittently exceeded undici's connect timeout during Day 2 verification
  // and crashed the whole lookup.
  // CarrierCacheStore is a public interface, so a store that round-trips
  // through JSON hands back fetchedAt as a string — .getTime() would throw
  // past the guard. That is why every age check below sits inside a try.
  //
  // Memoized because the degraded path may want the same row the fresh path
  // already fetched, and a second round trip to Neon on the exact request where
  // the network is already unhappy is the wrong instinct.
  let hit: CachedLookup | null = null;
  let hitLoaded = false;
  const loadHit = async (): Promise<CachedLookup | null> => {
    if (hitLoaded) return hit;
    hitLoaded = true;
    try {
      hit = await store.read(mcNumber, source.id);
    } catch (error) {
      onCacheError("read", error);
      hit = null;
    }
    return hit;
  };

  if (!options.forceRefresh) {
    const fresh = await loadHit();

    // Replay is a separate stage with its own error label. Folding it into the
    // read's catch would report a crash inside the *source's* normalize as a
    // database failure, sending whoever debugs it to Neon.
    try {
      if (fresh !== null && isFresh(fresh, now, ttlMs)) {
        const record = replay(fresh, source);
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

  // Degraded path. The live lookup failed — a timeout, a 503, a DNS blip — and
  // the alternative to serving something old is serving nothing, which the gate
  // turns into LOOKUP_FAILED and a blocked carrier. Bounded, and never silent:
  // `staleAgeMs` rides back out and becomes a STALE_LOOKUP flag.
  //
  // Deliberately `error` only. `not_found` is a real answer from a reachable
  // API, and quietly overriding it with an older record would resurrect a
  // carrier the registry says does not exist.
  if (result.status === "error") {
    const stale = await loadHit();
    if (stale !== null) {
      try {
        const ageMs = ageOf(stale, now);
        // A future-dated row is rejected here for the same reason isFresh
        // rejects it: this machine's clock runs slow while a deployed instance
        // writes to the same table, so negative ages are reachable, not theoretical.
        if (ageMs !== null && ageMs >= 0 && ageMs < staleFallbackMs) {
          const record = replay(stale, source);
          if (record !== null) {
            // Inside the TTL this is not a fallback at all — forceRefresh
            // skipped a perfectly good entry and the live call then failed.
            // The data is current; do not flag it as stale.
            return ageMs < ttlMs
              ? { ...record, cached: true }
              : { ...record, cached: true, staleAgeMs: ageMs };
          }
        }
      } catch (error) {
        onCacheError("replay", error);
      }
    }
  }

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
 * Age of a cached row, or null when it cannot be computed.
 *
 * Throws rather than returning null when `fetchedAt` is not a Date — a store
 * that round-trips through JSON hands back a string, and callers run this
 * inside the replay try/catch so that surfaces as a replay failure rather than
 * silently reading as "unknown age".
 */
function ageOf(hit: CachedLookup, now: Date): number | null {
  const ageMs = now.getTime() - hit.fetchedAt.getTime();
  return Number.isFinite(ageMs) ? ageMs : null;
}

/**
 * A cached row counts as fresh only if its age is inside the TTL *and*
 * non-negative. A future-dated `fetchedAt` would otherwise read as fresh
 * forever. That is reachable here, not theoretical: this machine's clock runs
 * slow (docs/STATE.md) while a deployed instance writes to the same table, so
 * rows legitimately arrive dated ahead of the reader.
 */
function isFresh(hit: CachedLookup, now: Date, ttlMs: number): boolean {
  const ageMs = ageOf(hit, now);
  return ageMs !== null && ageMs >= 0 && ageMs < ttlMs;
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
