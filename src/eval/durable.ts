import type { RunSink } from "@/lib/agent/types";

import type { EvalOutcome } from "./scorecard";

/**
 * The durable half of an eval run.
 *
 * `pnpm eval` used to build `InMemoryRunSink` and `InMemoryTraceSink`, so no
 * eval run ever reached `runs` or `run_events` — which made a `CLAUDE.md` hard
 * rule false ("every agent run writes a full trace to `run_events`") and left
 * `eval_results.run_id` unpopulable, exactly as deferred critical #11 says. Day
 * 5 runs hundreds of adversarial turns; those are the runs most worth being
 * able to read back.
 *
 * **Only `runs` and `trace` move.** `loads`, `carriers` and `negotiations` stay
 * in memory, so a suite run can never cover real freight, invent carrier rows,
 * or inflate the `total_calls` counter the Day 7 memory beat reads.
 */

/**
 * A real `runs` row, minus the two foreign keys that point at tables the eval
 * deliberately does not write.
 *
 * `runs.carrier_id` and `runs.load_id` are `uuid` columns with foreign keys
 * into `carriers` and `loads`. The eval's in-memory stores hand out synthetic
 * ids — `carrier-0000`, `load-0003` — which are not uuids and name no row, so
 * forwarding them is not a nullable-column trade-off but a failed insert:
 * Postgres rejects the literal before it ever reaches the constraint. That
 * throw would surface inside `end_call`, which is a traced tool, so the model
 * would be told the call could not be ended.
 *
 * Nulling them is therefore the honest write, not a lossy one. What a run row
 * is *for* — the outcome, the final rate, the persona, `is_eval` — is intact,
 * and the load and carrier both survive in the trace and in the transcript
 * blob. The alternative, pointing the eval at the real `DrizzleLoadStore`,
 * would make every suite run's result depend on which loads a previous live
 * demo had already covered.
 */
export class EvalRunSink implements RunSink {
  constructor(private readonly inner: RunSink) {}

  /**
   * Forces `isEval`, rather than trusting the caller to pass it.
   *
   * The flag is what keeps hundreds of adversarial runs out of the ops view —
   * `runs_is_eval_idx` exists for exactly that read — and a sink whose entire
   * purpose is eval traffic is the one place that can guarantee it. Passing it
   * from the call site made it a value someone could forget.
   */
  async start(input: Parameters<RunSink["start"]>[0]): Promise<string> {
    return this.inner.start({ ...input, isEval: true });
  }

  async finish(input: Parameters<RunSink["finish"]>[0]): Promise<void> {
    await this.inner.finish({ ...input, carrierId: null, loadId: null });
  }
}

/**
 * The personas whose run wrote nothing to `run_events`.
 *
 * The trace is tee'd — durable branch plus an in-memory one the grader reads —
 * and `TeeTraceSink` routes every branch through `writeTrace`, which swallows
 * and logs a failure so a dead sink can never fail the work it describes. That
 * is the right behaviour and it has a consequence: with Postgres unreachable,
 * every eval run would still grade, still print, and still pass, while writing
 * no trace at all. The rule this whole change exists to make true would go back
 * to being false, silently, with a green scorecard on top of it.
 *
 * So the row count comes back from the database and is asserted. A run always
 * writes at least the user and assistant message events, so zero rows means the
 * durable branch dropped everything rather than that the call was quiet.
 */
export function personasWithoutTrace(outcomes: EvalOutcome[]): string[] {
  return outcomes.filter((outcome) => outcome.traceRows === 0).map((outcome) => outcome.personaId);
}
