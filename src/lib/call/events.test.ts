import { describe, expect, it } from "vitest";

import { type CallEvent, decodeCallEvents, encodeCallEvent, toCallEvent } from "./events";

describe("toCallEvent", () => {
  it("carries args, result and latency across verbatim", async () => {
    // A summarised trace is one nobody can check. "Here is exactly what the
    // tool was asked and exactly what it answered" is most of what the pane is
    // for, so the projection is deliberately not a filter.
    const event = toCallEvent({
      seq: 3,
      type: "tool_call",
      name: "lookup_carrier",
      args: { mc_number: "1175378" },
      result: {
        found: true,
        decision: "block",
        reasons: [{ code: "AUTHORITY_NOT_ACTIVE", severity: "block", message: "Docket 1 is I." }],
      },
      durationMs: 412,
    });

    expect(event).toEqual({
      kind: "trace",
      index: 3,
      type: "tool_call",
      name: "lookup_carrier",
      args: { mc_number: "1175378" },
      result: {
        found: true,
        decision: "block",
        reasons: [{ code: "AUTHORITY_NOT_ACTIVE", severity: "block", message: "Docket 1 is I." }],
      },
      durationMs: 412,
    });
  });

  it("normalises a message row's absent fields to null rather than dropping them", async () => {
    // undefined would vanish through JSON.stringify, and a row with no `args`
    // key reads as "no arguments" rather than "not a tool call".
    const event = toCallEvent({ seq: 0, type: "user_message", result: "MC 186800, got anything?" });

    expect(event).toMatchObject({ name: null, args: null, durationMs: null });
    expect(JSON.parse(JSON.stringify(event))).toMatchObject({ name: null, args: null });
  });
});

describe("the NDJSON wire", () => {
  const events: CallEvent[] = [
    { kind: "trace", index: 0, type: "user_message", name: null, args: null, result: "Hi", durationMs: null },
    {
      kind: "trace",
      index: 1,
      type: "tool_call",
      name: "counter_offer",
      args: { load_ref: "LD-10401", mc_number: "186800", carrier_asked_cents: 400000 },
      result: { action: "offer", rate_cents: 233000, counters_remaining: 2 },
      durationMs: 18,
    },
    { kind: "turn_end", text: "I can do $2,330 on that.", finished: true, toolCalls: ["counter_offer"] },
  ];

  it("round-trips every event", async () => {
    const wire = events.map(encodeCallEvent).join("");

    const decoded = decodeCallEvents(wire);

    expect(decoded.events).toEqual(events);
    expect(decoded.rest).toBe("");
  });

  it("holds back a partial line until the rest of it arrives", async () => {
    // A chunk boundary lands wherever the network puts it, which is routinely
    // mid-object. Parsing a half-written line would throw and kill the pane.
    const wire = events.map(encodeCallEvent).join("");
    const split = wire.indexOf("counter_offer") + 4;

    const first = decodeCallEvents(wire.slice(0, split));
    expect(first.events).toHaveLength(1);
    expect(first.rest).not.toBe("");

    const second = decodeCallEvents(first.rest + wire.slice(split));
    expect(second.events).toHaveLength(2);
    expect(second.rest).toBe("");
    expect([...first.events, ...second.events]).toEqual(events);
  });

  it("puts one event on one line, so a boundary can never be mistaken", async () => {
    const encoded = encodeCallEvent(events[1]);

    expect(encoded.endsWith("\n")).toBe(true);
    expect(encoded.trimEnd().includes("\n")).toBe(false);
  });
});
