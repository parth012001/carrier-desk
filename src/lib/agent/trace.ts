/**
 * The run trace. One row per tool call, with args, result and duration.
 *
 * Observability is a feature of this demo, not a debug aid — the interface
 * shows the trace beside the conversation, and "here is every decision the
 * agent made and what it cost" is a large part of what the project is arguing.
 * So the trace is written on the same path as the work, not bolted on after.
 */

export type TraceEventType = "tool_call" | "assistant_message" | "user_message";

export type TraceEvent = {
  /** Dense and gap-free within a run. Assigned by the sink, never by callers. */
  seq: number;
  type: TraceEventType;
  /** Tool name, when type is tool_call. */
  name?: string;
  args?: unknown;
  result?: unknown;
  durationMs?: number;
};

/** What a caller supplies; `seq` is the sink's to assign. */
export type TraceEventInput = Omit<TraceEvent, "seq">;

export interface TraceSink {
  write(event: TraceEventInput): Promise<void>;
}

/**
 * Sequencing lives in the sink rather than in callers on purpose: it is the
 * only place that can guarantee the numbers are dense and gap-free, and a
 * trace with holes in it is one nobody trusts enough to read.
 */
export class InMemoryTraceSink implements TraceSink {
  readonly events: TraceEvent[] = [];

  async write(event: TraceEventInput): Promise<void> {
    this.events.push({ ...event, seq: this.events.length });
  }

  toolCalls(): TraceEvent[] {
    return this.events.filter((e) => e.type === "tool_call");
  }
}

/** Discards everything. For paths that legitimately do not want a trace. */
export class NullTraceSink implements TraceSink {
  async write(): Promise<void> {}
}

/**
 * Wraps a tool's `execute` so that calling it writes a trace row.
 *
 * A tool that throws still writes its row, with the error as the result, and
 * then rethrows. A trace that records only successes is worse than no trace,
 * because it looks complete — the run where something blew up is exactly the
 * run someone will read this for.
 *
 * Timing uses `performance.now()` rather than `Date.now()`: it is monotonic,
 * so a clock adjustment mid-call cannot produce a negative duration. On this
 * machine, whose clock runs slow and gets corrected, that is not hypothetical.
 */
export function withTrace<Args, Result>(
  name: string,
  sink: TraceSink,
  execute: (args: Args) => Promise<Result>,
): (args: Args) => Promise<Result> {
  return async (args: Args): Promise<Result> => {
    const startedAt = performance.now();
    try {
      const result = await execute(args);
      await sink.write({
        type: "tool_call",
        name,
        args,
        result,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return result;
    } catch (error) {
      await sink.write({
        type: "tool_call",
        name,
        args,
        result: { error: error instanceof Error ? error.message : String(error) },
        durationMs: Math.round(performance.now() - startedAt),
      });
      throw error;
    }
  };
}
