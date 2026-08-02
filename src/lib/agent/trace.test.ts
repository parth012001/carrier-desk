import { describe, expect, it } from "vitest";

import { InMemoryTraceSink, withTrace } from "./trace";

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
