import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryTraceSink, type TraceSink, withTrace } from "./trace";

/** A sink whose backing store is gone: a Neon blip, or a closed HTTP stream. */
class DeadTraceSink implements TraceSink {
  attempts = 0;

  async write(): Promise<void> {
    this.attempts++;
    throw new Error("Neon connect timeout");
  }
}

describe("withTrace", () => {
  it("records the call with its args, result and duration", async () => {
    const sink = new InMemoryTraceSink();
    const traced = withTrace("get_load", sink, async (args: { ref: string }) => ({
      ref: args.ref,
      miles: 1380,
    }));

    const result = await traced({ ref: "LD-10400" });

    expect(result).toEqual({ ref: "LD-10400", miles: 1380 });
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      seq: 0,
      type: "tool_call",
      name: "get_load",
      args: { ref: "LD-10400" },
      result: { ref: "LD-10400", miles: 1380 },
    });
    expect(sink.events[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("still writes a row when the tool throws, then rethrows", async () => {
    // A trace that records only successes is worse than no trace, because it
    // looks complete — and the run where something blew up is exactly the run
    // someone will read this for.
    const sink = new InMemoryTraceSink();
    const traced = withTrace("book_load", sink, async () => {
      throw new Error("Neon connect timeout");
    });

    await expect(traced({})).rejects.toThrow("Neon connect timeout");

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      type: "tool_call",
      name: "book_load",
      result: { error: "Neon connect timeout" },
    });
  });

  it("numbers events densely, with no gaps", async () => {
    // Sequencing lives in the sink, not in callers, because that is the only
    // place it can be guaranteed. A trace with holes is one nobody trusts.
    const sink = new InMemoryTraceSink();
    const ok = withTrace("a", sink, async () => "fine");
    const boom = withTrace("b", sink, async () => {
      throw new Error("nope");
    });

    await ok({});
    await expect(boom({})).rejects.toThrow();
    await ok({});

    expect(sink.events.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it("never reports a negative duration", async () => {
    // performance.now() is monotonic; Date.now() is not. On a machine whose
    // clock runs slow and gets corrected mid-run, that difference is reachable.
    const sink = new InMemoryTraceSink();
    const traced = withTrace("slow", sink, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return "done";
    });

    await traced({});

    expect(sink.events[0].durationMs).toBeGreaterThan(0);
  });

  it("separates tool calls from messages", async () => {
    const sink = new InMemoryTraceSink();
    await sink.write({ type: "user_message", result: "MC 186800" });
    await withTrace("lookup_carrier", sink, async () => ({ decision: "allow" }))({});
    await sink.write({ type: "assistant_message", result: "You're verified." });

    expect(sink.events).toHaveLength(3);
    expect(sink.toolCalls()).toHaveLength(1);
    expect(sink.toolCalls()[0].name).toBe("lookup_carrier");
  });
});

describe("withTrace, when the sink itself fails", () => {
  // A trace row is a record of work, never part of it. These two tests are the
  // whole reason `writeTrace` exists; both of them fail against a `withTrace`
  // that awaits `sink.write` inside the same `try` as `execute`.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the tool's result unchanged when the trace write fails", async () => {
    // The booking bug. `book_load` returns `{booked: true}` and `cover()` has
    // already written `covered` to Postgres. If the trace write can reroute
    // that into the catch, the load is booked in the database while the model
    // is told it failed — and the carrier is told to try again.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sink = new DeadTraceSink();
    const booked = { booked: true as const, load_ref: "LD-10401", rate_cents: 266000 };
    const traced = withTrace("book_load", sink, async () => booked);

    await expect(traced({ load_ref: "LD-10401" })).resolves.toEqual(booked);
    expect(sink.attempts).toBe(1);
  });

  it("propagates the tool's error, not the sink's, when both fail", async () => {
    // The masking bug. The catch's own `sink.write` threw against the same dead
    // sink, so `throw error` never ran and whoever was debugging saw the
    // tracing failure instead of the one that actually broke the call.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sink = new DeadTraceSink();
    const traced = withTrace("book_load", sink, async () => {
      throw new Error("loads.cover deadlocked");
    });

    await expect(traced({})).rejects.toThrow("loads.cover deadlocked");
    expect(sink.attempts).toBe(1);
  });

  it("reports a dropped row rather than swallowing it silently", async () => {
    // Observability is a feature here, so a hole in the trace has to be visible
    // to whoever reads the logs. Just never to the tool that was traced.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sink = new DeadTraceSink();

    await withTrace("lookup_carrier", sink, async () => ({ decision: "allow" }))({});

    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0].join(" ")).toContain("lookup_carrier");
  });
});
