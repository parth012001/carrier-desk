import type { LanguageModel, ModelMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CallState } from "@/lib/agent/state";
import type { CallSession } from "@/lib/call/session";
import { sessions } from "@/lib/call/session";
import { makeHarness } from "@/lib/tools/harness";
import { MC_ALLOWED } from "@/lib/tools/harness";
import { scriptedModel } from "@/test/fake-model";

import { POST } from "./route";

/**
 * The turn endpoint, called directly.
 *
 * It is a plain Web `Request` in and `Response` out and vitest already runs in
 * `environment: "node"`, so there is nothing to stand up — no server, no fetch,
 * no DOM. The session comes from `makeHarness`, which builds a complete
 * `AgentDeps` and `CallState` against fixtures with no database and no network.
 *
 * Only `agentModel` is replaced. `runCall` also reads `cachedInstructions` and
 * `AGENT_PROVIDER_OPTIONS` from that module, and those carry the prompt-cache
 * breakpoint the payload tests assert on — mocking the module wholesale would
 * quietly swap them for undefined.
 */
const scripted = vi.hoisted(() => ({ model: null as LanguageModel | null }));

vi.mock("@/lib/agent/models", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/models")>()),
  agentModel: () => {
    if (scripted.model === null) throw new Error("no model scripted for this test");
    return scripted.model;
  },
}));

const REF = "LD-10400";

let counter = 0;
const opened: string[] = [];

function openSession(overrides: Partial<CallSession> = {}): {
  session: CallSession;
  harness: ReturnType<typeof makeHarness>;
} {
  const runId = `run-turn-${++counter}`;
  const harness = makeHarness();
  const session: CallSession = {
    runId,
    mcClaimed: null,
    deps: harness.deps,
    // `makeHarness` keys its state to its own run id; the route only ever reads
    // the object, but keeping the two in step makes a trace easier to follow.
    state: new CallState(runId),
    messages: [],
    inFlight: false,
    lastTouchedAtMs: Date.now(),
    ...overrides,
  };
  sessions.put(session);
  opened.push(runId);
  return { session, harness: { ...harness, state: session.state } };
}

function turn(runId: string, body: unknown): Promise<Response> {
  return POST(
    new Request(`http://localhost/api/call/${runId}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ runId }) },
  );
}

/** Reads the NDJSON stream to the end. The route closes it in its `finally`. */
async function drain(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("no body to drain");
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

/** How many results for `tool` the committed history actually contains. */
type Part = { type: string; toolName?: string };
function resultsFor(messages: readonly ModelMessage[], tool: string): number {
  return messages
    .flatMap((message): Part[] =>
      typeof message.content === "string" ? [] : (message.content as Part[]),
    )
    .filter((part) => part.type === "tool-result" && part.toolName === tool).length;
}

afterEach(() => {
  for (const runId of opened.splice(0)) sessions.delete(runId);
  scripted.model = null;
  vi.restoreAllMocks();
});

describe("POST /api/call/[runId]/turn — the guards", () => {
  it("refuses an unknown run rather than inventing a session for it", async () => {
    // The only thing standing between a lost session and a silently reset
    // negotiation. Rebuilding a `CallState` here would put `countersUsed` back
    // at 0 and `hasClearedCarrier()` back to false — the three-counter cap would
    // stop existing and nothing on any screen would say so. Until now this was
    // held by a single manual click-through recorded in STATE.md.
    const before = sessions.size();

    const response = await turn("run-that-never-existed", { message: "still there?" });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "session_not_found" });
    expect(sessions.size()).toBe(before);
    expect(sessions.get("run-that-never-existed")).toBeNull();
  });

  it("refuses a second turn while one is in flight", async () => {
    // Two concurrent runs would interleave writes to the same `CallState`, and
    // `CallState` is where the counter cap lives.
    const { session } = openSession({ inFlight: true });

    const response = await turn(session.runId, { message: "and another thing" });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "turn_in_progress" });
  });

  it.each([
    ["an empty message", { message: "   " }],
    ["no message at all", {}],
    ["a message that is not a string", { message: 42 }],
  ])("rejects %s without taking the lock", async (_case, body) => {
    // The parse runs before `inFlight` is set, so a malformed body must not be
    // able to wedge the session — which is the failure the synchronous-throw
    // release exists for, reachable here without a throw at all.
    const { session } = openSession();

    const response = await turn(session.runId, body);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
    expect(session.inFlight).toBe(false);
  });
});

describe("POST /api/call/[runId]/turn — the history it commits", () => {
  it("keeps the steps that finished when a later one fails", async () => {
    // The invariant: the model's history is never less than what the tool layer
    // has already done. `counter_offer` consumes a counter from `CallState` and
    // writes a `negotiations` row as it executes, and neither is rolled back —
    // so a turn that discards its messages leaves the tool layer believing one
    // counter has been spent while the model believes it is still opening. Two
    // of those and the schedule hands the carrier the lane rate on their first
    // sentence.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { session, harness } = openSession();

    // One turn short on purpose: the loop asks for a third model call after
    // counter_offer has already run, and the fake throws rather than repeating.
    // That is the shape of an overloaded provider or a dropped connection.
    scripted.model = scriptedModel([
      { call: [{ tool: "lookup_carrier", input: { mc_number: MC_ALLOWED } }] },
      { call: [{ tool: "counter_offer", input: { load_ref: REF, mc_number: MC_ALLOWED } }] },
    ]);

    const response = await turn(session.runId, { message: "MC 186800 — what can you do on LD-10400?" });
    expect(response.status).toBe(200);
    const body = await drain(response);

    // The turn really did fail. This is not a test of the happy path.
    expect(body).toContain('"kind":"error"');
    expect(session.inFlight).toBe(false);

    expect(harness.state.countersUsed(REF)).toBe(1);
    expect(resultsFor(session.messages, "counter_offer")).toBe(harness.state.countersUsed(REF));
    // And the carrier's own turn is in there, not just the agent's side of it.
    expect(session.messages[0]).toEqual({
      role: "user",
      content: "MC 186800 — what can you do on LD-10400?",
    });
  });

  it("leaves the session alone when the turn failed before any step finished", async () => {
    // Nothing ran, so there is nothing to keep — and appending the user turn
    // anyway would stack an orphan on every retry.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { session, harness } = openSession();
    scripted.model = scriptedModel([]);

    await drain(await turn(session.runId, { message: "still there?" }));

    expect(harness.state.countersUsed(REF)).toBe(0);
    expect(session.messages).toEqual([]);
  });
});
