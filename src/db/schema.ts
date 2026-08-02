import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * All money is integer cents. Never floats — see docs/DECISIONS.md #6.
 *
 * Rate floor and ceiling live on the load row and are read by the tool layer only.
 * They are never placed in a prompt — see docs/DECISIONS.md #4.
 */

export const carriers = pgTable(
  "carriers",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Identity
    mcNumber: text("mc_number").notNull(),
    dotNumber: text("dot_number"),
    legalName: text("legal_name").notNull(),
    dbaName: text("dba_name"),
    phone: text("phone"),

    // Compliance snapshot, refreshed from the CarrierDataSource
    authorityStatus: text("authority_status").notNull().default("unknown"), // active | inactive | pending | none | unknown
    /**
     * Three-valued, and NOT NULL would be a bug — see docs/DECISIONS.md #10.
     *
     * `CarrierRecord.isOutOfService` is `boolean | null` where null means "this
     * source cannot determine it", and the Socrata census file has no
     * out-of-service column among its 148, so every keyless lookup returns
     * null. A `notNull().default(false)` column would persist that as `false`:
     * recording "checked and clean" about a question nobody asked, which is
     * precisely the failure #10 and #13 exist to prevent, one layer down.
     */
    isOutOfService: boolean("is_out_of_service"),
    safetyRating: text("safety_rating"),
    powerUnits: integer("power_units"),
    /** Whether the entity is registered to haul for hire. Null = not established. */
    authorizedForHire: boolean("authorized_for_hire"),
    /** Whether this entity has had authority revoked before — a chameleon signal. */
    priorRevocation: boolean("prior_revocation"),
    /** Which source last wrote this snapshot, so a stale row is attributable. */
    lastSource: text("last_source"),

    // The "Twin": what we learn about this carrier across calls.
    // This is what makes call #2 better than call #1.
    preferredLanes: jsonb("preferred_lanes").$type<string[]>().notNull().default([]),
    equipmentTypes: jsonb("equipment_types").$type<string[]>().notNull().default([]),
    lastRateAcceptedCents: integer("last_rate_accepted_cents"),
    lastLoadRef: text("last_load_ref"),
    totalCalls: integer("total_calls").notNull().default(0),
    totalBooked: integer("total_booked").notNull().default(0),
    memories: jsonb("memories").$type<string[]>().notNull().default([]),

    firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("carriers_mc_number_idx").on(t.mcNumber)],
);

export const loads = pgTable(
  "loads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ref: text("ref").notNull(), // human-readable, e.g. "LD-10432"

    originCity: text("origin_city").notNull(),
    originState: text("origin_state").notNull(),
    destCity: text("dest_city").notNull(),
    destState: text("dest_state").notNull(),

    equipment: text("equipment").notNull(), // dry_van | reefer | flatbed
    weightLbs: integer("weight_lbs").notNull(),
    miles: integer("miles").notNull(),
    commodity: text("commodity"),

    pickupStart: timestamp("pickup_start").notNull(),
    pickupEnd: timestamp("pickup_end").notNull(),
    deliveryStart: timestamp("delivery_start"),
    deliveryEnd: timestamp("delivery_end"),

    // Pricing policy. The agent may see market; it may NEVER see ceiling.
    rateMarketCents: integer("rate_market_cents").notNull(),
    rateFloorCents: integer("rate_floor_cents").notNull(),
    rateCeilingCents: integer("rate_ceiling_cents").notNull(),

    status: text("status").notNull().default("available"), // available | covered | cancelled
    coveredByCarrierId: uuid("covered_by_carrier_id").references(() => carriers.id),
    bookedRateCents: integer("booked_rate_cents"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("loads_ref_idx").on(t.ref), index("loads_status_idx").on(t.status)],
);

/** One agent conversation, from first turn to outcome. */
export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    carrierId: uuid("carrier_id").references(() => carriers.id),
    loadId: uuid("load_id").references(() => loads.id),
    mcClaimed: text("mc_claimed"), // what the caller said, pre-verification

    channel: text("channel").notNull().default("chat"), // chat | voice
    outcome: text("outcome").notNull().default("in_progress"),
    // in_progress | booked | rejected | blocked | escalated | abandoned
    complianceDecision: text("compliance_decision"), // allow | flag | block
    finalRateCents: integer("final_rate_cents"),

    // Eval runs share the pipeline but must not pollute the ops view.
    isEval: boolean("is_eval").notNull().default(false),
    evalPersona: text("eval_persona"),

    startedAt: timestamp("started_at").notNull().defaultNow(),
    endedAt: timestamp("ended_at"),
  },
  (t) => [index("runs_carrier_idx").on(t.carrierId), index("runs_is_eval_idx").on(t.isEval)],
);

/** The trace. One row per tool call or message. Observability is a demo feature. */
export const runEvents = pgTable(
  "run_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),

    seq: integer("seq").notNull(),
    type: text("type").notNull(), // tool_call | assistant_message | user_message | system
    name: text("name"), // tool name, when type = tool_call
    args: jsonb("args"),
    result: jsonb("result"),
    durationMs: integer("duration_ms"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  // Unique, not just indexed. Density and ordering are the whole contract of a
  // trace, and the sink is the only thing enforcing them — so a second sink
  // numbering the same run should collide loudly here rather than quietly
  // produce two seq 0 rows that a reader renders interleaved. Serves the
  // ordering query too, so it replaces the plain composite index.
  (t) => [uniqueIndex("run_events_run_seq_idx").on(t.runId, t.seq)],
);

/** Every offer and counter, so we can prove the policy held. */
export const negotiations = pgTable(
  "negotiations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    loadId: uuid("load_id").references(() => loads.id),

    turn: integer("turn").notNull(),
    carrierAskedCents: integer("carrier_asked_cents"),
    agentOfferedCents: integer("agent_offered_cents"),
    accepted: boolean("accepted").notNull().default(false),

    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("negotiations_run_idx").on(t.runId)],
);

/** One row per persona per `pnpm eval` invocation. Drives the before/after delta. */
export const evalResults = pgTable(
  "eval_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    suiteRunId: text("suite_run_id").notNull(), // groups one invocation
    label: text("label"), // e.g. "baseline", "post-hardening"

    persona: text("persona").notNull(),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),

    passed: boolean("passed").notNull(),
    scores: jsonb("scores").$type<Record<string, number>>(),
    judgeNotes: text("judge_notes"),
    transcript: jsonb("transcript"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("eval_results_suite_idx").on(t.suiteRunId)],
);

/** The demo cannot depend on a live government API. Cache everything. */
export const carrierLookupCache = pgTable(
  "carrier_lookup_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mcNumber: text("mc_number").notNull(),
    source: text("source").notNull(), // socrata | qcmobile
    found: boolean("found").notNull(),
    payload: jsonb("payload"),
    fetchedAt: timestamp("fetched_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("carrier_cache_mc_source_idx").on(t.mcNumber, t.source)],
);

export type Carrier = typeof carriers.$inferSelect;
export type NewCarrier = typeof carriers.$inferInsert;
export type Load = typeof loads.$inferSelect;
export type NewLoad = typeof loads.$inferInsert;
export type Run = typeof runs.$inferSelect;
export type RunEvent = typeof runEvents.$inferSelect;
export type EvalResult = typeof evalResults.$inferSelect;
