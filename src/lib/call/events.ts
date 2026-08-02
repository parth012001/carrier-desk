import type { TraceEvent, TraceEventType } from "@/lib/agent/trace";

/**
 * What the browser receives during a call: one JSON object per line.
 *
 * This module is imported by both the route handler and the client components,
 * so it must stay free of anything server-only — no database, no `ai`, no
 * Node built-ins.
 *
 * **Every pane is a projection of this one stream.** The conversation, the
 * trace, the carrier profile, the compliance block and the rate ladder are all
 * folds over the same ordered events, which is why they cannot disagree with
 * each other. There is no second endpoint any of them poll.
 *
 * What is deliberately *not* here is the rate ceiling. No tool returns it or
 * anything derived from it (`docs/DECISIONS.md` #17, #19), so it cannot reach
 * the wire through a trace row. The broker's screen does show the policy band,
 * but it arrives by a different route — server-rendered from `toBrokerLoad` —
 * so the two audiences stay two explicit projections rather than one leaky one.
 */
export type CallEvent =
  | {
      kind: "trace";
      /** Position within this turn. `run_events.seq` is the durable ordering. */
      index: number;
      type: TraceEventType;
      name: string | null;
      args: unknown;
      result: unknown;
      durationMs: number | null;
    }
  | {
      kind: "turn_end";
      text: string;
      /** False when the loop was cut off by the step cap rather than ending. */
      finished: boolean;
      toolCalls: string[];
    }
  | { kind: "error"; message: string };

/**
 * Projects a trace row onto the wire.
 *
 * `args` and `result` go across verbatim. That is the point of the pane — a
 * summarised trace is one nobody can check, and "here is exactly what the tool
 * was asked and exactly what it answered" is most of what this demo argues.
 * It is also why the leak boundary is tested at the payload level rather than
 * reasoned about: whatever a tool returns, a human will read on a screen.
 */
export function toCallEvent(event: TraceEvent): CallEvent {
  return {
    kind: "trace",
    index: event.seq,
    type: event.type,
    name: event.name ?? null,
    args: event.args ?? null,
    result: event.result ?? null,
    durationMs: event.durationMs ?? null,
  };
}

/** Serialises one event as a line of NDJSON. */
export function encodeCallEvent(event: CallEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/**
 * Splits a growing NDJSON buffer into whole events, returning whatever partial
 * line is left over. A chunk boundary can land mid-object, so the caller keeps
 * the remainder and prepends it to the next chunk.
 */
export function decodeCallEvents(buffer: string): { events: CallEvent[]; rest: string } {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const events: CallEvent[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    events.push(JSON.parse(line) as CallEvent);
  }
  return { events, rest };
}
