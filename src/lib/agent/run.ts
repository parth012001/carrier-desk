import { type LanguageModel, type ModelMessage, type ToolSet, generateText, hasToolCall, isStepCount } from "ai";

import { AGENT_PROVIDER_OPTIONS, cachedInstructions } from "./models";
import { SYSTEM_PROMPT } from "./prompt";
import { type TraceSink, writeTrace } from "./trace";

/**
 * The headless conversation loop.
 *
 * `model` is an argument, not an import. That single seam is what makes "no
 * live API in `pnpm test`" mechanical instead of aspirational: production
 * passes `anthropic("claude-sonnet-5")`, tests pass a scripted fake, and
 * nothing in between has to know which.
 *
 * There is no streaming and no UI here, and there will not be. Day 5 runs
 * hundreds of adversarial turns through this function; anything that couples
 * conversation policy to a transport makes that harder for no benefit. Day 4's
 * interface wraps this, not the other way round.
 */

/**
 * Enough steps for verify → present → three counters → book → end, with room
 * for the model to talk in between, and low enough that a loop which fails to
 * terminate costs a bounded number of API calls rather than an unbounded one.
 */
export const DEFAULT_MAX_STEPS = 12;

/** The tools that end a call. Reaching one of these stops the loop. */
export const TERMINAL_TOOLS = ["end_call", "escalate_to_human"] as const;

export type RunCallOptions = {
  model: LanguageModel;
  tools: ToolSet;
  messages: ModelMessage[];
  trace: TraceSink;
  /** Defaults to SYSTEM_PROMPT. Overridable so evals can probe prompt variants. */
  instructions?: string;
  maxSteps?: number;
};

export type RunCallResult = {
  /** The agent's final text. */
  text: string;
  stepCount: number;
  /** Tool names in call order — the spine of the trace. */
  toolCalls: string[];
  /** Whether the loop ended because the agent said so, or because it ran out of steps. */
  stoppedOnStepCap: boolean;
  usage: Awaited<ReturnType<typeof generateText>>["usage"];
  /**
   * The assistant and tool messages this turn produced, ready to append to the
   * history for the next one. A multi-turn call has to carry tool results
   * forward or the model loses what it just learned — and it is also what keeps
   * the cached prefix growing instead of resetting.
   */
  responseMessages: ModelMessage[];
};

export async function runCall(options: RunCallOptions): Promise<RunCallResult> {
  const {
    model,
    tools,
    messages,
    trace,
    instructions = SYSTEM_PROMPT,
    maxSteps = DEFAULT_MAX_STEPS,
  } = options;

  // The carrier's turn goes in the trace before anything acts on it, so a run
  // that crashes mid-call still shows what was said to it.
  // `writeTrace`, not `trace.write`: a sink that throws must never be able to
  // fail the call it is describing. In `onStepFinish` below that is not
  // theoretical — the callback's rejection propagates out of `generateText`,
  // so a trace write failing on step 4 would abort a run whose `book_load` on
  // step 3 had already committed.
  const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
  if (lastUserMessage) {
    await writeTrace(trace, { type: "user_message", result: lastUserMessage.content });
  }

  const result = await generateText({
    model,
    // The object form, not a bare string: only this one can carry the cache
    // breakpoint. See models.ts.
    instructions: cachedInstructions(instructions),
    messages,
    tools,
    providerOptions: AGENT_PROVIDER_OPTIONS,
    // Two independent stops. The terminal tools are the ordinary way a call
    // ends; the step cap is the backstop for a model that will not stop, and
    // it is why a runaway loop costs a bounded number of API calls.
    stopWhen: [isStepCount(maxSteps), hasToolCall(...TERMINAL_TOOLS)],
    onStepFinish: async ({ text }) => {
      if (text.trim() !== "") await writeTrace(trace, { type: "assistant_message", result: text });
    },
  });

  const toolCalls = result.steps.flatMap((step) => step.toolCalls).map((call) => call.toolName);

  return {
    text: result.text,
    stepCount: result.steps.length,
    toolCalls,
    // A run that hits the cap without a terminal tool did not finish; it was
    // cut off. The caller needs to be able to tell those apart.
    stoppedOnStepCap:
      result.steps.length >= maxSteps &&
      !toolCalls.some((name) => (TERMINAL_TOOLS as readonly string[]).includes(name)),
    usage: result.usage,
    responseMessages: result.response.messages,
  };
}
