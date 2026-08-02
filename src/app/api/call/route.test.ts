import { afterEach, describe, expect, it, vi } from "vitest";

import { CallState } from "@/lib/agent/state";
import type { CallSession } from "@/lib/call/session";
import { sessions } from "@/lib/call/session";
import { makeHarness } from "@/lib/tools/harness";

import { POST } from "./route";

/**
 * The start endpoint, called directly.
 *
 * `startCall` is the one thing mocked, and it has to be: it opens a Neon
 * connection and writes a `runs` row, which is exactly what `pnpm test` may
 * never do. What is being tested here is the handler's own contract — the status
 * codes, and that a successful start actually lands in the store, because a
 * `run_id` handed to a browser with no session behind it 409s on the first turn.
 */
vi.mock("@/lib/call/start", () => ({ startCall: vi.fn() }));

const { startCall } = await import("@/lib/call/start");
const startCallMock = vi.mocked(startCall);

const opened: string[] = [];

function fakeSession(runId: string, mcClaimed: string | null): CallSession {
  const harness = makeHarness();
  opened.push(runId);
  return {
    runId,
    mcClaimed,
    deps: harness.deps,
    state: new CallState(runId),
    messages: [],
    inFlight: false,
    lastTouchedAtMs: Date.now(),
  };
}

function start(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

afterEach(() => {
  for (const runId of opened.splice(0)) sessions.delete(runId);
  vi.restoreAllMocks();
  startCallMock.mockReset();
});

describe("POST /api/call", () => {
  it("opens a call and leaves the session where the turn endpoint will look", async () => {
    // The two halves have to happen together. A `run_id` returned without a
    // session behind it is a browser that 409s on its first turn with no way to
    // recover but "new call".
    startCallMock.mockResolvedValue(fakeSession("run-start-1", "186800"));

    const response = await start({ mc_number: "186800" });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ run_id: "run-start-1" });
    expect(sessions.get("run-start-1")?.runId).toBe("run-start-1");
  });

  it("treats a missing mc_number as a claim not yet made", async () => {
    // The opener is free text and the MC is scraped from it, so a caller who
    // has not said one yet is ordinary rather than an error. It is recorded on
    // the `runs` row and never trusted — the gate re-reads FMCSA regardless.
    startCallMock.mockResolvedValue(fakeSession("run-start-2", null));

    const response = await start({});

    expect(response.status).toBe(201);
    expect(startCallMock).toHaveBeenCalledWith({ mcClaimed: null });
  });

  it("answers 503 when the call cannot be opened, with the reason", async () => {
    // Missing DATABASE_URL, a Neon timeout, a failed `runs` insert. The console
    // has to be able to say what went wrong rather than showing a dead button.
    vi.spyOn(console, "error").mockImplementation(() => {});
    startCallMock.mockRejectedValue(new Error("DATABASE_URL is not set."));

    const response = await start({ mc_number: "186800" });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "call_unavailable",
      message: "DATABASE_URL is not set.",
    });
  });

  it("rejects a body that is not the shape it says it is", async () => {
    const response = await start({ mc_number: 186800 });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
    expect(startCallMock).not.toHaveBeenCalled();
  });
});
