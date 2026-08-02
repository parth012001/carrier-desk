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
   *
   * Every step's, not the last one's. See the accumulator in `runCall`.
   */
  responseMessages: ModelMessage[];
};

/**
 * A turn that failed partway, carrying the steps that did complete.
 *
 * The two halves of a turn are not equally reversible, and that asymmetry is
 * the whole reason this type exists. `messages` is a value a caller can throw
 * away; the `negotiations` row `counter_offer` wrote and the counter it consumed
 * are not. A caller that discards a failed turn entirely therefore does not
 * restore the world — it only forgets half of it, and the half it forgets is the
 * half that would have told the model what it already did.
 *
 * See CLAUDE.md, "The model's history is never less than what the tool layer has
 * already done", and `docs/DECISIONS.md` #22.
 */
export class PartialTurnError extends Error {
  constructor(
    cause: unknown,
    /** Every completed step's messages, in order. Empty if none finished. */
    readonly responseMessages: ModelMessage[],
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "PartialTurnError";
  }
}

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
  // fail the call it is describing. In `onStepEnd` below that is not
  // theoretical — the callback's rejection propagates out of `generateText`,
  // so a trace write failing on step 4 would abort a run whose `book_load` on
  // step 3 had already committed.
  const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
  if (lastUserMessage) {
    await writeTrace(trace, { type: "user_message", result: lastUserMessage.content });
  }

  /**
   * Accumulated as steps finish, rather than read off the result at the end.
   *
   * The failure path is why. A step that finished has already run its tools,
   * and a tool that ran has already moved `CallState` and written its rows.
   * `generateText` surfaces nothing at all when a later step throws, so a caller
   * that waits for the return value has no way to keep what completed — and
   * dropping it hands the retry a model that believes it is opening a
   * negotiation the tool layer has already counted.
   *
   * The success path was also wrong. `GenerateTextResult.response` is a getter
   * for `finalStep.response`, so `result.response.messages` is the **last**
   * step's messages alone: every earlier step's tool call and tool result was
   * being dropped from the history a multi-turn call carries forward. This is
   * also narrower than `result.responseMessages`, which prepends any response
   * messages already sitting in `messages` — those are the caller's, and the
   * caller is the one appending to them.
   */
  const responseMessages: ModelMessage[] = [];

  try {
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
      onStepEnd: async (step) => {
        // Recorded first, before anything that can throw or await. A step that
        // reached here is a step whose tools have run, whatever happens next.
        responseMessages.push(...step.response.messages);
        if (step.text.trim() !== "") {
          await writeTrace(trace, { type: "assistant_message", result: step.text });
        }
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
      responseMessages,
    };
  } catch (error) {
    // Rethrown, not swallowed — the turn did fail and the caller has to know.
    // What changes is that the failure now carries the part that succeeded.
    throw new PartialTurnError(error, responseMessages);
  }
}
