import type { Load } from "@/db/schema";

/**
 * Projections of a load, one per audience.
 *
 * There are two, and keeping them in one file is the point: a column is only
 * accounted for when *both* have decided about it, and a single test can
 * enforce that against the table. `docs/DECISIONS.md` #19's generalisation is
 * that an allowlist is a claim about representation, not information — so the
 * question at every boundary is what can be computed from what was sent, and
 * that has to be asked separately for each audience.
 *
 * `toAgentLoad` is the model's view: no floor, no ceiling, nothing derived
 * from either. `toBrokerLoad` is the human's, and it deliberately *does* carry
 * the policy band, because a broker watching a call needs to see the number
 * the agent could not.
 */

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

/**
 * The load, as the broker is allowed to see it.
 *
 * A second audience at a second boundary. The interface serialises this into a
 * client component, which is every bit as much a wire as a tool result — so it
 * gets a named allowlist too, rather than a spread row. Getting that wrong is
 * how a "just render the board" change quietly ships a column nobody reviewed.
 *
 * **The band is here on purpose.** Floor, market and ceiling are the broker's
 * own policy, and showing the ceiling beside the offers is the clearest
 * statement the interface can make: the number sits on screen, unmoving, while
 * the agent negotiates without it. That is a different claim from the model's
 * view, which is why it is a different function.
 *
 * Deliberately camelCase where `AgentLoad` is snake_case. The two shapes are
 * for different readers and should not be mistaken for one another at a glance.
 */
export type BrokerLoad = {
  ref: string;
  origin: string;
  destination: string;
  equipment: string;
  commodity: string | null;
  weightLbs: number;
  miles: number;
  pickupStart: string;
  pickupEnd: string;
  deliveryStart: string | null;
  deliveryEnd: string | null;
  /** The policy band. Internal to the brokerage; the model sees `market` alone. */
  floorCents: number;
  marketCents: number;
  ceilingCents: number;
  status: string;
  bookedRateCents: number | null;
};

export const BROKER_EXPOSED_LOAD_COLUMNS = [
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
  // The two the agent never sees. This is the whole difference between the
  // audiences, and it is a deliberate line rather than an oversight.
  "rateFloorCents",
  "rateCeilingCents",
  "status",
  "bookedRateCents",
] as const;

export const BROKER_WITHHELD_LOAD_COLUMNS = [
  // Internal identifiers with nothing to say on a screen. `ref` is the unique
  // key a person reads out loud, so it is what the interface keys on too.
  "id",
  "createdAt",
  "coveredByCarrierId",
] as const;

export function toBrokerLoad(load: Load): BrokerLoad {
  return {
    ref: load.ref,
    origin: `${load.originCity}, ${load.originState}`,
    destination: `${load.destCity}, ${load.destState}`,
    equipment: load.equipment,
    commodity: load.commodity,
    weightLbs: load.weightLbs,
    miles: load.miles,
    pickupStart: load.pickupStart.toISOString(),
    pickupEnd: load.pickupEnd.toISOString(),
    deliveryStart: iso(load.deliveryStart),
    deliveryEnd: iso(load.deliveryEnd),
    floorCents: load.rateFloorCents,
    marketCents: load.rateMarketCents,
    ceilingCents: load.rateCeilingCents,
    status: load.status,
    bookedRateCents: load.bookedRateCents,
  };
}
