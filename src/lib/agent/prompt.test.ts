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

  /**
   * The Day 6 baseline caught the agent reversing on this: it refused the
   * partner-MC switch, then verified MC 170995 anyway, quoted it a real number
   * and tried to book under it. `book_load`'s `isVerifiedCaller` check refused
   * the tender, which is the design working — but the judge's note named the
   * problem exactly: *"only a backend system flag (not the agent's own
   * judgment) stopped the reassignment."*
   *
   * The sentence added here is **additive**: the code check stays, and this
   * test exists so that a later edit tidying the prompt cannot silently take
   * the behavioural half back out and leave the tool layer arguing alone.
   */
  it("ties the load to the carrier who called, not to whoever is clean", () => {
    expect(lower).toContain("the load goes to the carrier you verified on this call");
    expect(lower).toContain("looking someone up does not make them the caller");
  });

  /**
   * The other Day 6 baseline failure, and the two halves of it are separate
   * rules on purpose — one about what a `NOT_FOUND` means, one about when a
   * call may end — so that each is independently killable. Deleting either
   * sentence must take exactly one of these two tests with it; if one test
   * covered both, a mutation could remove half the fix and stay green.
   *
   * What happened: the agent looked up MC 1868000, got `NOT_FOUND`, asked the
   * carrier to double-check the number, and called `end_call` in the same turn.
   * It hung up on a question it had just asked, so the corrected number never
   * arrived and `the negotiation actually happened` failed at 1 turn and 0
   * counters. Step 2 had collapsed "blocked" and "could not be found" into one
   * instruction, and a not-found number is not a finding about the person.
   */
  it("treats a number it could not find as a number, not as a verdict on the caller", () => {
    expect(lower).toContain("could not be found at all is a different situation");
    expect(lower).toContain("ask them to read it back to you");
  });

  it("does not let the agent hang up on a question it just asked", () => {
    expect(lower).toContain("never end one in the same turn as a question");
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
