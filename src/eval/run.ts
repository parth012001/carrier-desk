import { config } from "dotenv";
config({ path: ".env.local" });

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import type { ModelMessage } from "ai";

import { evalResults } from "@/db/schema";
import * as schema from "@/db/schema";
import { agentModel } from "@/lib/agent/models";
import {
  InMemoryCarrierStore,
  InMemoryLoadStore,
  InMemoryNegotiationSink,
  InMemoryRunSink,
} from "@/lib/agent/ports/memory";
import { runCall } from "@/lib/agent/run";
import { CallState } from "@/lib/agent/state";
import { InMemoryTraceSink } from "@/lib/agent/trace";
import type { AgentDeps } from "@/lib/agent/types";
import { InMemoryCacheStore } from "@/lib/carriers/cache";
import { SocrataCarrierSource } from "@/lib/carriers/socrata";
import { buildTools } from "@/lib/tools";

import { evalContext, universalInvariants } from "./invariants";
import { type Line, carrierTurn, judgeCall } from "./judge";
import { PERSONAS, type Persona } from "./personas";
import { type EvalOutcome, passed, printScorecard, scores } from "./scorecard";

/**
 * The adversarial eval, end to end: one persona, one judge call, one printed
 * score. Deliberately crude — its job is that Day 5 is scaling rather than
 * building. See docs/DECISIONS.md #7.
 *
 *   pnpm eval
 *   pnpm eval --label baseline
 *
 * Runs against in-memory ports so a suite run cannot consume the real load
 * board or invent carriers. Only the scorecard row is persisted, which is what
 * Day 6's before/after delta reads.
 */

const NOW = new Date("2026-08-01T00:00:00.000Z");

async function runPersona(persona: Persona): Promise<EvalOutcome> {
  const startedAt = Date.now();

  const loads = InMemoryLoadStore.fromSeed(NOW);
  const trace = new InMemoryTraceSink();
  const runs = new InMemoryRunSink();
  const runId = await runs.start({
    mcClaimed: persona.mcNumber,
    isEval: true,
    evalPersona: persona.id,
  });

  const deps: AgentDeps = {
    // The real Socrata source: carrier identity stays real even in an eval.
    // The cache means one live lookup per persona, not one per turn.
    source: new SocrataCarrierSource({ appToken: process.env.SOCRATA_APP_TOKEN }),
    cache: new InMemoryCacheStore(),
    carriers: new InMemoryCarrierStore(),
    loads,
    negotiations: new InMemoryNegotiationSink(),
    runs,
    trace,
    now: () => new Date(),
  };

  const state = new CallState(runId);
  const tools = buildTools({ deps, state });

  const transcript: Line[] = [];
  const messages: ModelMessage[] = [];

  for (let turn = 0; turn < persona.maxTurns; turn++) {
    const carrierLine = await carrierTurn(persona, transcript);
    if (carrierLine === "") break;

    transcript.push({ speaker: "carrier", text: carrierLine });
    messages.push({ role: "user", content: carrierLine });

    const result = await runCall({ model: agentModel(), tools, messages, trace });
    messages.push(...result.responseMessages);
    if (result.text.trim() !== "") {
      transcript.push({ speaker: "agent", text: result.text });
    }

    process.stdout.write(".");
    if (state.outcome !== "in_progress") break;
  }

  const load = loads.snapshot(persona.loadRef)!;
  const toolCalls = trace.toolCalls();

  // Checked against the numbers, not asked of a model. A judge that
  // hallucinated a pass would otherwise turn the project's headline claim into
  // a vibe — so the load-bearing half of the verdict is arithmetic.
  const ctx = evalContext({
    loadRef: persona.loadRef,
    ceilingCents: load.rateCeilingCents,
    bookedRateCents: load.bookedRateCents,
    state,
    toolCalls,
    agentText: transcript
      .filter((l) => l.speaker === "agent")
      .map((l) => l.text)
      .join("\n"),
  });

  // Universal first, and always: the ceiling and counter-cap checks are the
  // safety floor and a persona cannot opt out of them. What the persona adds is
  // what *it* is testing, which is the part that differs between a scenario
  // where quoting a rate is the point and one where quoting a rate is the bug.
  const invariants = [...universalInvariants(ctx), ...persona.invariants(ctx)];

  const verdict = await judgeCall({ persona, transcript, toolCalls });

  return {
    personaId: persona.id,
    personaTitle: persona.title,
    invariants,
    verdict,
    turns: transcript.filter((l) => l.speaker === "carrier").length,
    outcome: ctx.outcome,
    bookedRateCents: ctx.bookedRateCents,
    countersUsed: ctx.countersUsed,
    durationMs: Date.now() - startedAt,
  };
}

async function main() {
  for (const required of ["ANTHROPIC_API_KEY"]) {
    if (!process.env[required]) {
      console.error(`${required} is not set. Copy .env.example to .env.local and fill it in.`);
      process.exit(1);
    }
  }

  const args = process.argv.slice(2);
  const labelIndex = args.indexOf("--label");
  const label = labelIndex === -1 ? "unlabelled" : (args[labelIndex + 1] ?? "unlabelled");
  // Groups one invocation. Passed in rather than generated inside a helper so
  // every row from this run shares it, which is what the delta reads on.
  const suiteRunId = `eval-${new Date().toISOString()}`;

  console.log(`Running ${PERSONAS.length} persona(s)`);

  const outcomes: EvalOutcome[] = [];
  const transcripts: Record<string, EvalOutcome> = {};
  for (const persona of PERSONAS) {
    const outcome = await runPersona(persona);
    outcomes.push(outcome);
    transcripts[persona.id] = outcome;
  }

  printScorecard(outcomes, label);

  if (process.env.DATABASE_URL) {
    const db = drizzle(neon(process.env.DATABASE_URL), { schema });
    await db.insert(evalResults).values(
      outcomes.map((outcome) => ({
        suiteRunId,
        label,
        persona: outcome.personaId,
        // The exported rule, not a second copy of it. This used to re-derive
        // the verdict inline and drop `held_the_line`, so a run the scorecard
        // printed as FAIL was persisted as passed. Day 6's before/after delta
        // reads this column, which made the stored evidence disagree with what
        // a human had just watched fail.
        passed: passed(outcome),
        scores: scores(outcome.verdict),
        judgeNotes: outcome.verdict?.notes ?? null,
        transcript: outcome as unknown as Record<string, unknown>,
      })),
    );
    console.log(`Persisted ${outcomes.length} row(s) under suite ${suiteRunId}`);
  } else {
    console.log("DATABASE_URL not set — scorecard printed but not persisted.");
  }

  // Non-zero on failure so this can gate a commit later. Same rule the
  // scorecard prints and the database stores — one definition, three readers.
  if (outcomes.some((o) => !passed(o))) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
