import { and, eq } from "drizzle-orm";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";

import * as schema from "@/db/schema";
import { carrierLookupCache } from "@/db/schema";

import type { CachedLookup, CarrierCacheStore } from "./cache";
import type { SourceId } from "./types";

/**
 * Postgres-backed cache store.
 *
 * `db` is a constructor argument rather than the `@/db` singleton import on
 * purpose: that module throws at load time when DATABASE_URL is unset, which
 * would make cache.ts unimportable in the test suite. Nothing in src/lib/carriers
 * may require a database to be reachable in order to be typechecked or tested.
 */

export type CacheDb = NeonHttpDatabase<typeof schema>;

export class DrizzleCacheStore implements CarrierCacheStore {
  constructor(private readonly db: CacheDb) {}

  async read(mcNumber: string, source: SourceId): Promise<CachedLookup | null> {
    const row = await this.db.query.carrierLookupCache.findFirst({
      where: and(
        eq(carrierLookupCache.mcNumber, mcNumber),
        eq(carrierLookupCache.source, source),
      ),
    });

    if (!row) return null;

    return {
      mcNumber: row.mcNumber,
      // The `source` column is plain text with no enum constraint, so casting
      // row.source would assert a union the database does not enforce. The query
      // already filtered on this exact value — return the one we know.
      source,
      found: row.found,
      payload: row.payload,
      fetchedAt: row.fetchedAt,
    };
  }

  /** Unique index is (mc_number, source), so a re-lookup refreshes in place. */
  async write(entry: CachedLookup): Promise<void> {
    await this.db
      .insert(carrierLookupCache)
      .values({
        mcNumber: entry.mcNumber,
        source: entry.source,
        found: entry.found,
        payload: entry.payload,
        fetchedAt: entry.fetchedAt,
      })
      .onConflictDoUpdate({
        target: [carrierLookupCache.mcNumber, carrierLookupCache.source],
        set: {
          found: entry.found,
          payload: entry.payload,
          fetchedAt: entry.fetchedAt,
        },
      });
  }
}
