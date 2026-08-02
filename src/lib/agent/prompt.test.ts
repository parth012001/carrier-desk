import { describe, expect, it } from "vitest";

import { SYSTEM_PROMPT } from "./prompt";

/**
 * The prompt is not where policy lives (docs/DECISIONS.md #4), and the way that
 * stops being true is gradual: someone debugging a bad negotiation adds "never
 * go above the ceiling" to the prompt as a quick fix, it appears to help, and
 * the structural guarantee quietly becomes a suggestion the model weighs
 * against whatever the carrier just said.
 *
 * These tests make that edit fail loudly instead.
 */
describe("the system prompt", () => {
  const lower = SYSTEM_PROMPT.toLowerCase();

  it("never names the rate policy", () => {
    for (const forbidden of ["ceiling", "walk-away", "walk away max", "rate floor", "maximum rate"]) {
      expect(lower, `prompt must not mention "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it("contains no rate policy numbers at all", () => {
    // Any bare number here is a rate rule leaking in. Load details come from
    // get_load at runtime; nothing about money belongs in a static string.
    const numbers = SYSTEM_PROMPT.match(/\$[\d,]+|\b\d{3,}\b/g) ?? [];
    expect(numbers).toEqual([]);
  });

  it("does not tell the model to enforce a limit", () => {
    // "Do not exceed X" in a prompt is exactly the guardrail this project
    // argues does not hold. If it appears here, the tool layer has stopped
    // being the thing doing the work.
    for (const forbidden of ["do not exceed", "never exceed", "must not go above", "maximum you"]) {
      expect(lower).not.toContain(forbidden);
    }
  });

  it("sends the model to the tool for the number", () => {
    expect(lower).toContain("counter_offer");
    expect(lower).toContain("do not invent rates");
  });

  it("orders verification before negotiation", () => {
    expect(lower.indexOf("lookup_carrier")).toBeLessThan(lower.indexOf("counter_offer"));
    expect(lower.indexOf("lookup_carrier")).toBeLessThan(lower.indexOf("book_load"));
  });

  it("names every tool the agent is expected to reach for", () => {
    for (const name of [
      "lookup_carrier",
      "get_load",
      "counter_offer",
      "book_load",
      "escalate_to_human",
      "end_call",
    ]) {
      expect(lower, `prompt should tell the agent about ${name}`).toContain(name);
    }
  });
});
