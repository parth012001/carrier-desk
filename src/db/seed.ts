import { config } from "dotenv";
config({ path: ".env.local" });

import { neon } from "@neondatabase/serverless";
import { getTableColumns, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";
import { buildLoads, reseededLoadColumns } from "./loads-data";
import * as schema from "./schema";
import { loads } from "./schema";

/**
 * Writes the load board. The lanes and their pricing live in loads-data.ts,
 * which is importable without a database — this file is only the I/O.
 *
 * Carriers are deliberately NOT seeded. They get created from real FMCSA data
 * on first lookup; the whole point of this project is that carrier identity is
 * real, not invented.
 *
 * **Upsert on `ref`, never delete-then-insert.** `negotiations.load_id` and
 * `runs.load_id` are foreign keys into this table with no ON DELETE clause, and
 * this branch is the first to write them — so the moment any real conversation
 * counters or books, `DELETE FROM loads` aborts on a foreign key violation and
 * the board can no longer be reset before a demo. Keeping the rows and
 * overwriting them in place preserves the ids those children point at.
 *
 * It is also one statement rather than two, so there is no window where the
 * board is empty and no way for a failed insert to leave it that way.
 */

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.");
  }

  const db = drizzle(neon(process.env.DATABASE_URL), { schema });

  const rows = buildLoads(new Date());

  // Every column except the identity ones takes the value it would have been
  // inserted with. Derived from the table rather than listed, so adding a
  // column cannot silently start being skipped on a re-seed. `status`,
  // `covered_by_carrier_id` and `booked_rate_cents` come back to their seed
  // values that way too, which is what makes this a board reset and not just a
  // pricing refresh.
  // Keyed by the Drizzle property name, valued by the underlying column name:
  // `set` speaks TypeScript, `excluded` speaks SQL.
  const columns = getTableColumns(loads);
  const refreshed = Object.fromEntries(
    reseededLoadColumns().map((key) => [
      key,
      sql`excluded.${sql.identifier(columns[key as keyof typeof columns].name)}`,
    ]),
  );

  await db.insert(loads).values(rows).onConflictDoUpdate({
    target: loads.ref,
    set: refreshed,
  });

  const cheapest = rows.reduce((a, b) => (a.rateMarketCents! < b.rateMarketCents! ? a : b));
  const priciest = rows.reduce((a, b) => (a.rateMarketCents! > b.rateMarketCents! ? a : b));

  console.log(`Seeded ${rows.length} loads.`);
  console.log(
    `  cheapest: ${cheapest.ref} ${cheapest.originCity}→${cheapest.destCity} ` +
      `$${(cheapest.rateMarketCents! / 100).toFixed(2)} (${cheapest.miles} mi)`,
  );
  console.log(
    `  priciest: ${priciest.ref} ${priciest.originCity}→${priciest.destCity} ` +
      `$${(priciest.rateMarketCents! / 100).toFixed(2)} (${priciest.miles} mi)`,
  );
  console.log("Carriers intentionally not seeded — they come from real FMCSA lookups.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
