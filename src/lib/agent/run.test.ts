import { type ModelMessage, type ToolSet, tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { scriptedModel } from "@/test/fake-model";

import { DEFAULT_MAX_STEPS, PartialTurnError, runCall } from "./run";
import { InMemoryTraceSink, type TraceSink, withTrace } from "./trace";

/**
 * The loop, driven by a scripted model. No live API — the network guard in
 * src/test/setup.ts makes that mechanical rather than a convention.
 */

function toolsWith(sink: InMemoryTraceSink): ToolSet {
  return {
    get_load: tool({
      description: "Look up a load by reference.",
      inputSchema: z.object({ load_ref: z.string() }),
      execute: withTrace("get_load", sink, async ({ load_ref }: { load_ref: string }) => ({
        ref: load_ref,
        miles: 1380,
      })),
    }),
    end_call: tool({
      description: "End the call.",
      inputSchema: z.object({ outcome: z.string() }),
      execute: withTrace("end_call", sink, async ({ outcome }: { outcome: string }) => ({
        ended: outcome,
      })),
    }),
    escalate_to_human: tool({
      description: "Hand the call to a person.",
      inputSchema: z.object({ reason: z.string() }),
      execute: withTrace("escalate_to_human", sink, async ({ reason }: { reason: string }) => ({
        escalated: reason,
      })),
    }),
  };
}

/** The content parts of a message list, flattened. A string content counts as text. */
type Part = { type: string; toolName?: string; text?: string };
const partsOf = (messages: readonly ModelMessage[]): Part[] =>
  messages.flatMap((message) =>
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : (message.content as Part[]),
  );

const named = (messages: readonly ModelMessage[], type: string): (string | undefined)[] =>
  partsOf(messages)
    .filter((part) => part.type === type)
    .map((part) => part.toolName);

describe("runCall — termination", () => {
  it("stops when the agent ends the call", async () => {
    const sink = new InMemoryTraceSink();
    // One scripted turn. If the loop wrongly continued, the fake model throws
    // "script exhausted", which names the bug better than a hang would.
    const model = scriptedModel([{ call: [{ tool: "end_call", input: { outcome: "booked" } }] }]);

    const result = await runCall({
      model,
      tools: toolsWith(sink),
      messages: [{ role: "user", content: "That works, book it." }],
      trace: sink,
    });

    expect(result.toolCalls).toEqual(["end_call"]);
    expect(result.stoppedOnStepCap).toBe(false);
  });

  it("stops when the agent escalates", async () => {
    const sink = new InMemoryTraceSink();
    const model = scriptedModel([
      { call: [{ tool: "escalate_to_human", input: { reason: "FMCSA unreachable" } }] },
    ]);

    const result = await runCall({
      model,
      tools: toolsWith(sink),
      messages: [{ role: "user", content: "Is my authority OK?" }],
      trace: sink,
    });

    expect(result.toolCalls).toEqual(["escalate_to_human"]);
    expect(result.stoppedOnStepCap).toBe(false);
  });

  it("stops at the step cap and says that is why", async () => {
    // The backstop for a model that will not stop. Without it a runaway loop
    // costs an unbounded number of API calls; with it, a bounded one.
    const sink = new InMemoryTraceSink();
    const model = scriptedModel(
      Array.from({ length: 3 }, () => ({
        call: [{ tool: "get_load", input: { load_ref: "LD-10400" } }],
      })),
    );

    const result = await runCall({
      model,
      tools: toolsWith(sink),
      messages: [{ role: "user", content: "Tell me about that load again" }],
      trace: sink,
      maxSteps: 3,
    });

    expect(result.stepCount).toBe(3);
    expect(result.stoppedOnStepCap).toBe(true);
  });

  it("does not call the step cap a cap when the agent finished on its own", async () => {
    const sink = new InMemoryTraceSink();
    const model = scriptedModel([
      { call: [{ tool: "get_load", input: { load_ref: "LD-10400" } }] },
      { call: [{ tool: "end_call", input: { outcome: "rejected" } }] },
    ]);

    const result = await runCall({
      model,
      tools: toolsWith(sink),
      messages: [{ role: "user", content: "Not interested" }],
      trace: sink,
      maxSteps: 2,
    });

    // Hit the cap and ended deliberately on the same step. Reporting that as
    // "cut off" would mislabel a clean call.
    expect(result.stepCount).toBe(2);
    expect(result.stoppedOnStepCap).toBe(false);
  });

  it("leaves room for verify, present, three counters, book and end", () => {
    expect(DEFAULT_MAX_STEPS).toBeGreaterThanOrEqual(8);
  });
});

describe("runCall — the trace", () => {
  it("writes exactly one row per tool call", async () => {
    const sink = new InMemoryTraceSink();
    const model = scriptedModel([
      { call: [{ tool: "get_load", input: { load_ref: "LD-10400" } }] },
      { call: [{ tool: "end_call", input: { outcome: "booked" } }] },
    ]);

    const result = await runCall({
      model,
      tools: toolsWith(sink),
      messages: [{ role: "user", content: "I'll take it" }],
      trace: sink,
    });

    expect(sink.toolCalls()).toHaveLength(result.toolCalls.length);
    expect(sink.toolCalls().map((e) => e.name)).toEqual(["get_load", "end_call"]);
  });

  it("records the carrier's turn before anything acts on it", async () => {
    // A run that crashes mid-call should still show what was said to it.
    const sink = new InMemoryTraceSink();
    const model = scriptedModel([{ call: [{ tool: "end_call", input: { outcome: "abandoned" } }] }]);

    await runCall({
      model,
      tools: toolsWith(sink),
      messages: [{ role: "user", content: "MC 186800, calling on the Laredo load" }],
      trace: sink,
    });

    expect(sink.events[0]).toMatchObject({
      seq: 0,
      type: "user_message",
      result: "MC 186800, calling on the Laredo load",
    });
  });

  it("records what the agent said", async () => {
    const sink = new InMemoryTraceSink();
    const model = scriptedModel([{ say: "You're verified — the load is Laredo to Chicago." }]);

    await runCall({
      model,
      tools: toolsWith(sink),
      messages: [{ role: "user", content: "MC 186800" }],
      trace: sink,
    });

    const assistant = sink.events.filter((e) => e.type === "assistant_message");
    expect(assistant).toHaveLength(1);
    expect(assistant[0].result).toContain("Laredo");
  });

  it("captures every tool call's args and duration, not just its name", async () => {
    const sink = new InMemoryTraceSink();
    const model = scriptedModel([
      { call: [{ tool: "get_load", input: { load_ref: "LD-10412" } }] },
      { call: [{ tool: "end_call", input: { outcome: "booked" } }] },
    ]);

    await runCall({
      model,
      tools: toolsWith(sink),
      messages: [{ role: "user", content: "go" }],
      trace: sink,
    });

    for (const event of sink.toolCalls()) {
      expect(event.args).toBeDefined();
      expect(event.result).toBeDefined();
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
    }
    expect(sink.toolCalls()[0].args).toEqual({ load_ref: "LD-10412" });
  });

  it("numbers the whole run densely across messages and tool calls", async () => {
    const sink = new InMemoryTraceSink();
    const model = scriptedModel([
      { call: [{ tool: "get_load", input: { load_ref: "LD-10400" } }] },
      { say: "That one's covered — anything else?" },
    ]);

    await runCall({
      model,
      tools: toolsWith(sink),
      messages: [{ role: "user", content: "LD-10400?" }],
      trace: sink,
    });

    expect(sink.events.map((e) => e.seq)).toEqual(
      Array.from({ length: sink.events.length }, (_, i) => i),
    );
  });

  it("completes the call even when every trace write fails", async () => {
    // `runCall` writes the user turn before the loop and each assistant turn
    // from `onStepFinish`, whose rejection propagates out of `generateText`.
    // So a sink that dies partway through a call could abort a run whose
    // earlier `book_load` step had already committed a load to `covered`.
    //
    // Streaming the trace to a browser makes that reachable by closing a tab,
    // which is why it is asserted at this level and not only around withTrace.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dead: TraceSink = {
      async write() {
        throw new Error("stream closed by client");
      },
    };
    const model = scriptedModel([
      { call: [{ tool: "get_load", input: { load_ref: "LD-10400" } }] },
      { say: "Still available. Want it?" },
    ]);

    const result = await runCall({
      model,
      tools: toolsWith(new InMemoryTraceSink()),
      messages: [{ role: "user", content: "LD-10400?" }],
      trace: dead,
    });

    expect(result.text).toBe("Still available. Want it?");
    expect(result.toolCalls).toEqual(["get_load"]);
    vi.restoreAllMocks();
  });
});

describe("runCall — the history it hands back", () => {
  it("carries every step's messages, not just the last one's", async () => {
    // `GenerateTextResult.response` is a getter for `finalStep.response`, so
    // reading `result.response.messages` returned the closing text and dropped
    // the tool call and its result — the two things a second turn exists to
    // remember. The next turn's history is built from this list.
    const sink = new InMemoryTraceSink();
    const model = scriptedModel([
      { call: [{ tool: "get_load", input: { load_ref: "LD-10400" } }] },
      { say: "Still available. Want it?" },
    ]);

    const result = await runCall({
      model,
      tools: toolsWith(sink),
      messages: [{ role: "user", content: "LD-10400?" }],
      trace: sink,
    });

    expect(result.responseMessages.map((m) => m.role)).toEqual(["assistant", "tool", "assistant"]);
    expect(named(result.responseMessages, "tool-call")).toEqual(["get_load"]);
    expect(named(result.responseMessages, "tool-result")).toEqual(["get_load"]);
    expect(partsOf(result.responseMessages).some((p) => p.text === "Still available. Want it?")).toBe(
      true,
    );
  });

  it("hands the completed steps back on the failure path instead of losing them", async () => {
    // The tools in a finished step have already run. Whatever the next step does
    // cannot un-run them, so the messages that record them have to survive it —
    // see CLAUDE.md, "the model's history is never less than what the tool layer
    // has already done."
    //
    // The scripted model is one turn short, so the loop's second model call
    // throws after step 1 has completed. That is the shape of a real mid-turn
    // failure: an overloaded provider, a dropped connection, a step timeout.
    const sink = new InMemoryTraceSink();
    const model = scriptedModel([{ call: [{ tool: "get_load", input: { load_ref: "LD-10400" } }] }]);

    const failure = await runCall({
      model,
      tools: toolsWith(sink),
      messages: [{ role: "user", content: "LD-10400?" }],
      trace: sink,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PartialTurnError);
    const partial = failure as PartialTurnError;
    expect(named(partial.responseMessages, "tool-call")).toEqual(["get_load"]);
    expect(named(partial.responseMessages, "tool-result")).toEqual(["get_load"]);
    // The original is not swallowed. Whoever reads the log still gets the cause.
    expect(String((partial.cause as Error).message)).toContain("script exhausted");
  });

  it("carries nothing when the turn failed before a step finished", async () => {
    // Nothing ran, so there is nothing to commit — and a caller that appended an
    // empty list would stack an orphaned user turn on every retry.
    const model = scriptedModel([]);

    const failure = (await runCall({
      model,
      tools: toolsWith(new InMemoryTraceSink()),
      messages: [{ role: "user", content: "LD-10400?" }],
      trace: new InMemoryTraceSink(),
    }).catch((error: unknown) => error)) as PartialTurnError;

    expect(failure).toBeInstanceOf(PartialTurnError);
    expect(failure.responseMessages).toEqual([]);
  });
});
