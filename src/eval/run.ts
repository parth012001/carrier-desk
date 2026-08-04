import { config } from "dotenv";
config({ path: ".env.local" });

import { neon } from "@neondatabase/serverless";
import { count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";
import type { ModelMessage } from "ai";

import { evalResults, runEvents } from "@/db/schema";
import * as schema from "@/db/schema";
import { agentModel } from "@/lib/agent/models";
import { type AgentDb, DrizzleRunSink, DrizzleTraceSink } from "@/lib/agent/ports/drizzle";
import {
  InMemoryCarrierStore,
  InMemoryLoadStore,
  InMemoryNegotiationSink,
} from "@/lib/agent/ports/memory";
import { runCall } from "@/lib/agent/run";
import { CallState } from "@/lib/agent/state";
import { InMemoryTraceSink, TeeTraceSink } from "@/lib/agent/trace";
import type { AgentDeps } from "@/lib/agent/types";
import { InMemoryCacheStore } from "@/lib/carriers/cache";
import { SocrataCarrierSource } from "@/lib/carriers/socrata";
import { buildTools } from "@/lib/tools";

import { EvalRunSink, personasWithoutTrace } from "./durable";
import { evalContext, gradeCall } from "./invariants";
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
 * **`runs` and `trace` are the real Drizzle ports; everything else is in
 * memory.** An eval run is an agent run, so it writes a full trace to
 * `run_events` like every other one — see `durable.ts` for why only those two
 * moved, and `docs/DECISIONS.md` #24.
 */

const NOW = new Date("2026-08-01T00:00:00.000Z");

async function runPersona(persona: Persona, db: AgentDb): Promise<EvalOutcome> {
  const startedAt = Date.now();

  const loads = InMemoryLoadStore.fromSeed(NOW);
  const runs = new EvalRunSink(new DrizzleRunSink(db));
  const runId = await runs.start({
    mcClaimed: persona.mcNumber,
    isEval: true,
    evalPersona: persona.id,
  });

  // Tee'd rather than swapped. The durable branch is the point of the change;
  // the in-memory branch is what the grader reads, and reading it back out of
  // Postgres to score a call we are still holding in memory would put a network
  // round trip between a run and its own verdict for no gain.
  const collected = new InMemoryTraceSink();
  const trace = new TeeTraceSink(new DrizzleTraceSink(db, runId), collected);

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
  const toolCalls = collected.toolCalls();

  // Counted from the database, not from the sink that was asked to write it.
  // `writeTrace` swallows a failed row on purpose, so the only way to know the
  // durable branch actually landed is to go and look.
  const [traceRows] = await db
    .select({ rows: count() })
    .from(runEvents)
    .where(eq(runEvents.runId, runId));

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

  // Universal first, and always — see `gradeCall`. Shared with the tests rather
  // than spelled out here, so a suite cannot pass against its own copy of the
  // composition while this line quietly drops the ceiling checks.
  const invariants = gradeCall(persona, ctx);

  const verdict = await judgeCall({ persona, transcript, toolCalls });

  return {
    personaId: persona.id,
    personaTitle: persona.title,
    runId,
    invariants,
    verdict,
    turns: transcript.filter((l) => l.speaker === "carrier").length,
    outcome: ctx.outcome,
    bookedRateCents: ctx.bookedRateCents,
    countersUsed: ctx.countersUsed,
    traceRows: traceRows?.rows ?? 0,
    durationMs: Date.now() - startedAt,
  };
}

async function main() {
  // DATABASE_URL is required now, not optional. An eval run is an agent run and
  // agent runs write a trace; a mode that quietly skips it is the mode this
  // change exists to delete.
  for (const required of ["ANTHROPIC_API_KEY", "DATABASE_URL"]) {
    if (!process.env[required]) {
      console.error(`${required} is not set. Copy .env.example to .env.local and fill it in.`);
      process.exit(1);
    }
  }

  const db = drizzle(neon(process.env.DATABASE_URL!), { schema });

  const args = process.argv.slice(2);
  const labelIndex = args.indexOf("--label");
  const label = labelIndex === -1 ? "unlabelled" : (args[labelIndex + 1] ?? "unlabelled");
  // Groups one invocation. Passed in rather than generated inside a helper so
  // every row from this run shares it, which is what the delta reads on.
  const suiteRunId = `eval-${new Date().toISOString()}`;

  console.log(`Running ${PERSONAS.length} persona(s)`);

  const outcomes: EvalOutcome[] = [];
  for (const persona of PERSONAS) {
    outcomes.push(await runPersona(persona, db));
  }

  printScorecard(outcomes, label);

  await db.insert(evalResults).values(
    outcomes.map((outcome) => ({
      suiteRunId,
      label,
      persona: outcome.personaId,
      // The `runs` row this persona actually produced. Unwritable until the eval
      // stopped running against `InMemoryRunSink` — half of deferred critical
      // #11, and what turns a scorecard row into something you can open the
      // trace of.
      runId: outcome.runId,
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

  // Non-zero on failure so this can gate a commit later. Same rule the
  // scorecard prints and the database stores — one definition, three readers.
  if (outcomes.some((o) => !passed(o))) process.exitCode = 1;

  // Separate from the verdicts on purpose: this is not the agent failing, it is
  // the harness failing to record what the agent did. A green scorecard written
  // by a run that traced nothing is the exact thing this change is repairing,
  // so it must not be possible to exit 0 on one.
  const untraced = personasWithoutTrace(outcomes);
  if (untraced.length > 0) {
    console.error(
      `\nNo run_events rows for: ${untraced.join(", ")}. ` +
        "The durable trace branch dropped everything — check DATABASE_URL and the logs above.",
    );
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
