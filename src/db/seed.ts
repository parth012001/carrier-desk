import { config } from "dotenv";
config({ path: ".env.local" });

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";
import { loads, type NewLoad } from "./schema";

/**
 * Seeds the load board with 40 real freight lanes.
 *
 * Carriers are deliberately NOT seeded — they get created from real FMCSA data on Day 2.
 * The whole point of this project is that carrier identity is real, not invented.
 *
 * Rates are deterministic (no Math.random) so the demo is reproducible.
 */

type Lane = {
  from: [city: string, state: string];
  to: [city: string, state: string];
  miles: number;
  equipment: "dry_van" | "reefer" | "flatbed";
  commodity: string;
  weightLbs: number;
};

const LANES: Lane[] = [
  { from: ["Laredo", "TX"], to: ["Chicago", "IL"], miles: 1380, equipment: "dry_van", commodity: "Auto parts", weightLbs: 42000 },
  { from: ["Ontario", "CA"], to: ["Dallas", "TX"], miles: 1440, equipment: "dry_van", commodity: "Consumer goods", weightLbs: 38500 },
  { from: ["Atlanta", "GA"], to: ["Miami", "FL"], miles: 660, equipment: "reefer", commodity: "Frozen poultry", weightLbs: 43500 },
  { from: ["Chicago", "IL"], to: ["Atlanta", "GA"], miles: 715, equipment: "dry_van", commodity: "Packaged food", weightLbs: 40000 },
  { from: ["Los Angeles", "CA"], to: ["Phoenix", "AZ"], miles: 373, equipment: "dry_van", commodity: "Retail freight", weightLbs: 36000 },
  { from: ["Dallas", "TX"], to: ["Houston", "TX"], miles: 240, equipment: "flatbed", commodity: "Structural steel", weightLbs: 47000 },
  { from: ["Memphis", "TN"], to: ["Dallas", "TX"], miles: 470, equipment: "dry_van", commodity: "Paper products", weightLbs: 39000 },
  { from: ["Harrisburg", "PA"], to: ["Chicago", "IL"], miles: 660, equipment: "dry_van", commodity: "Packaged beverages", weightLbs: 44000 },
  { from: ["Newark", "NJ"], to: ["Charlotte", "NC"], miles: 610, equipment: "dry_van", commodity: "General merchandise", weightLbs: 37500 },
  { from: ["Seattle", "WA"], to: ["Portland", "OR"], miles: 175, equipment: "reefer", commodity: "Fresh seafood", weightLbs: 34000 },
  { from: ["Denver", "CO"], to: ["Salt Lake City", "UT"], miles: 525, equipment: "dry_van", commodity: "Building supplies", weightLbs: 41000 },
  { from: ["Kansas City", "MO"], to: ["Chicago", "IL"], miles: 510, equipment: "reefer", commodity: "Boxed beef", weightLbs: 44500 },
  { from: ["Indianapolis", "IN"], to: ["Columbus", "OH"], miles: 175, equipment: "dry_van", commodity: "Auto components", weightLbs: 33000 },
  { from: ["Charlotte", "NC"], to: ["Atlanta", "GA"], miles: 245, equipment: "dry_van", commodity: "Textiles", weightLbs: 31000 },
  { from: ["Fresno", "CA"], to: ["Los Angeles", "CA"], miles: 220, equipment: "reefer", commodity: "Fresh produce", weightLbs: 42000 },
  { from: ["Nogales", "AZ"], to: ["Los Angeles", "CA"], miles: 570, equipment: "reefer", commodity: "Tomatoes", weightLbs: 43000 },
  { from: ["Green Bay", "WI"], to: ["Chicago", "IL"], miles: 205, equipment: "reefer", commodity: "Cheese", weightLbs: 40500 },
  { from: ["Grand Rapids", "MI"], to: ["Chicago", "IL"], miles: 175, equipment: "dry_van", commodity: "Office furniture", weightLbs: 29000 },
  { from: ["Savannah", "GA"], to: ["Atlanta", "GA"], miles: 250, equipment: "dry_van", commodity: "Import containers", weightLbs: 44000 },
  { from: ["Houston", "TX"], to: ["New Orleans", "LA"], miles: 350, equipment: "flatbed", commodity: "Pipe", weightLbs: 46000 },
  { from: ["Phoenix", "AZ"], to: ["Denver", "CO"], miles: 820, equipment: "dry_van", commodity: "Electronics", weightLbs: 28000 },
  { from: ["Salt Lake City", "UT"], to: ["Portland", "OR"], miles: 770, equipment: "dry_van", commodity: "Packaged goods", weightLbs: 35000 },
  { from: ["Minneapolis", "MN"], to: ["Chicago", "IL"], miles: 410, equipment: "reefer", commodity: "Dairy", weightLbs: 42500 },
  { from: ["St. Louis", "MO"], to: ["Memphis", "TN"], miles: 285, equipment: "dry_van", commodity: "Appliances", weightLbs: 36500 },
  { from: ["Jacksonville", "FL"], to: ["Atlanta", "GA"], miles: 350, equipment: "dry_van", commodity: "Building materials", weightLbs: 40000 },
  { from: ["Cleveland", "OH"], to: ["Pittsburgh", "PA"], miles: 135, equipment: "flatbed", commodity: "Steel coil", weightLbs: 48000 },
  { from: ["Oklahoma City", "OK"], to: ["Dallas", "TX"], miles: 205, equipment: "dry_van", commodity: "Retail freight", weightLbs: 32000 },
  { from: ["Birmingham", "AL"], to: ["Nashville", "TN"], miles: 190, equipment: "flatbed", commodity: "Rebar", weightLbs: 47500 },
  { from: ["Louisville", "KY"], to: ["Indianapolis", "IN"], miles: 115, equipment: "dry_van", commodity: "Parcel freight", weightLbs: 27000 },
  { from: ["Reno", "NV"], to: ["Sacramento", "CA"], miles: 130, equipment: "dry_van", commodity: "Distribution freight", weightLbs: 30000 },
  { from: ["Stockton", "CA"], to: ["Seattle", "WA"], miles: 800, equipment: "reefer", commodity: "Almonds", weightLbs: 44000 },
  { from: ["El Paso", "TX"], to: ["Phoenix", "AZ"], miles: 430, equipment: "dry_van", commodity: "Maquila freight", weightLbs: 38000 },
  { from: ["Tampa", "FL"], to: ["Orlando", "FL"], miles: 85, equipment: "reefer", commodity: "Citrus", weightLbs: 39000 },
  { from: ["Richmond", "VA"], to: ["Philadelphia", "PA"], miles: 250, equipment: "dry_van", commodity: "Paper goods", weightLbs: 34500 },
  { from: ["Buffalo", "NY"], to: ["Cleveland", "OH"], miles: 190, equipment: "dry_van", commodity: "Industrial supplies", weightLbs: 33500 },
  { from: ["Des Moines", "IA"], to: ["Omaha", "NE"], miles: 135, equipment: "dry_van", commodity: "Ag equipment parts", weightLbs: 31500 },
  { from: ["Little Rock", "AR"], to: ["Memphis", "TN"], miles: 140, equipment: "dry_van", commodity: "Packaged food", weightLbs: 30500 },
  { from: ["Toledo", "OH"], to: ["Detroit", "MI"], miles: 60, equipment: "flatbed", commodity: "Stamped metal", weightLbs: 45000 },
  { from: ["Fort Worth", "TX"], to: ["San Antonio", "TX"], miles: 265, equipment: "dry_van", commodity: "Beverages", weightLbs: 43000 },
  { from: ["Boise", "ID"], to: ["Salt Lake City", "UT"], miles: 340, equipment: "reefer", commodity: "Frozen potatoes", weightLbs: 42000 },
];

const BASE_RPM: Record<Lane["equipment"], number> = {
  dry_van: 2.05,
  reefer: 2.45,
  flatbed: 2.6,
};

/** Short hauls carry a higher per-mile rate — fixed costs spread over fewer miles. */
function shortHaulMultiplier(miles: number): number {
  if (miles < 150) return 1.45;
  if (miles < 250) return 1.3;
  if (miles < 500) return 1.15;
  return 1.0;
}

function buildLoad(lane: Lane, i: number): NewLoad {
  const rpm = BASE_RPM[lane.equipment] * shortHaulMultiplier(lane.miles);

  // Deterministic ±6% lane variance so the board doesn't look generated.
  const variance = 1 + (((i * 37) % 13) - 6) / 100;
  const market = Math.round(lane.miles * rpm * variance * 100);

  const pickupStart = new Date(Date.now() + (i % 6) * 86_400_000 + 8 * 3_600_000);
  const pickupEnd = new Date(pickupStart.getTime() + 6 * 3_600_000);
  const transitMs = Math.max(1, Math.ceil(lane.miles / 500)) * 86_400_000;

  return {
    ref: `LD-${10400 + i}`,
    originCity: lane.from[0],
    originState: lane.from[1],
    destCity: lane.to[0],
    destState: lane.to[1],
    equipment: lane.equipment,
    weightLbs: lane.weightLbs,
    miles: lane.miles,
    commodity: lane.commodity,
    pickupStart,
    pickupEnd,
    deliveryStart: new Date(pickupEnd.getTime() + transitMs),
    deliveryEnd: new Date(pickupEnd.getTime() + transitMs + 8 * 3_600_000),

    // We are the broker BUYING capacity, so the exposure is overpaying.
    // floor = opening anchor · market = expected · ceiling = hard walk-away max.
    rateMarketCents: market,
    rateFloorCents: Math.round(market * 0.86),
    rateCeilingCents: Math.round(market * 1.14),

    status: "available",
  };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.");
  }

  const db = drizzle(neon(process.env.DATABASE_URL), { schema });

  const rows = LANES.map(buildLoad);
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
  console.log("Carriers intentionally not seeded — they come from real FMCSA data on Day 2.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
