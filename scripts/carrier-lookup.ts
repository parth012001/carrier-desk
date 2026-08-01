import { config } from "dotenv";
config({ path: ".env.local" });

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

import { DrizzleCacheStore } from "../src/lib/carriers/cache-drizzle";
import { readThrough } from "../src/lib/carriers/cache";
import { evaluateLookup } from "../src/lib/carriers/compliance";
import { SocrataCarrierSource } from "../src/lib/carriers/socrata";
import * as schema from "../src/db/schema";

/**
 * Runs a real carrier lookup end to end: live Socrata -> Postgres cache ->
 * compliance gate. This is the ONLY place the live API and Neon are exercised;
 * `pnpm test` never touches either.
 *
 *   pnpm carrier:lookup 186800
 *   pnpm carrier:lookup 186800 --refresh
 *
 * Run it twice on the same MC to see the second come back cached.
 */

const DECISION_STYLE = {
  allow: "\x1b[32mALLOW\x1b[0m",
  flag: "\x1b[33mFLAG\x1b[0m",
  block: "\x1b[31mBLOCK\x1b[0m",
} as const;

const SEVERITY_MARK = { block: "✗", flag: "!", info: "·" } as const;

async function main() {
  const args = process.argv.slice(2);
  const mcNumber = args.find((a) => !a.startsWith("--"));
  const forceRefresh = args.includes("--refresh");

  if (!mcNumber) {
    console.error("usage: pnpm carrier:lookup <mcNumber> [--refresh]");
    process.exit(1);
  }

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.");
    process.exit(1);
  }

  const db = drizzle(neon(process.env.DATABASE_URL), { schema });
  const source = new SocrataCarrierSource({ appToken: process.env.SOCRATA_APP_TOKEN });
  const store = new DrizzleCacheStore(db);

  const startedAt = Date.now();
  const result = await readThrough(mcNumber, source, store, { forceRefresh });
  const elapsedMs = Date.now() - startedAt;

  console.log(
    `\nMC-${mcNumber} via ${source.id} — ${result.cached ? "cache hit" : "live"} in ${elapsedMs}ms`,
  );

  if (result.status === "found") {
    const r = result.record;
    console.log(`  ${r.legalName}${r.dbaName ? ` (dba ${r.dbaName})` : ""}`);
    console.log(`  DOT ${r.dotNumber ?? "—"} · ${r.phone ?? "no phone on file"}`);
    console.log(
      `  authority ${r.authorityStatus} · rating ${r.safetyRating ?? "unrated"} · ` +
        `${r.powerUnits ?? "?"} power units · for-hire ${r.authorizedForHire ?? "unknown"}`,
    );
    console.log(
      `  authority granted ${r.authorityGrantedAt?.toISOString().slice(0, 10) ?? "unknown"} · ` +
        `out of service ${r.isOutOfService ?? "not verifiable by this source"}`,
    );
    if (r.ambiguousWith.length > 0) {
      console.log(`  also matches DOT ${r.ambiguousWith.join(", ")}`);
    }
  } else if (result.status === "not_found") {
    console.log("  no FMCSA record");
  } else {
    console.log(`  lookup failed: ${result.message}`);
  }

  const compliance = evaluateLookup(result);
  console.log(`\n  ${DECISION_STYLE[compliance.decision]}`);
  for (const reason of compliance.reasons) {
    console.log(`    ${SEVERITY_MARK[reason.severity]} ${reason.code}: ${reason.message}`);
  }
  console.log();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
