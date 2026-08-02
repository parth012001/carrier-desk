import { describe, expect, it } from "vitest";

import type { CallEvent } from "./events";
import { projectCall } from "./projection";

const trace = (
  index: number,
  name: string | null,
  extra: Partial<Extract<CallEvent, { kind: "trace" }>> = {},
): CallEvent => ({
  kind: "trace",
  index,
  type: name === null ? "assistant_message" : "tool_call",
  name,
  args: null,
  result: null,
  durationMs: null,
  ...extra,
});

describe("projectCall — the conversation", () => {
  it("splits carrier turns from agent turns", () => {
    const view = projectCall([
      trace(0, null, { type: "user_message", result: "MC 186800, anything to Denver?" }),
      trace(1, null, { type: "assistant_message", result: "Let me verify you first." }),
    ]);

    expect(view.turns).toEqual([
      { speaker: "carrier", text: "MC 186800, anything to Denver?" },
      { speaker: "agent", text: "Let me verify you first." },
    ]);
  });

  it("flattens a content-part array into text", () => {
    // A message is a string going in and can come back out of the SDK as parts.
    const view = projectCall([
      trace(0, null, {
        type: "assistant_message",
        result: [{ type: "text", text: "You're clear. " }, { type: "text", text: "LD-10401 is open." }],
      }),
    ]);

    expect(view.turns[0].text).toBe("You're clear. LD-10401 is open.");
  });
});

describe("projectCall — compliance", () => {
  const blockedLookup = trace(1, "lookup_carrier", {
    args: { mc_number: "1175378" },
    result: {
      found: true,
      decision: "block",
      reasons: [
        { code: "AUTHORITY_NOT_ACTIVE", severity: "block", message: "Docket 1 status is I." },
        { code: "PRIOR_AUTHORITY_REVOCATION", severity: "block", message: "Prior revocation." },
      ],
      carrier: {
        mc_number: "1175378",
        dot_number: "2895176",
        legal_name: "LB 168 INC",
        dba_name: null,
        phone: "7145551234",
        authority_status: "inactive",
        safety_rating: null,
        power_units: 1,
      },
      previous_calls: 0,
    },
    durationMs: 412,
  });

  it("surfaces the decision with every reason intact", () => {
    // Demo contract item 2. The reasons are the point — "no guessing why a
    // carrier got flagged" is the whole claim the compliance block makes.
    const view = projectCall([blockedLookup]);

    expect(view.compliance?.decision).toBe("block");
    expect(view.compliance?.reasons.map((r) => r.code)).toEqual([
      "AUTHORITY_NOT_ACTIVE",
      "PRIOR_AUTHORITY_REVOCATION",
    ]);
    expect(view.carrier?.legalName).toBe("LB 168 INC");
  });

  it("shows the most recent lookup, so a blocked second caller is not hidden", () => {
    const view = projectCall([
      trace(0, "lookup_carrier", {
        result: {
          found: true,
          decision: "allow",
          reasons: [],
          carrier: { mc_number: "186800", legal_name: "GENERAL TRANSPORT INC" },
          previous_calls: 0,
        },
      }),
      blockedLookup,
    ]);

    expect(view.carrier?.mcNumber).toBe("1175378");
    expect(view.compliance?.decision).toBe("block");
  });

  it("keeps the carrier when a later check_compliance only restates the verdict", () => {
    const view = projectCall([
      blockedLookup,
      trace(2, "check_compliance", {
        result: { verified: true, decision: "block", reasons: [] },
      }),
    ]);

    expect(view.carrier?.legalName).toBe("LB 168 INC");
    expect(view.compliance?.decision).toBe("block");
  });

  it("keeps a not-found lookup's verdict even though there is no carrier", () => {
    const view = projectCall([
      trace(0, "lookup_carrier", {
        result: {
          found: false,
          decision: "block",
          reasons: [{ code: "NOT_FOUND", severity: "block", message: "No such MC." }],
          carrier: null,
          previous_calls: 0,
        },
      }),
    ]);

    expect(view.carrier).toBeNull();
    expect(view.compliance?.decision).toBe("block");
  });
});

describe("projectCall — the negotiation", () => {
  it("records offers in order with what was asked for", () => {
    const view = projectCall([
      trace(0, "counter_offer", {
        args: { load_ref: "LD-10401", mc_number: "186800", carrier_asked_cents: 400000 },
        result: { action: "offer", rate_cents: 233000, counters_remaining: 2 },
      }),
      trace(1, "counter_offer", {
        args: { load_ref: "LD-10401", mc_number: "186800", carrier_asked_cents: 300000 },
        result: { action: "accept", rate_cents: 266000, counters_remaining: 1 },
      }),
    ]);

    expect(view.offers).toEqual([
      { loadRef: "LD-10401", round: 1, rateCents: 233000, askedCents: 400000, accepted: false },
      { loadRef: "LD-10401", round: 2, rateCents: 266000, askedCents: 300000, accepted: true },
    ]);
    expect(view.loadRef).toBe("LD-10401");
  });

  it("counts rounds per load, the way the tool layer does", () => {
    // `CallState.nextRound` is keyed by load. A global count would have the
    // ladder calling this "offer 2" while the trace pane renders the tool's own
    // result saying round 1 — two panes disagreeing about the same event.
    const view = projectCall([
      trace(0, "counter_offer", {
        args: { load_ref: "LD-10401" },
        result: { action: "offer", rate_cents: 233000 },
      }),
      trace(1, "counter_offer", {
        args: { load_ref: "LD-10999" },
        result: { action: "offer", rate_cents: 180000 },
      }),
    ]);

    expect(view.offers.map((o) => [o.loadRef, o.round])).toEqual([
      ["LD-10401", 1],
      ["LD-10999", 1],
    ]);
  });

  it("shows the gate refusing rather than dropping it", () => {
    // A refusal is the most interesting thing on the screen when it happens:
    // it is the tool layer enforcing policy the prompt cannot.
    const view = projectCall([
      trace(0, "counter_offer", {
        args: { load_ref: "LD-10401", mc_number: "186800" },
        result: { action: "error", reason: "carrier_not_verified", message: "Verify first." },
      }),
      trace(1, "book_load", {
        args: { load_ref: "LD-10401", mc_number: "186800", rate_cents: 999999 },
        result: { booked: false, reason: "above_last_offer" },
      }),
    ]);

    expect(view.refusals).toEqual([
      { tool: "counter_offer", reason: "carrier_not_verified" },
      { tool: "book_load", reason: "above_last_offer" },
    ]);
    expect(view.offers).toEqual([]);
    expect(view.booking).toBeNull();
  });

  it("records a booking", () => {
    const view = projectCall([
      trace(0, "book_load", {
        args: { load_ref: "LD-10401", mc_number: "186800", rate_cents: 266000 },
        result: { booked: true, load_ref: "LD-10401", rate_cents: 266000, carrier_mc: "186800" },
      }),
      trace(1, "end_call", { result: { ended: true, outcome: "booked", summary: "Covered." } }),
    ]);

    expect(view.booking).toEqual({ loadRef: "LD-10401", rateCents: 266000 });
    expect(view.outcome).toBe("booked");
    expect(view.ended).toBe(true);
  });

  it("treats escalation as an ending", () => {
    const view = projectCall([
      trace(0, "escalate_to_human", { result: { escalated: true, reason: "FMCSA unreachable" } }),
    ]);

    expect(view.ended).toBe(true);
    expect(view.outcome).toBe("escalated");
  });

  // `withTrace` records a thrown tool as `{ error }`, which is still an object —
  // so an ungated branch reads a failed hang-up as a clean one, disables the
  // composer, and leaves the run `in_progress` on a server that never finished
  // it. Both enders gate on their success marker, like every other case.
  it.each([
    ["end_call", { error: "runs.finish timed out" }],
    ["escalate_to_human", { error: "runs.finish timed out" }],
  ])("does not end the call when %s threw", (tool, result) => {
    const view = projectCall([trace(0, tool, { result })]);

    expect(view.ended).toBe(false);
    expect(view.outcome).toBeNull();
    expect(view.refusals).toEqual([{ tool, reason: "runs.finish timed out" }]);
  });
});

describe("projectCall — resilience", () => {
  it("leaves the view unchanged for a shape it does not recognise", () => {
    // A rendering bug must never be able to take down the pane showing a live
    // call, so every read is defensive rather than trusting.
    const view = projectCall([
      trace(0, "lookup_carrier", { result: "not an object" }),
      trace(1, "counter_offer", { result: { action: "offer" } }),
      trace(2, "book_load", { result: null }),
      trace(3, "some_tool_from_the_future", { result: { fine: true } }),
    ]);

    expect(view.carrier).toBeNull();
    expect(view.offers).toEqual([]);
    expect(view.booking).toBeNull();
    expect(view.trace).toHaveLength(4);
  });

  it("numbers trace rows across the whole call, not per turn", () => {
    // Found by looking at the screen. `CallEvent.index` is local to one HTTP
    // connection and restarts at zero every turn, so using it would label the
    // rows 1, 2, 1, 2 — and as a React key it would collide outright. This is
    // the client-side twin of the run_events.seq fix.
    const turnOne: CallEvent[] = [
      trace(0, null, { type: "user_message", result: "MC 186800" }),
      trace(1, "lookup_carrier", { result: { found: false } }),
      trace(2, "get_load", { result: { found: false, load_ref: "LD-10401" } }),
    ];
    const turnTwo: CallEvent[] = [
      trace(0, null, { type: "user_message", result: "What can you pay?" }),
      trace(1, "counter_offer", { result: { action: "error", reason: "load_not_found" } }),
    ];

    const view = projectCall([...turnOne, ...turnTwo]);

    expect(view.trace.map((row) => row.ordinal)).toEqual([1, 2, 3]);
    expect(new Set(view.trace.map((row) => row.ordinal)).size).toBe(view.trace.length);
  });

  it("keeps every tool call in the trace regardless of what it means", () => {
    // The trace pane is the raw record. It renders rows the rest of the view
    // has no opinion about, which is what makes it worth reading.
    const view = projectCall([
      trace(0, "get_load", { result: { found: false, load_ref: "LD-99999" } }),
      trace(1, "check_compliance", { result: { verified: false, reason: "not_looked_up" } }),
    ]);

    expect(view.trace.map((r) => r.name)).toEqual(["get_load", "check_compliance"]);
    expect(view.loadRef).toBeNull();
  });

  it("carries a stream error onto the view", () => {
    const view = projectCall([{ kind: "error", message: "model overloaded" }]);
    expect(view.error).toBe("model overloaded");
  });
});
