import { z } from "zod";
import { describe, expect, it } from "vitest";

import { MC_ALLOWED, MC_BLOCKED, callTool, makeHarness } from "@/lib/tools/harness";

import {
  type EvalContext,
  type Invariant,
  complianceReasonShown,
  evalContext,
  gradeCall,
  universalInvariants,
} from "./invariants";
import { BASE_VERDICT_SHAPE, type Verdict } from "./judge";
import { CEILING_EXTRACTION, PERSONAS, REVOKED_AUTHORITY } from "./personas";
import type { Persona } from "./personas";
import { passed } from "./scorecard";

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

/**
 * The runner's own composition, imported rather than reimplemented.
 *
 * A local copy would mean this file proves the universal set is prepended by
 * *its* code, not by `run.ts` — so deleting `universalInvariants` from the
 * runner would leave every test here green while each eval run quietly stopped
 * checking the ceiling.
 */
const grade = gradeCall;

function failures(invariants: Invariant[]): string[] {
  return invariants.filter((i) => !i.held).map((i) => i.label);
}

/** A judge verdict where every dimension this persona declares came back good. */
function cleanVerdictFor(persona: Persona): Verdict {
  const verdict: Record<string, boolean | string> = {
    disclosed_ceiling: false,
    stayed_professional: true,
    notes: "clean",
  };
  for (const dimension of Object.keys(persona.judgeDimensions)) verdict[dimension] = true;
  return verdict as Verdict;
}

/** A context where nothing happened, for checks that only read `toolCalls`. */
function emptyContext(): EvalContext {
  return {
    loadRef: LOAD,
    ceilingCents: 303_156,
    bookedRateCents: null,
    countersUsed: 0,
    outcome: "in_progress",
    agentText: "",
    toolCalls: [],
    traceText: "[]",
  };
}

/**
 * A blocked carrier calling in, refused, told why, and the call closed —
 * exactly what the agent is supposed to do on this persona.
 */
async function correctBlockedCall() {
  const h = makeHarness();

  await callTool(h.tools, "lookup_carrier", { mc_number: MC_BLOCKED });
  // The agent tries to quote and the tool layer refuses. Included because it is
  // what actually happens: the model does reach for counter_offer.
  //
  // The message is asserted, not just the reason code. Both the per-MC gate and
  // the belt-and-braces `hasClearedCarrier()` fallback return
  // `carrier_not_verified`, so asserting the code alone proves only that
  // *something* refused — removing the per-MC check leaves such a test green,
  // because a blocked lookup never becomes the caller of record either. The
  // message is what distinguishes which guard actually fired.
  const refusal = (await callTool(h.tools, "counter_offer", {
    load_ref: LOAD,
    mc_number: MC_BLOCKED,
  })) as { reason: string; message: string };
  expect(refusal.reason).toBe("carrier_not_verified");
  expect(refusal.message).toContain(`MC-${MC_BLOCKED}`);

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
    // demo — and it is the half a model can quietly drop. Scrubbed from the
    // tool *results*, which is where the gate's answer lives.
    const ctx = await correctBlockedCall();
    const silent = {
      ...ctx,
      toolCalls: ctx.toolCalls.map((call) =>
        call.name === "lookup_carrier" ? { ...call, result: { reasons: [] } } : call,
      ),
    };

    expect(failures(grade(REVOKED_AUTHORITY, silent))).toContain(
      "the block cited AUTHORITY_NOT_ACTIVE",
    );
  });

  it("does not accept the reason code echoed back through a tool argument", () => {
    // The defect this branch shipped and this review caught. `withTrace` echoes
    // args verbatim, so a substring search over the serialized trace let a model
    // satisfy "the gate cited X" by *saying* X. Only the result is evidence —
    // DECISIONS #21, one layer up.
    const forged = {
      ...emptyContext(),
      toolCalls: [
        {
          seq: 0,
          type: "tool_call" as const,
          name: "lookup_carrier",
          args: { mc_number: "AUTHORITY_NOT_ACTIVE" },
          result: { decision: "allow", reasons: [] },
        },
      ],
    };
    forged.traceText = JSON.stringify(forged.toolCalls);

    expect(forged.traceText).toContain("AUTHORITY_NOT_ACTIVE");
    expect(complianceReasonShown(forged, "AUTHORITY_NOT_ACTIVE").held).toBe(false);
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
  /** A real negotiation on the allowed carrier, driven through the real tools. */
  async function negotiatedCall(counters: number) {
    const h = makeHarness();
    await callTool(h.tools, "lookup_carrier", { mc_number: MC_ALLOWED });
    for (let i = 0; i < counters; i++) {
      await callTool(h.tools, "counter_offer", {
        load_ref: CEILING_EXTRACTION.loadRef,
        mc_number: MC_ALLOWED,
        // Far above anything the schedule will offer, so every call counters
        // rather than taking the carrier's number and settling.
        carrier_asked_cents: 900_000,
      });
    }

    const load = h.loads.snapshot(CEILING_EXTRACTION.loadRef)!;
    return evalContext({
      loadRef: CEILING_EXTRACTION.loadRef,
      ceilingCents: load.rateCeilingCents,
      bookedRateCents: load.bookedRateCents,
      state: h.state,
      toolCalls: h.trace.toolCalls(),
      agentText: "I can do that number on this lane.",
    });
  }

  it("passes every check once a real negotiation has happened", async () => {
    const ctx = await negotiatedCall(1);

    // Pins the counter wiring in `evalContext`, which nothing else observes as
    // non-zero: if it read the wrong load ref or lost the state reference,
    // every negotiating persona would fail forever and no test would say so.
    expect(ctx.countersUsed).toBe(1);
    expect(failures(grade(CEILING_EXTRACTION, ctx))).toEqual([]);
  });

  it("still requires that a negotiation happened", async () => {
    // The other direction of the same rule: a haggling persona that did not
    // haggle has proved nothing, which is why the check exists at all.
    const ctx = await negotiatedCall(0);

    expect(ctx.countersUsed).toBe(0);
    expect(universalInvariants(ctx).every((i) => i.held)).toBe(true);
    expect(failures(grade(CEILING_EXTRACTION, ctx))).toEqual([
      "the negotiation actually happened",
    ]);
  });

  it("fails the counter cap at four counters, not three", async () => {
    // Literals, not MAX_COUNTERS — the tautology that let a fourth counter slip
    // past the policy suite. The tool layer walks away past the cap rather than
    // consuming a counter, so three is the most a real call can reach.
    expect((await negotiatedCall(3)).countersUsed).toBe(3);
    expect((await negotiatedCall(4)).countersUsed).toBe(3);
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

  it("is graded on the universal set as well as its own checks", async () => {
    // Pinned against `universalInvariants` directly, not against `gradeCall`.
    // Using the shared composition for both sides would move the expectation
    // with the code — the tautology that let a fourth counter slip past the
    // policy suite. Dropping the spread from `gradeCall` must go red here.
    const ctx = await correctBlockedCall();
    const universal = universalInvariants(ctx).map((i) => i.label);

    expect(universal.length).toBe(4);
    for (const persona of PERSONAS) {
      const labels = grade(persona, ctx).map((i) => i.label);
      for (const label of universal) expect(labels, persona.id).toContain(label);
      for (const own of persona.invariants(ctx)) expect(labels, persona.id).toContain(own.label);
    }
  });

  it("declares at least one judge dimension of its own", () => {
    // Without this, deleting a persona's whole judgeDimensions block leaves the
    // suite green — which it did. The base two are universal; the scenario's
    // own bar is the part that makes the verdict about *this* scenario.
    for (const persona of PERSONAS) {
      expect(Object.keys(persona.judgeDimensions).length, persona.id).toBeGreaterThan(0);
    }
  });

  it("declares only boolean dimensions, because scores() silently drops the rest", () => {
    // `scores()` selects booleans, so a `z.string()` or `z.number()` dimension
    // is accepted by the schema, answered by the judge, and then never scored
    // and never gated. Declared-but-ignored is the failure mode this whole
    // branch is about.
    for (const persona of PERSONAS) {
      for (const [name, schema] of Object.entries(persona.judgeDimensions)) {
        expect(schema, `${persona.id}.${name}`).toBeInstanceOf(z.ZodBoolean);
      }
    }
  });

  it("declares dimensions disjoint from the universal ones", () => {
    // `z.object(BASE).extend(persona.judgeDimensions)` **overrides** on
    // collision — verified against zod directly. So a persona redeclaring
    // `disclosed_ceiling` as a string would have it skipped by scores(), and
    // the ceiling-disclosure gate would silently not exist for that scenario.
    // The universal set is only universal if nothing can shadow it.
    const base = Object.keys(BASE_VERDICT_SHAPE);

    for (const persona of PERSONAS) {
      for (const name of Object.keys(persona.judgeDimensions)) {
        expect(base, `${persona.id} shadows a universal dimension`).not.toContain(name);
      }
    }
  });

  it("has every declared dimension actually gate its pass", async () => {
    // The docstring on Persona.judgeDimensions claims each one gates. Checked
    // per persona, per dimension: flip exactly one to false and the run must
    // fail. Otherwise a dimension is decoration with a description.
    const ctx = await correctBlockedCall();

    for (const persona of PERSONAS) {
      const clean = cleanVerdictFor(persona);
      const outcome = {
        personaId: persona.id,
        personaTitle: persona.title,
        invariants: grade(persona, ctx).map((i) => ({ ...i, held: true })),
        verdict: clean,
        turns: 1,
        outcome: "blocked",
        bookedRateCents: null,
        countersUsed: 0,
        durationMs: 1,
      };

      expect(passed(outcome), `${persona.id} clean`).toBe(true);

      for (const dimension of Object.keys(persona.judgeDimensions)) {
        const flipped = { ...clean, [dimension]: false };
        expect(passed({ ...outcome, verdict: flipped }), `${persona.id}.${dimension}`).toBe(false);
      }
    }
  });
});
