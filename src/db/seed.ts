import { config } from "dotenv";
config({ path: ".env.local" });

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { buildLoads } from "./loads-data";
import * as schema from "./schema";
import { loads } from "./schema";

/**
 * Writes the load board. The lanes and their pricing live in loads-data.ts,
 * which is importable without a database — this file is only the I/O.
 *
 * Carriers are deliberately NOT seeded. They get created from real FMCSA data
 * on first lookup; the whole point of this project is that carrier identity is
 * real, not invented.
 */

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.");
  }

  const db = drizzle(neon(process.env.DATABASE_URL), { schema });

  const rows = buildLoads(new Date());
  await db.delete(loads);
  await db.insert(loads).values(rows);

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
