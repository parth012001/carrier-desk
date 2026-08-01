import { generateText } from "ai";
import { describe, expect, it } from "vitest";

import { sayingModel } from "@/test/fake-model";
import {
  AGENT_MODEL_ID,
  AGENT_PROVIDER_OPTIONS,
  JUDGE_MODEL_ID,
  PERSONA_MODEL_ID,
  cachedInstructions,
} from "./models";

/**
 * These assert on the *payload* — what actually reaches the provider — not on
 * the shape of a constant. A settings object can look right and still be
 * dropped, overridden, or renamed by an SDK upgrade; `doGenerateCalls` is the
 * only place the answer is unambiguous.
 *
 * Same technique the ceiling assertion uses. Rehearsing it here on a cheap case
 * is deliberate.
 */

describe("agent call settings", () => {
  it("never disables thinking on a tool-calling path", async () => {
    // The documented failure mode: with thinking disabled the model writes a
    // tool call into visible text instead of a tool_use block. The turn
    // succeeds, and the call silently never runs. For a system whose whole
    // claim is that policy lives in the tool layer, a dropped book_load is the
    // worst bug available. See docs/DECISIONS.md #15.
    const model = sayingModel();

    await generateText({
      model,
      prompt: "hello",
      providerOptions: AGENT_PROVIDER_OPTIONS,
    });

    const sent = JSON.stringify(model.doGenerateCalls[0]?.providerOptions ?? {});
    expect(sent).not.toContain("disabled");
    expect(sent).not.toContain("budgetTokens");
  });

  it("sends no thinking key at all, so the model's own default applies", async () => {
    // Sonnet 5 runs adaptive thinking when the parameter is absent. Sending
    // `{ type: "adaptive" }` explicitly would be equivalent today but would
    // also be one more thing to keep in sync with the model's defaults.
    const model = sayingModel();

    await generateText({
      model,
      prompt: "hello",
      providerOptions: AGENT_PROVIDER_OPTIONS,
    });

    const anthropicOptions = model.doGenerateCalls[0]?.providerOptions?.anthropic ?? {};
    expect(Object.keys(anthropicOptions)).not.toContain("thinking");
  });

  it("carries the benchmarked effort level through to the provider", async () => {
    const model = sayingModel();

    await generateText({
      model,
      prompt: "hello",
      providerOptions: AGENT_PROVIDER_OPTIONS,
    });

    expect(model.doGenerateCalls[0]?.providerOptions?.anthropic).toMatchObject({
      effort: "medium",
    });
  });

  it("reaches the provider as an ephemeral cache breakpoint on the system block", async () => {
    // Anthropic renders tools -> system -> messages, so a breakpoint here
    // covers the tool schemas and the system prompt together.
    //
    // Note the shape: AI SDK 7 rejects a system entry inside `messages`, and
    // only the SystemModelMessage form of `instructions` can carry
    // providerOptions. A bare `instructions: "..."` string would silently have
    // no breakpoint at all, which is the failure this test exists to catch.
    const model = sayingModel();

    await generateText({
      model,
      instructions: cachedInstructions("stable prefix"),
      messages: [{ role: "user", content: "volatile turn" }],
    });

    const systemPart = model.doGenerateCalls[0]?.prompt.find((m) => m.role === "system");
    expect(systemPart?.providerOptions?.anthropic).toEqual({
      cacheControl: { type: "ephemeral" },
    });
  });

  it("puts the breakpoint ahead of the volatile turn, not after it", async () => {
    // A breakpoint placed after per-call content caches nothing reusable: the
    // prefix differs on every request, so every request writes a fresh entry
    // and none ever reads one. Order is the whole mechanism.
    const model = sayingModel();

    await generateText({
      model,
      instructions: cachedInstructions("stable prefix"),
      messages: [{ role: "user", content: "volatile turn" }],
    });

    const prompt = model.doGenerateCalls[0]?.prompt ?? [];
    const breakpointAt = prompt.findIndex((m) => m.providerOptions?.anthropic != null);
    const userAt = prompt.findIndex((m) => m.role === "user");

    expect(breakpointAt).toBeGreaterThanOrEqual(0);
    expect(breakpointAt).toBeLessThan(userAt);
  });
});

describe("model choices", () => {
  it("matches the benchmark recorded in DECISIONS #15", () => {
    // Pinned so a casual "upgrade the model" edit has to argue with a test.
    // The benchmark that chose these cost real money; changing them should
    // mean re-running it, not editing a string.
    expect(AGENT_MODEL_ID).toBe("claude-sonnet-5");
    expect(JUDGE_MODEL_ID).toBe("claude-sonnet-5");
    expect(PERSONA_MODEL_ID).toBe("claude-haiku-4-5");
  });

  it("runs the judge on at least the agent's tier", () => {
    // A judge weaker than the agent cannot catch the agent's mistakes, and the
    // scorecard it produces is the demo.
    expect(JUDGE_MODEL_ID).not.toBe(PERSONA_MODEL_ID);
  });
});
