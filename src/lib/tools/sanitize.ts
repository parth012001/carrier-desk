import type { Load } from "@/db/schema";

/**
 * The load, as the agent is allowed to see it.
 *
 * Built by naming every field to include, never by spreading a row and deleting
 * keys. The two look equivalent and fail in opposite directions: a deletion
 * silently starts *leaking* the day someone adds a column, while an allowlist
 * silently starts *omitting*. Omitting is a bug someone notices in a demo;
 * leaking is a bug nobody notices until an interviewer asks how the agent knew
 * the walk-away number.
 *
 * `market` is included — docs/DECISIONS.md #8 permits it, and it lets the agent
 * talk about the lane credibly. `floor` and `ceiling` are not: floor arrives
 * via counter_offer when it is time to say it, and ceiling is never anyone's
 * business but the tool layer's.
 */
export type AgentLoad = {
  load_ref: string;
  origin: string;
  destination: string;
  equipment: string;
  weight_lbs: number;
  miles: number;
  commodity: string | null;
  pickup_start: string;
  pickup_end: string;
  delivery_start: string | null;
  delivery_end: string | null;
  market_rate_cents: number;
  status: string;
};

/**
 * Every column on `loads`, split into what the agent may see and what it may
 * not. The point of listing the withheld ones explicitly — rather than just
 * omitting them — is that a test can then assert the two sets cover the table.
 * Add a column and that test fails until somebody decides which side it is on.
 */
export const EXPOSED_LOAD_COLUMNS = [
  "ref",
  "originCity",
  "originState",
  "destCity",
  "destState",
  "equipment",
  "weightLbs",
  "miles",
  "commodity",
  "pickupStart",
  "pickupEnd",
  "deliveryStart",
  "deliveryEnd",
  "rateMarketCents",
  "status",
] as const;

export const WITHHELD_LOAD_COLUMNS = [
  // The invariant. The model never sees this, in any tool, ever.
  "rateCeilingCents",
  // The opening anchor. counter_offer says it at round 1; knowing it up front
  // would let the agent open somewhere else.
  "rateFloorCents",
  // Internal plumbing with no conversational value.
  "id",
  "createdAt",
  "coveredByCarrierId",
  "bookedRateCents",
] as const;

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

export function toAgentLoad(load: Load): AgentLoad {
  return {
    load_ref: load.ref,
    origin: `${load.originCity}, ${load.originState}`,
    destination: `${load.destCity}, ${load.destState}`,
    equipment: load.equipment,
    weight_lbs: load.weightLbs,
    miles: load.miles,
    commodity: load.commodity,
    pickup_start: load.pickupStart.toISOString(),
    pickup_end: load.pickupEnd.toISOString(),
    delivery_start: iso(load.deliveryStart),
    delivery_end: iso(load.deliveryEnd),
    market_rate_cents: load.rateMarketCents,
    status: load.status,
  };
}
