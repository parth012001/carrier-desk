import { describe, expect, it } from "vitest";

import activeFixture from "./__fixtures__/socrata/mc-186800.active.json";
import ambiguousFixture from "./__fixtures__/socrata/mc-143229.ambiguous.json";
import { DEFAULT_TTL_MS, InMemoryCacheStore, readThrough } from "./cache";
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
