import { describe, expect, it } from "vitest";

import { InMemoryTraceSink, TeeTraceSink } from "@/lib/agent/trace";
import { buildTools } from "@/lib/tools";
import { MC_ALLOWED, callTool, makeHarness } from "@/lib/tools/harness";

import { type CallSession, InMemorySessionStore } from "./session";

function sessionFor(runId: string, lastTouchedAtMs = Date.now()): CallSession {
  const harness = makeHarness();
  return {
    runId,
    mcClaimed: "186800",
    deps: harness.deps,
    state: harness.state,
    messages: [],
    inFlight: false,
    lastTouchedAtMs,
  };
}

describe("InMemorySessionStore", () => {
  it("hands back the same session, with its state intact", async () => {
    // The point of the store. `CallState` is where countersUsed and
    // verifiedMcNumber live, so turn 2 getting the same object back is what
    // makes the counter cap mean anything across requests.
    const store = new InMemorySessionStore();
    const session = sessionFor("run-1");
    session.state.recordOffer("LD-10401", 233000);
    store.put(session);

    const found = store.get("run-1");

    expect(found).toBe(session);
    expect(found?.state.countersUsed("LD-10401")).toBe(1);
  });

  it("returns null for a run it does not have", async () => {
    // The precondition for the whole design. Callers must fail on this, never
    // rebuild — a fresh CallState resets countersUsed to 0, so the cap quietly
    // stops existing. The store is storage only: it cannot construct a session,
    // so the silent path is not reachable from here.
    const store = new InMemorySessionStore();

    expect(store.get("run-that-never-was")).toBeNull();
  });

  it("forgets sessions nobody came back to", async () => {
    const store = new InMemorySessionStore(1000);
    store.put(sessionFor("stale", Date.now() - 5000));
    store.put(sessionFor("fresh"));

    expect(store.get("stale")).toBeNull();
    expect(store.get("fresh")).not.toBeNull();
    expect(store.size()).toBe(1);
  });

  it("keeps a session alive for as long as it is being used", async () => {
    const store = new InMemorySessionStore(1000);
    const session = sessionFor("run-1", Date.now() - 900);
    store.put(session);

    store.get("run-1");
    const touchedAfterRead = session.lastTouchedAtMs;

    expect(touchedAfterRead).toBeGreaterThan(Date.now() - 100);
  });

  it("drops a session on demand", async () => {
    const store = new InMemorySessionStore();
    store.put(sessionFor("run-1"));

    store.delete("run-1");

    expect(store.get("run-1")).toBeNull();
  });
});

describe("tools are bound to the trace of the turn that uses them", () => {
  it("writes tool calls to the live branch, not only the durable one", async () => {
    // Found live, not in review. `buildTools` captures `deps.trace` at
    // construction, so a tool set built once at call start writes only to the
    // sink that existed then — the durable one. The browser received the
    // conversation and zero tool calls, which is the entire right-hand pane.
    //
    // Rebuilding per turn is what fixes it, so this asserts the property that
    // matters rather than the arrangement: a tool called through a tee'd trace
    // reaches both branches.
    const harness = makeHarness();
    const durable = new InMemoryTraceSink();
    const live = new InMemoryTraceSink();

    const tools = buildTools({
      deps: { ...harness.deps, trace: new TeeTraceSink(durable, live) },
      state: harness.state,
    });
    await callTool(tools, "lookup_carrier", { mc_number: MC_ALLOWED });

    expect(durable.toolCalls().map((e) => e.name)).toEqual(["lookup_carrier"]);
    expect(live.toolCalls().map((e) => e.name)).toEqual(["lookup_carrier"]);
    expect(live.toolCalls()[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("keeps counter state across tool sets built for different turns", async () => {
    // The reason rebuilding tools is safe: `state` is the object that carries
    // countersUsed, and it is shared. If a rebuilt tool set got a fresh
    // CallState, the three-counter cap would reset every turn.
    const harness = makeHarness();
    const forTurn = () =>
      buildTools({
        deps: { ...harness.deps, trace: new InMemoryTraceSink() },
        state: harness.state,
      });

    await callTool(forTurn(), "lookup_carrier", { mc_number: MC_ALLOWED });
    await callTool(forTurn(), "counter_offer", { load_ref: "LD-10400", mc_number: MC_ALLOWED });
    await callTool(forTurn(), "counter_offer", { load_ref: "LD-10400", mc_number: MC_ALLOWED });

    expect(harness.state.countersUsed("LD-10400")).toBe(2);
  });
});
