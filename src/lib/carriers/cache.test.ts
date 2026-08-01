import { describe, expect, it } from "vitest";

import activeFixture from "./__fixtures__/socrata/mc-186800.active.json";
import ambiguousFixture from "./__fixtures__/socrata/mc-143229.ambiguous.json";
import {
  DEFAULT_STALE_FALLBACK_MS,
  DEFAULT_TTL_MS,
  InMemoryCacheStore,
  readThrough,
} from "./cache";
import { SocrataCarrierSource } from "./socrata";
import type { CarrierDataSource, LookupResult } from "./types";

const NOW = new Date("2026-08-01T00:00:00.000Z");

/** Wraps a real source and counts how often the network layer would be hit. */
function countingSource(responder: (mc: string) => LookupResult): CarrierDataSource & {
  calls: number;
} {
  const socrata = new SocrataCarrierSource();
  return {
    calls: 0,
    id: socrata.id,
    capabilities: socrata.capabilities,
    async lookupByMc(mcNumber: string) {
      this.calls++;
      return responder(mcNumber);
    },
    normalize: (raw, mc) => socrata.normalize(raw, mc),
  };
}

function foundResult(): LookupResult {
  const record = new SocrataCarrierSource().normalize(activeFixture, "186800")!;
  return { status: "found", record, raw: activeFixture };
}

describe("readThrough", () => {
  it("calls the source once across two lookups", async () => {
    const source = countingSource(foundResult);
    const store = new InMemoryCacheStore();

    const first = await readThrough("186800", source, store, { now: NOW });
    const second = await readThrough("186800", source, store, { now: NOW });

    expect(source.calls).toBe(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(store.size).toBe(1);
  });

  it("returns an identical record from cache as from the wire", async () => {
    const source = countingSource(foundResult);
    const store = new InMemoryCacheStore();

    const live = await readThrough("186800", source, store, { now: NOW });
    const cached = await readThrough("186800", source, store, { now: NOW });

    expect(live.status).toBe("found");
    expect(cached.status).toBe("found");
    if (live.status !== "found" || cached.status !== "found") return;
    expect(cached.record).toEqual(live.record);
  });

  it("replays duplicate-MC resolution identically from cache", async () => {
    // The ordering that picks one of six entities lives inside normalize, so a
    // cache hit must land on the same DOT number as the live lookup. If it did
    // not, the same MC could be allowed on one call and blocked on the next.
    const source = countingSource(() => ({
      status: "found",
      record: new SocrataCarrierSource().normalize(ambiguousFixture, "143229")!,
      raw: ambiguousFixture,
    }));
    const store = new InMemoryCacheStore();

    const live = await readThrough("143229", source, store, { now: NOW });
    const cached = await readThrough("143229", source, store, { now: NOW });

    if (live.status !== "found" || cached.status !== "found") throw new Error("expected found");
    expect(cached.record.dotNumber).toBe("208293");
    expect(cached.record).toEqual(live.record);
  });

  it("caches not_found so a bogus MC does not hammer the API", async () => {
    const source = countingSource((mc) => ({ status: "not_found", mcNumber: mc }));
    const store = new InMemoryCacheStore();

    const first = await readThrough("9999999", source, store, { now: NOW });
    const second = await readThrough("9999999", source, store, { now: NOW });

    expect(source.calls).toBe(1);
    expect(first).toMatchObject({ status: "not_found", cached: false });
    expect(second).toMatchObject({ status: "not_found", cached: true });
  });

  it("never caches an error", async () => {
    // A 503 is a fact about the network at one moment, not about the carrier.
    // Persisting it would keep a legitimate carrier blocked for the whole TTL.
    const source = countingSource((mc) => ({
      status: "error",
      mcNumber: mc,
      message: "Socrata returned 503",
    }));
    const store = new InMemoryCacheStore();

    await readThrough("186800", source, store, { now: NOW });
    await readThrough("186800", source, store, { now: NOW });

    expect(source.calls).toBe(2);
    expect(store.size).toBe(0);
  });

  it("refetches once the entry is older than the TTL", async () => {
    const source = countingSource(foundResult);
    const store = new InMemoryCacheStore();

    await readThrough("186800", source, store, { now: NOW });

    const justInside = new Date(NOW.getTime() + DEFAULT_TTL_MS - 1);
    expect((await readThrough("186800", source, store, { now: justInside })).cached).toBe(true);
    expect(source.calls).toBe(1);

    const justOutside = new Date(NOW.getTime() + DEFAULT_TTL_MS);
    expect((await readThrough("186800", source, store, { now: justOutside })).cached).toBe(false);
    expect(source.calls).toBe(2);
  });

  it("honours a custom TTL", async () => {
    const source = countingSource(foundResult);
    const store = new InMemoryCacheStore();

    await readThrough("186800", source, store, { now: NOW, ttlMs: 60_000 });
    await readThrough("186800", source, store, {
      now: new Date(NOW.getTime() + 61_000),
      ttlMs: 60_000,
    });

    expect(source.calls).toBe(2);
  });

  it("bypasses the read but still writes when forceRefresh is set", async () => {
    const source = countingSource(foundResult);
    const store = new InMemoryCacheStore();

    await readThrough("186800", source, store, { now: NOW });
    const refreshed = await readThrough("186800", source, store, { now: NOW, forceRefresh: true });

    expect(source.calls).toBe(2);
    expect(refreshed.cached).toBe(false);
    expect(store.size).toBe(1);
  });

  it("falls back to a live lookup when a cached payload no longer normalizes", async () => {
    // Guards against serving a record we cannot vouch for if the upstream
    // payload shape changes under a cache entry.
    const source = countingSource(foundResult);
    const store = new InMemoryCacheStore();
    await store.write({
      mcNumber: "186800",
      source: "socrata",
      found: true,
      payload: { garbage: true },
      fetchedAt: NOW,
    });

    const result = await readThrough("186800", source, store, { now: NOW });

    expect(source.calls).toBe(1);
    expect(result.cached).toBe(false);
    expect(result.status).toBe("found");
  });

  it("survives a cache read failure by going to the source", async () => {
    // Regression: a transient Neon connect timeout crashed the whole lookup
    // during Day 2 live verification. The cache is an optimization — a database
    // blip must never take down a carrier call.
    const source = countingSource(foundResult);
    const errors: [string, unknown][] = [];
    const store = {
      read: async () => {
        throw new Error("ConnectTimeoutError");
      },
      write: async () => {},
    };

    const result = await readThrough("186800", source, store, {
      now: NOW,
      onCacheError: (stage, error) => errors.push([stage, error]),
    });

    expect(result.status).toBe("found");
    expect(result.cached).toBe(false);
    expect(source.calls).toBe(1);
    expect(errors.map(([stage]) => stage)).toEqual(["read"]);
  });

  it("survives a cache write failure and still returns the lookup", async () => {
    const source = countingSource(foundResult);
    const errors: [string, unknown][] = [];
    const store = {
      read: async () => null,
      write: async () => {
        throw new Error("ConnectTimeoutError");
      },
    };

    const result = await readThrough("186800", source, store, {
      now: NOW,
      onCacheError: (stage, error) => errors.push([stage, error]),
    });

    expect(result.status).toBe("found");
    expect(errors.map(([stage]) => stage)).toEqual(["write"]);
  });

  it("hits the cache when the caller passes a dirty MC number", async () => {
    // Regression: readThrough read with the caller's raw string but wrote under
    // the canonical one, so "MC-186800" — what a carrier actually says on the
    // phone — missed forever and put a live government API call in the path of
    // every real lookup.
    const source = countingSource(foundResult);
    const store = new InMemoryCacheStore();

    await readThrough("186800", source, store, { now: NOW });

    for (const dirty of ["MC-186800", "mc 186800", "  MC-00186800 ", "00186800"]) {
      const result = await readThrough(dirty, source, store, { now: NOW });
      expect(result.cached, `${dirty} should hit the cache`).toBe(true);
    }

    expect(source.calls).toBe(1);
    expect(store.size).toBe(1);
  });

  it("rejects an unparseable MC before touching the store or the source", async () => {
    const source = countingSource(foundResult);
    const store = new InMemoryCacheStore();

    const result = await readThrough("not-an-mc", source, store, { now: NOW });

    expect(result.status).toBe("error");
    expect(source.calls).toBe(0);
    expect(store.size).toBe(0);
  });

  it("treats a future-dated entry as stale, not as fresh forever", async () => {
    // Regression: the freshness check had no lower bound, so a negative age read
    // as fresh indefinitely. Reachable because this machine's clock runs slow
    // while a deployed instance writes to the same table.
    const source = countingSource(foundResult);
    const store = new InMemoryCacheStore();
    await store.write({
      mcNumber: "186800",
      source: "socrata",
      found: true,
      payload: activeFixture,
      fetchedAt: new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000),
    });

    const result = await readThrough("186800", source, store, { now: NOW });

    expect(result.cached).toBe(false);
    expect(source.calls).toBe(1);
  });

  it("survives a store that returns fetchedAt as a string", async () => {
    // CarrierCacheStore is a public interface; anything round-tripping through
    // JSON hands back a string. The freshness check must not throw past the guard.
    const source = countingSource(foundResult);
    const errors: string[] = [];
    const store = {
      read: async () =>
        ({
          mcNumber: "186800",
          source: "socrata",
          found: true,
          payload: activeFixture,
          fetchedAt: NOW.toISOString(),
        }) as never,
      write: async () => {},
    };

    const result = await readThrough("186800", source, store, {
      now: NOW,
      onCacheError: (stage) => errors.push(stage),
    });

    expect(result.status).toBe("found");
    // Reported as a replay failure, not a read failure — the store handed back a
    // row just fine; it was unusable once we tried to age it.
    expect(errors).toEqual(["replay"]);
  });

  it("labels a crash inside the source's normalize as replay, not as a DB fault", async () => {
    // Folding replay into the read's catch sent whoever debugs a source bug
    // straight to Neon.
    const source = { ...countingSource(foundResult), normalize: () => {
      throw new Error("source normalize blew up");
    } };
    const errors: string[] = [];
    const store = new InMemoryCacheStore();
    await store.write({
      mcNumber: "186800", source: "socrata", found: true,
      payload: activeFixture, fetchedAt: NOW,
    });

    const result = await readThrough("186800", source, store, {
      now: NOW,
      onCacheError: (stage) => errors.push(stage),
    });

    expect(errors).toEqual(["replay"]);
    expect(result.cached).toBe(false);
  });

  it("keys the cache by source as well as MC", async () => {
    const store = new InMemoryCacheStore();
    const socrata = countingSource(foundResult);
    const other = { ...countingSource(foundResult), id: "qcmobile" as const };

    await readThrough("186800", socrata, store, { now: NOW });
    const fromOther = await readThrough("186800", other, store, { now: NOW });

    expect(fromOther.cached).toBe(false);
    expect(store.size).toBe(2);
  });
});

/**
 * The degraded path: the live lookup failed, and the choice is between an old
 * record and no record. No record means LOOKUP_FAILED, which blocks the carrier
 * — so for a bounded window an old record is the better answer, provided it is
 * never served silently. See docs/DECISIONS.md #16.
 */
describe("readThrough — bounded staleness on a failed lookup", () => {
  const HOUR_MS = 60 * 60 * 1000;
  const erroringSource = () =>
    countingSource((mc) => ({ status: "error", mcNumber: mc, message: "Socrata timed out" }));

  /** Seeds a cache entry aged `ageMs` relative to NOW. */
  async function storeAged(ageMs: number): Promise<InMemoryCacheStore> {
    const store = new InMemoryCacheStore();
    await store.write({
      mcNumber: "186800",
      source: "socrata",
      found: true,
      payload: activeFixture,
      fetchedAt: new Date(NOW.getTime() - ageMs),
    });
    return store;
  }

  it("serves a past-TTL entry rather than failing the call", async () => {
    const source = erroringSource();
    const store = await storeAged(30 * HOUR_MS);

    const result = await readThrough("186800", source, store, { now: NOW });

    expect(result.status).toBe("found");
    expect(result.cached).toBe(true);
    expect(result.staleAgeMs).toBe(30 * HOUR_MS);
  });

  it("returns a record identical to a live one — staleness is metadata, not a different shape", async () => {
    const store = await storeAged(30 * HOUR_MS);
    const live = await readThrough("186800", countingSource(foundResult), new InMemoryCacheStore(), {
      now: NOW,
    });
    const stale = await readThrough("186800", erroringSource(), store, { now: NOW });

    if (live.status !== "found" || stale.status !== "found") throw new Error("expected found");
    expect(stale.record).toEqual(live.record);
  });

  it("refuses an entry older than the fallback cap", async () => {
    // Past the cap, "what we last saw" has stopped being evidence about what is
    // true now, and the honest answer is that we do not know.
    const source = erroringSource();
    const store = await storeAged(DEFAULT_STALE_FALLBACK_MS);

    const result = await readThrough("186800", source, store, { now: NOW });

    expect(result.status).toBe("error");
    expect(result.staleAgeMs).toBeUndefined();
  });

  it("serves an entry one millisecond inside the cap", async () => {
    const store = await storeAged(DEFAULT_STALE_FALLBACK_MS - 1);

    const result = await readThrough("186800", erroringSource(), store, { now: NOW });

    expect(result.status).toBe("found");
    expect(result.staleAgeMs).toBe(DEFAULT_STALE_FALLBACK_MS - 1);
  });

  it("honours a custom fallback cap", async () => {
    const store = await storeAged(30 * HOUR_MS);

    const roomy = await readThrough("186800", erroringSource(), store, {
      now: NOW,
      staleFallbackMs: 31 * HOUR_MS,
    });

    expect(roomy.status).toBe("found");
    expect(roomy.staleAgeMs).toBe(30 * HOUR_MS);

    const tighter = await readThrough("186800", erroringSource(), store, {
      now: NOW,
      staleFallbackMs: 29 * HOUR_MS,
    });

    expect(tighter.status).toBe("error");
  });

  it("does not flag staleness when the fallback lands inside the TTL", async () => {
    // forceRefresh skipped a perfectly good entry and the live call then failed.
    // That record is current. Calling it stale would be its own small lie, and
    // the flag it raises is one the agent reads aloud.
    const store = await storeAged(1 * HOUR_MS);

    const result = await readThrough("186800", erroringSource(), store, {
      now: NOW,
      forceRefresh: true,
    });

    expect(result.status).toBe("found");
    expect(result.cached).toBe(true);
    expect(result.staleAgeMs).toBeUndefined();
  });

  it("does not fall back on not_found — a real answer is not overridden by an old one", async () => {
    // not_found comes from a reachable API saying the registry has no such
    // carrier. Quietly serving an older record would resurrect an entity FMCSA
    // says does not exist.
    const source = countingSource((mc) => ({ status: "not_found", mcNumber: mc }));
    const store = await storeAged(30 * HOUR_MS);

    const result = await readThrough("186800", source, store, { now: NOW });

    expect(result.status).toBe("not_found");
    expect(result.staleAgeMs).toBeUndefined();
  });

  it("refuses a future-dated entry on the degraded path too", async () => {
    // Same reasoning as the freshness check: this machine's clock runs slow
    // while a deployed instance writes to the same table.
    const source = erroringSource();
    const store = await storeAged(-30 * HOUR_MS);

    const result = await readThrough("186800", source, store, { now: NOW });

    expect(result.status).toBe("error");
  });

  it("returns the original error when nothing is cached", async () => {
    const result = await readThrough("186800", erroringSource(), new InMemoryCacheStore(), {
      now: NOW,
    });

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.message).toContain("Socrata timed out");
  });

  it("returns the original error when the stale payload no longer normalizes", async () => {
    const store = new InMemoryCacheStore();
    await store.write({
      mcNumber: "186800",
      source: "socrata",
      found: true,
      payload: { garbage: true },
      fetchedAt: new Date(NOW.getTime() - 30 * HOUR_MS),
    });

    const result = await readThrough("186800", erroringSource(), store, { now: NOW });

    expect(result.status).toBe("error");
  });

  it("reads the store once, not twice, when the fresh check misses and the lookup fails", async () => {
    // The degraded path runs precisely when the network is already unhappy.
    // A second round trip to Neon on that request is the wrong instinct.
    const inner = await storeAged(30 * HOUR_MS);
    let reads = 0;
    const store = {
      read: async (mc: string, src: "socrata" | "qcmobile") => {
        reads++;
        return inner.read(mc, src);
      },
      write: inner.write.bind(inner),
    };

    const result = await readThrough("186800", erroringSource(), store, { now: NOW });

    expect(result.status).toBe("found");
    expect(reads).toBe(1);
  });
});
