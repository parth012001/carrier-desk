import { config } from "dotenv";
config({ path: ".env.local" });

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import type { ModelMessage } from "ai";

import * as schema from "../src/db/schema";
import { agentModel } from "../src/lib/agent/models";
import {
  DrizzleCarrierStore,
  DrizzleLoadStore,
  DrizzleNegotiationSink,
  DrizzleRunSink,
  DrizzleTraceSink,
} from "../src/lib/agent/ports/drizzle";
import { runCall } from "../src/lib/agent/run";
import { CallState } from "../src/lib/agent/state";
import type { AgentDeps } from "../src/lib/agent/types";
import { DrizzleCacheStore } from "../src/lib/carriers/cache-drizzle";
import { SocrataCarrierSource } from "../src/lib/carriers/socrata";
import { buildTools } from "../src/lib/tools";

/**
 * One real conversation, against the live model, live FMCSA and live Postgres.
 * This is the ONLY place any of those are exercised — `pnpm test` touches none
 * of them.
 *
 *   pnpm agent:smoke 186800 LD-10400
 *
 * Two turns, because the second one is the point: it asserts the prompt prefix
 * actually cached. Sonnet 5's minimum cacheable prefix is 1024 tokens and the
 * Day 2 measurement was ~1078 without caching, which is close enough to be luck
 * either way. If the real system prompt plus seven tool schemas still does not
 * cache, we pay full price on an identical prefix on every turn of every call,
 * and the time to find that out is now rather than during a demo.
 */

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

async function main() {
  const [mcNumber = "186800", loadRef = "LD-10400"] = process.argv.slice(2);

  for (const required of ["DATABASE_URL", "ANTHROPIC_API_KEY"]) {
    if (!process.env[required]) {
      console.error(`${required} is not set. Copy .env.example to .env.local and fill it in.`);
      process.exit(1);
    }
  }

  const db = drizzle(neon(process.env.DATABASE_URL!), { schema });
  const runs = new DrizzleRunSink(db);
  const runId = await runs.start({ mcClaimed: mcNumber, isEval: false, evalPersona: null });

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

  const state = new CallState(runId);
  const tools = buildTools({ deps, state });

  console.log(`${DIM}run ${runId} · MC-${mcNumber} · ${loadRef}${RESET}\n`);

  const messages: ModelMessage[] = [];
  const turns = [
    `Hi, this is Dave with MC ${mcNumber}. I'm calling about load ${loadRef} — is it still open?`,
    `What can you pay on it? I need at least four thousand to make it work.`,
  ];

  let cacheReadOnSecondTurn = 0;

  for (const [i, turn] of turns.entries()) {
    messages.push({ role: "user", content: turn });
    console.log(`${DIM}carrier:${RESET} ${turn}`);

    const startedAt = Date.now();
    const result = await runCall({ model: agentModel(), tools, messages, trace: deps.trace });
    const elapsed = Date.now() - startedAt;

    console.log(`${DIM}agent:${RESET}   ${result.text || "(no text — tool calls only)"}`);
    console.log(
      `${DIM}         ${result.stepCount} step(s), ${elapsed}ms, tools: ` +
        `${result.toolCalls.join(" → ") || "none"}${RESET}`,
    );

    // SDK-level names, which differ from the provider-level ones on
    // LanguageModelV4Usage: `cacheReadTokens` here, `cacheRead` there.
    const details = result.usage.inputTokenDetails;
    console.log(
      `${DIM}         tokens in ${result.usage.inputTokens ?? "?"} ` +
        `(cache read ${details.cacheReadTokens ?? 0}, wrote ${details.cacheWriteTokens ?? 0})${RESET}\n`,
    );

    if (i === 1) cacheReadOnSecondTurn = details.cacheReadTokens ?? 0;
    messages.push(...result.responseMessages);
  }

  // The trace, read back from Postgres rather than from memory — this is what
  // Day 4's interface will render, so it is worth proving it landed.
  const events = await db.query.runEvents.findMany({
    where: (e, { eq }) => eq(e.runId, runId),
    orderBy: (e, { asc }) => [asc(e.seq)],
  });

  console.log(`${DIM}run_events (${events.length} rows):${RESET}`);
  for (const event of events) {
    const label = event.name ?? event.type;
    const duration = event.durationMs === null ? "" : ` ${event.durationMs}ms`;
    console.log(`  ${String(event.seq).padStart(2)} ${label}${duration}`);
  }

  const toolRows = events.filter((e) => e.type === "tool_call");
  const missingDetail = toolRows.filter((e) => e.args === null || e.result === null);

  console.log();
  report("trace has one row per tool call with args and result", missingDetail.length === 0);
  report(
    `prompt prefix cached on the second turn (${cacheReadOnSecondTurn} tokens read)`,
    cacheReadOnSecondTurn > 0,
  );

  if (cacheReadOnSecondTurn === 0) {
    console.log(
      `\n${RED}The prefix is not caching.${RESET} Every turn pays full price for an identical\n` +
        `system prompt and tool set. Check that the prefix clears Sonnet 5's 1024-token\n` +
        `minimum, and that nothing volatile (a timestamp, a run id) sits ahead of the\n` +
        `cache breakpoint. See docs/DECISIONS.md #15.`,
    );
    process.exitCode = 1;
  }
}

function report(label: string, ok: boolean) {
  console.log(`  ${ok ? `${GREEN}✓` : `${RED}✗`}${RESET} ${label}`);
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
