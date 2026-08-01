import type { ToolSet } from "ai";

import activeFixture from "@/lib/carriers/__fixtures__/socrata/mc-186800.active.json";
import inactiveFixture from "@/lib/carriers/__fixtures__/socrata/mc-1175378.authority-inactive.json";
import unsatisfactoryFixture from "@/lib/carriers/__fixtures__/socrata/mc-895642.unsatisfactory.json";
import {
  InMemoryCarrierStore,
  InMemoryLoadStore,
  InMemoryNegotiationSink,
  InMemoryRunSink,
} from "@/lib/agent/ports/memory";
import { CallState } from "@/lib/agent/state";
import { InMemoryTraceSink } from "@/lib/agent/trace";
import type { AgentDeps } from "@/lib/agent/types";
import { InMemoryCacheStore } from "@/lib/carriers/cache";
import { SocrataCarrierSource } from "@/lib/carriers/socrata";
import type { CarrierDataSource, LookupResult } from "@/lib/carriers/types";

import { buildTools } from "./index";

/**
 * A complete tool context with no database and no network.
 *
 * Carrier data comes from the same recorded Socrata payloads the Day 2 suite
 * uses, replayed through the real `SocrataCarrierSource.normalize` — so these
 * tests run against genuine FMCSA record shapes, including the awkward ones,
 * rather than hand-written carriers that happen to be convenient.
 */

/** The demo carriers, by MC. See docs/STATE.md — do not invent others. */
export const FIXTURES: Record<string, unknown> = {
  "186800": activeFixture, // allow — GENERAL TRANSPORT INC, DOT 286764
  "1175378": inactiveFixture, // block — LB 168 INC, authority inactive + prior revocation
  "895642": unsatisfactoryFixture, // block — WORLDWIDE TRANSPORT SOLUTIONS, Unsatisfactory
};

export const MC_ALLOWED = "186800";
export const MC_BLOCKED = "1175378";
export const DOT_FOR_ALLOWED = "286764";

/** Replays fixtures through the real normalizer. Never touches the network. */
export function fixtureSource(fixtures = FIXTURES): CarrierDataSource {
  const socrata = new SocrataCarrierSource();
  return {
    id: "socrata",
    capabilities: socrata.capabilities,
    async lookupByMc(mcNumber: string): Promise<LookupResult> {
      const raw = fixtures[mcNumber];
      if (raw === undefined) return { status: "not_found", mcNumber };
      const record = socrata.normalize(raw, mcNumber);
      if (record === null) return { status: "not_found", mcNumber };
      return { status: "found", record, raw };
    },
    normalize: (raw, mc) => socrata.normalize(raw, mc),
  };
}

export type Harness = {
  tools: ToolSet;
  deps: AgentDeps;
  state: CallState;
  loads: InMemoryLoadStore;
  carriers: InMemoryCarrierStore;
  negotiations: InMemoryNegotiationSink;
  runs: InMemoryRunSink;
  trace: InMemoryTraceSink;
};

/**
 * `now` is fixed. Compliance rules read it (NEW_AUTHORITY measures against it)
 * and this machine's clock runs ~2.5 days slow, so a test that used the real
 * clock would drift into a different decision on a different day.
 */
export function makeHarness(
  options: { now?: Date; source?: CarrierDataSource } = {},
): Harness {
  const now = options.now ?? new Date("2026-08-01T00:00:00.000Z");
  const loads = InMemoryLoadStore.fromSeed(now);
  const carriers = new InMemoryCarrierStore();
  const negotiations = new InMemoryNegotiationSink();
  const runs = new InMemoryRunSink();
  const trace = new InMemoryTraceSink();

  const deps: AgentDeps = {
    source: options.source ?? fixtureSource(),
    cache: new InMemoryCacheStore(),
    carriers,
    loads,
    negotiations,
    runs,
    trace,
    now: () => now,
  };

  const state = new CallState("run-test");

  return { tools: buildTools({ deps, state }), deps, state, loads, carriers, negotiations, runs, trace };
}

/**
 * Invokes a tool the way the SDK would, but directly.
 *
 * Bypassing the zod schema is the point: the tool's own guards have to hold
 * against values the schema would have rejected, because "the schema catches
 * it" is a claim about the SDK, not about our code. Several tests here pass
 * things zod would refuse.
 */
export async function callTool(tools: ToolSet, name: string, input: unknown): Promise<unknown> {
  const execute = (tools[name] as { execute?: (i: unknown, o: unknown) => Promise<unknown> })
    .execute;
  if (execute === undefined) throw new Error(`tool ${name} has no execute`);
  return execute(input, {});
}
