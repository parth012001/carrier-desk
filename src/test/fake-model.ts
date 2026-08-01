import { MockLanguageModelV4 } from "ai/test";

/**
 * A scripted stand-in for the language model.
 *
 * `pnpm test` never calls a live API — the network guard in setup.ts makes that
 * mechanical — so every test of the tool layer drives the loop with a fixed
 * sequence of turns instead. That is the point: the tool layer's guarantees
 * must hold against *any* sequence of tool calls, including ones a real model
 * would never produce, so being able to script hostile turns is not a
 * convenience, it is how the invariant gets proven.
 *
 * The V4 spec shapes are fiddly and easy to get subtly wrong in ways that
 * typecheck nowhere but run fine (a bare `finishReason: "stop"` reads as
 * `undefined` at runtime). They are written once, here.
 */

/** One assistant turn: either it speaks, or it calls tools. */
export type Turn =
  | { say: string }
  | { call: { tool: string; input: unknown }[] };

type Usage = {
  /** Simulates a prompt-cache read, for tests that assert on caching. */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

function usage({ cacheReadTokens = 0, cacheWriteTokens = 0 }: Usage = {}) {
  return {
    inputTokens: {
      total: 100 + cacheReadTokens,
      noCache: 100,
      cacheRead: cacheReadTokens,
      cacheWrite: cacheWriteTokens,
    },
    outputTokens: { total: 20, text: 20, reasoning: 0 },
  };
}

function resultFor(turn: Turn, index: number, options: Usage) {
  if ("say" in turn) {
    return {
      content: [{ type: "text" as const, text: turn.say }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: usage(options),
      warnings: [],
    };
  }

  return {
    content: turn.call.map((c, i) => ({
      type: "tool-call" as const,
      // Deterministic and readable in a failure message. A random id would make
      // trace assertions unreproducible.
      toolCallId: `call-${index}-${i}`,
      toolName: c.tool,
      input: JSON.stringify(c.input),
    })),
    finishReason: { unified: "tool-calls" as const, raw: undefined },
    usage: usage(options),
    warnings: [],
  };
}

/**
 * Plays `turns` in order, one per model call.
 *
 * Running past the end throws rather than repeating the last turn. A silent
 * replay would let a loop that should have stopped keep going and still pass,
 * which is exactly the class of bug the step cap exists to catch.
 */
export function scriptedModel(turns: Turn[], options: Usage = {}): MockLanguageModelV4 {
  let index = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      const turn = turns[index];
      if (turn === undefined) {
        throw new Error(
          `fake model: script exhausted after ${turns.length} turn(s), but the loop asked for turn ${index + 1}. ` +
            `Either the agent is not stopping when it should, or the script is short.`,
        );
      }
      return resultFor(turn, index++, options);
    },
  });
}

/** The everything-went-fine single turn, for tests that only care about the payload. */
export function sayingModel(text = "ok", options: Usage = {}): MockLanguageModelV4 {
  return scriptedModel([{ say: text }], options);
}

/**
 * Everything the model was actually sent, as one string.
 *
 * `doGenerateCalls` carries the full `LanguageModelV4CallOptions` for every
 * call — the serialized prompt *and* the tool JSON schemas. Searching this is
 * how "the model never saw the ceiling" is asserted at the payload level rather
 * than by intent.
 */
export function everythingSentTo(model: MockLanguageModelV4): string {
  return JSON.stringify(model.doGenerateCalls);
}
