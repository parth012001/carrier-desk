import { describe, expect, it } from "vitest";

import { InMemoryRunSink } from "@/lib/agent/ports/memory";

import { EvalRunSink, personasWithoutTrace } from "./durable";
import type { EvalOutcome } from "./scorecard";

/**
 * The durable half of an eval run, tested offline.
 *
 * `InMemoryRunSink` stands in for `DrizzleRunSink` — what is under test is the
 * decorator, not Postgres. The two behaviours it adds are both things that fail
 * silently in production if they regress: a forwarded synthetic id is a foreign
 * key violation raised inside `end_call`, and a missing `is_eval` is hundreds of
 * adversarial runs indistinguishable from real freight in the ops view.
 */

function outcome(over: Partial<EvalOutcome> = {}): EvalOutcome {
  return {
    personaId: "ceiling-extraction",
    personaTitle: "Ceiling extraction",
    runId: "00000000-0000-0000-0000-000000000001",
    invariants: [],
    verdict: null,
    turns: 4,
    outcome: "rejected",
    bookedRateCents: null,
    countersUsed: 2,
    traceRows: 12,
    durationMs: 1000,
    ...over,
  };
}

describe("EvalRunSink", () => {
  it("passes the run through and returns the inner sink's id", async () => {
    const inner = new InMemoryRunSink();
    const sink = new EvalRunSink(inner);

    const runId = await sink.start({
      mcClaimed: "186800",
      isEval: true,
      evalPersona: "ceiling-extraction",
    });

    expect(runId).toBe("run-0000");
    expect(inner.started).toHaveLength(1);
    expect(inner.started[0]).toMatchObject({
      mcClaimed: "186800",
      evalPersona: "ceiling-extraction",
    });
  });

  it("flags the run as an eval even when the caller says otherwise", async () => {
    // Forced rather than forwarded. `runs_is_eval_idx` is the index the ops view
    // reads, and a suite run that lands in it is a fake booking in the numbers a
    // demo is quoting.
    const inner = new InMemoryRunSink();

    await new EvalRunSink(inner).start({
      mcClaimed: "186800",
      isEval: false,
      evalPersona: "ceiling-extraction",
    });

    expect(inner.started[0].isEval).toBe(true);
  });

  it("drops the carrier and load ids, which name no row in Postgres", async () => {
    // The eval's stores hand out `carrier-0000` / `load-0003`. Both columns are
    // `uuid` with a foreign key, so forwarding these is not a nullable-column
    // trade-off — it is `invalid input syntax for type uuid`, thrown inside
    // `end_call`, telling the model the call could not be ended.
    const inner = new InMemoryRunSink();

    await new EvalRunSink(inner).finish({
      runId: "00000000-0000-0000-0000-000000000001",
      outcome: "booked",
      finalRateCents: 266_566,
      carrierId: "carrier-0000",
      loadId: "load-0003",
    });

    expect(inner.finished[0].carrierId).toBeNull();
    expect(inner.finished[0].loadId).toBeNull();
  });

  it("keeps the outcome and the rate, which are what the run row is for", async () => {
    const inner = new InMemoryRunSink();

    await new EvalRunSink(inner).finish({
      runId: "00000000-0000-0000-0000-000000000001",
      outcome: "booked",
      finalRateCents: 266_566,
      carrierId: null,
      loadId: null,
    });

    expect(inner.finished[0]).toMatchObject({ outcome: "booked", finalRateCents: 266_566 });
    expect(inner.outcome()).toBe("booked");
  });
});

describe("personasWithoutTrace", () => {
  it("names the personas whose run wrote nothing", () => {
    // The failure this exists for: `writeTrace` swallows a dead sink by design,
    // so with Postgres unreachable every persona still grades, still prints and
    // still passes while `run_events` stays empty. Nothing else in the pipeline
    // would say so.
    const outcomes = [
      outcome({ personaId: "ceiling-extraction", traceRows: 0 }),
      outcome({ personaId: "revoked-authority", traceRows: 9 }),
      outcome({ personaId: "prompt-injection", traceRows: 0 }),
    ];

    expect(personasWithoutTrace(outcomes)).toEqual(["ceiling-extraction", "prompt-injection"]);
  });

  it("is empty when every run traced", () => {
    expect(personasWithoutTrace([outcome({ traceRows: 1 })])).toEqual([]);
  });

  it("counts one row as traced, because a quiet call still writes its messages", () => {
    // The threshold is zero, not "enough". A run always writes at least a user
    // and an assistant message event, so zero means the branch dropped
    // everything rather than that the conversation was short.
    expect(personasWithoutTrace([outcome({ traceRows: 1 })])).toHaveLength(0);
    expect(personasWithoutTrace([outcome({ traceRows: 0 })])).toHaveLength(1);
  });
});
