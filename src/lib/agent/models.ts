import { anthropic } from "@ai-sdk/anthropic";
import type { LanguageModel, SystemModelMessage } from "ai";

/**
 * `ai` does not re-export `ProviderOptions` from its root, so it is derived
 * from a type that is exported rather than reaching into `@ai-sdk/provider-utils`,
 * which is a transitive dependency we do not declare.
 */
export type AgentProviderOptions = NonNullable<SystemModelMessage["providerOptions"]>;

/**
 * Model choices and their call settings.
 *
 * These were benchmarked on the real tool loop before being chosen — 36 calls,
 * our own system prompt and seven tools, four adversarial carrier turns. The
 * finding was that single-turn safety is not the differentiator (nothing failed
 * on any model); cost and latency are. See docs/DECISIONS.md #15 for the table.
 *
 * Everything here is a constant rather than an env var on purpose: which model
 * decides whether to book freight is a code review question, not a deploy-time
 * one.
 */

/** Sonnet 5 matched Opus on every case at a quarter the cost and half the latency. */
export const AGENT_MODEL_ID = "claude-sonnet-5";

/**
 * The carrier simulator. Playing a scripted adversary makes no safety calls,
 * and this is where Day 5's turn volume lives, so it runs on the cheap model.
 */
export const PERSONA_MODEL_ID = "claude-haiku-4-5";

/** A bad judge invalidates the scorecard, and the scorecard *is* the demo. */
export const JUDGE_MODEL_ID = "claude-sonnet-5";

/**
 * Call settings for the agent.
 *
 * **There is deliberately no `thinking` key.** On Sonnet 5, omitting the
 * parameter runs adaptive thinking; passing `{ type: "disabled" }` would opt
 * into a documented failure mode where the model writes a tool call into
 * visible *text* instead of a `tool_use` block — the turn succeeds, and the
 * call silently never runs. For a system whose entire claim is "policy lives in
 * the tool layer", a dropped `book_load` is the worst bug available. The right
 * lever for cost is a cheaper model, never less thinking.
 *
 * `effort` measured as a weak lever across low/medium/high, so it is set once
 * here and not tuned per call site.
 */
export const AGENT_PROVIDER_OPTIONS: AgentProviderOptions = {
  anthropic: { effort: "medium" },
};

/**
 * Marks a message as the end of the cacheable prefix.
 *
 * Anthropic renders `tools` → `system` → `messages`, so a breakpoint on the
 * system block covers the tool schemas *and* the system prompt — the two parts
 * of our request that are byte-identical on every turn of every call.
 *
 * Sonnet 5's minimum cacheable prefix is 1024 tokens and our Day 2 prefix
 * measured ~1078, which did NOT cache — marginal enough to be luck. With the
 * real system prompt and seven tool schemas the prefix is comfortably over, but
 * "comfortably" is an assumption, so `pnpm agent:smoke` asserts
 * `cacheReadTokens > 0` on the second turn rather than trusting it.
 */
export const CACHE_BREAKPOINT: AgentProviderOptions = {
  anthropic: { cacheControl: { type: "ephemeral" } },
};

/**
 * The system prompt, marked as the end of the cacheable prefix.
 *
 * AI SDK 7 **rejects** a `role: "system"` entry inside `messages`
 * ("System messages are not allowed in the prompt or messages fields") — the
 * system turn moved to its own `instructions` option, which accepts either a
 * bare string or a `SystemModelMessage`. Only the object form can carry
 * `providerOptions`, and therefore only the object form can carry the cache
 * breakpoint. Encoded here once so no call site has to remember it.
 */
export function cachedInstructions(content: string): SystemModelMessage {
  return { role: "system", content, providerOptions: CACHE_BREAKPOINT };
}

export function agentModel(): LanguageModel {
  return anthropic(AGENT_MODEL_ID);
}

export function personaModel(): LanguageModel {
  return anthropic(PERSONA_MODEL_ID);
}

export function judgeModel(): LanguageModel {
  return anthropic(JUDGE_MODEL_ID);
}
