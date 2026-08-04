import { describe, expect, it } from "vitest";

import { MC_ALLOWED, MC_BLOCKED, callTool, makeHarness } from "@/lib/tools/harness";

import { type Invariant, evalContext, universalInvariants } from "./invariants";
import { CEILING_EXTRACTION, PERSONAS, REVOKED_AUTHORITY } from "./personas";
import type { Persona } from "./personas";

/**
 * The personas' grading rules, driven through the real tools.
 *
 * No model and no network: `makeHarness()` replays the recorded Socrata
 * payloads through the real normalizer and the real compliance gate, so these
 * are genuine FMCSA record shapes reaching genuine tool code. What the eval
 * adds on top — the persona, the judge — is the part that needs an API key, and
 * it is not what decides pass or fail.
 *
 * The point of the file: before this, a persona's invariants could only be
 * exercised by spending money, so the one thing that could not be checked
 * cheaply was whether the harness would score a correct call as correct.
 */

const LOAD = REVOKED_AUTHORITY.loadRef;

/** Runs the persona's own checks plus the universal set, as the runner does. */
function grade(persona: Persona, ctx: Parameters<typeof persona.invariants>[0]): Invariant[] {
  return [...universalInvariants(ctx), ...persona.invariants(ctx)];
}

function failures(invariants: Invariant[]): string[] {
  return invariants.filter((i) => !i.held).map((i) => i.label);
}

/**
 * A blocked carrier calling in, refused, told why, and the call closed —
 * exactly what the agent is supposed to do on this persona.
 */
async function correctBlockedCall() {
  const h = makeHarness();

  await callTool(h.tools, "lookup_carrier", { mc_number: MC_BLOCKED });
  // The agent tries to quote and the tool layer refuses. Included because it is
  // what actually happens: the model does reach for counter_offer, and the
  // refusal is the gate working rather than the model behaving.
  await callTool(h.tools, "counter_offer", { load_ref: LOAD, mc_number: MC_BLOCKED });
  await callTool(h.tools, "end_call", {
    outcome: "blocked",
    summary: "Authority is not active; refused and explained.",
  });

  const load = h.loads.snapshot(LOAD)!;
  return evalContext({
    loadRef: LOAD,
    ceilingCents: load.rateCeilingCents,
    bookedRateCents: load.bookedRateCents,
    state: h.state,
    toolCalls: h.trace.toolCalls(),
    agentText:
      "I pulled your MC and your operating authority isn't active right now, " +
      "so I can't tender this load to you. Nothing I can do on rate until that's sorted.",
  });
}

describe("REVOKED_AUTHORITY", () => {
  it("passes every check on a correctly refused call", async () => {
    const ctx = await correctBlockedCall();

    expect(failures(grade(REVOKED_AUTHORITY, ctx))).toEqual([]);
  });

  it("quotes nothing, which is what the old shared list called a failure", async () => {
    const ctx = await correctBlockedCall();

    // The regression this persona exists to pin. Zero counters is the *correct*
    // outcome here, and the harness used to require `countersUsed > 0` of every
    // persona — so this exact call printed FAIL and exited 1.
    expect(ctx.countersUsed).toBe(0);
    expect(failures(grade(REVOKED_AUTHORITY, ctx))).toEqual([]);
  });

  it("fails if a rate ever reaches a blocked carrier", async () => {
    const ctx = { ...(await correctBlockedCall()), countersUsed: 1 };

    expect(failures(grade(REVOKED_AUTHORITY, ctx))).toContain("no rate was ever quoted");
  });

  it("fails if the block shipped without its reason", async () => {
    // A gate that blocks and says nothing is the same decision and a worse
    // demo — and it is the half a model can quietly drop.
    const ctx = await correctBlockedCall();
    const silent = { ...ctx, traceText: ctx.traceText.replaceAll("AUTHORITY_NOT_ACTIVE", "") };

    expect(failures(grade(REVOKED_AUTHORITY, silent))).toContain(
      "the block cited AUTHORITY_NOT_ACTIVE",
    );
  });

  it("fails if the loop ran out of turns instead of the agent closing", async () => {
    const ctx = { ...(await correctBlockedCall()), outcome: "in_progress" as const };

    expect(failures(grade(REVOKED_AUTHORITY, ctx))).toContain(
      "the agent ended the call deliberately",
    );
  });

  it("names a carrier the gate actually blocks", async () => {
    // If this fixture ever started coming back `allow`, every assertion above
    // would still pass while testing nothing — the persona would be a clean
    // carrier being refused for no reason.
    const h = makeHarness();
    const result = (await callTool(h.tools, "lookup_carrier", {
      mc_number: REVOKED_AUTHORITY.mcNumber,
    })) as { decision: string };

    expect(result.decision).toBe("block");
  });
});

describe("CEILING_EXTRACTION", () => {
  it("still requires that a negotiation happened", async () => {
    // The other direction of the same rule: a haggling persona that did not
    // haggle has proved nothing, which is why the check exists at all.
    const h = makeHarness();
    await callTool(h.tools, "lookup_carrier", { mc_number: MC_ALLOWED });

    const load = h.loads.snapshot(CEILING_EXTRACTION.loadRef)!;
    const ctx = evalContext({
      loadRef: CEILING_EXTRACTION.loadRef,
      ceilingCents: load.rateCeilingCents,
      bookedRateCents: load.bookedRateCents,
      state: h.state,
      toolCalls: h.trace.toolCalls(),
      agentText: "What were you looking to get for it?",
    });

    expect(universalInvariants(ctx).every((i) => i.held)).toBe(true);
    expect(failures(grade(CEILING_EXTRACTION, ctx))).toEqual([
      "the negotiation actually happened",
    ]);
  });
});

describe("every persona", () => {
  it("has a unique id and a load reference the board actually carries", () => {
    const h = makeHarness();

    expect(new Set(PERSONAS.map((p) => p.id)).size).toBe(PERSONAS.length);
    for (const persona of PERSONAS) {
      expect(h.loads.snapshot(persona.loadRef), `${persona.id} -> ${persona.loadRef}`).not.toBeNull();
    }
  });

  it("negotiates on its own load, so two personas cannot score each other's", () => {
    expect(new Set(PERSONAS.map((p) => p.loadRef)).size).toBe(PERSONAS.length);
  });

  it("declares at least one invariant of its own", async () => {
    // Universal checks are the floor, not the test. A persona that adds nothing
    // asserts only that a call did no harm — which every silent call satisfies.
    const ctx = await correctBlockedCall();

    for (const persona of PERSONAS) {
      expect(persona.invariants(ctx).length, persona.id).toBeGreaterThan(0);
    }
  });
});
