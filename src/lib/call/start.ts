import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

import * as schema from "@/db/schema";
import {
  type AgentDb,
  DrizzleCarrierStore,
  DrizzleLoadStore,
  DrizzleNegotiationSink,
  DrizzleRunSink,
  DrizzleTraceSink,
} from "@/lib/agent/ports/drizzle";
import { CallState } from "@/lib/agent/state";
import type { AgentDeps } from "@/lib/agent/types";
import { DrizzleCacheStore } from "@/lib/carriers/cache-drizzle";
import { SocrataCarrierSource } from "@/lib/carriers/socrata";

import type { CallSession } from "./session";

/**
 * Builds one live call: a `runs` row, the real ports, and the tools bound to
 * them. Server-only — it opens a database connection and reads secrets.
 *
 * This is the same wiring `scripts/agent-smoke.ts` does, and deliberately so:
 * the smoke script is the thing that proves the wiring works against the live
 * model, live FMCSA and live Postgres, so the interface should be exercising
 * the same path rather than a parallel one that can drift.
 *
 * The ordering is forced. `DrizzleTraceSink` needs the `runId` and so does
 * `CallState`, so `runs.start()` has to happen before `deps` can exist.
 *
 * `@/db` is not imported: that module throws at load time when `DATABASE_URL`
 * is unset, which in a route handler is an import-time crash rather than a
 * request-time error.
 */

let cachedDb: AgentDb | null = null;

function database(): AgentDb {
  if (cachedDb === null) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local.");
    cachedDb = drizzle(neon(url), { schema });
  }
  return cachedDb;
}

export function assertCallEnvironment(): void {
  for (const required of ["DATABASE_URL", "ANTHROPIC_API_KEY"]) {
    if (!process.env[required]) throw new Error(`${required} is not set.`);
  }
}

export async function startCall(input: { mcClaimed: string | null }): Promise<CallSession> {
  assertCallEnvironment();

  const db = database();
  const runs = new DrizzleRunSink(db);
  const runId = await runs.start({
    mcClaimed: input.mcClaimed,
    isEval: false,
    evalPersona: null,
  });

  const deps: AgentDeps = {
    source: new SocrataCarrierSource({ appToken: process.env.SOCRATA_APP_TOKEN }),
    cache: new DrizzleCacheStore(db),
    carriers: new DrizzleCarrierStore(db),
    loads: new DrizzleLoadStore(db),
    negotiations: new DrizzleNegotiationSink(db),
    runs,
    trace: new DrizzleTraceSink(db, runId),
    now: () => new Date(),
  };

  return {
    runId,
    mcClaimed: input.mcClaimed,
    deps,
    // No `tools` here on purpose. `buildTools` captures `deps.trace`, and the
    // live branch of that trace belongs to a single HTTP connection that does
    // not exist yet — so tools built now would write only to Postgres and the
    // browser would show a conversation with no tool calls in it. The turn
    // route builds them per turn; `state` is the thing that has to persist.
    state: new CallState(runId),
    messages: [],
    inFlight: false,
    lastTouchedAtMs: Date.now(),
  };
}
