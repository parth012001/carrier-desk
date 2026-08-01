import { describe, expect, it } from "vitest";

import { runCall } from "@/lib/agent/run";
import { MAX_COUNTERS } from "@/lib/negotiation/policy";
import { everythingSentTo, scriptedModel } from "@/test/fake-model";

import { MC_ALLOWED, MC_BLOCKED, callTool, makeHarness } from "./harness";

/**
 * The invariant: **`booked_rate_cents <= rate_ceiling_cents`, always.**
 *
 * Enumerated rather than sampled, over the real 40-lane board, because a wrong
 * `ok` here overpays on freight that has already moved. This is the same
 * standard evaluateCompliance is held to and for the same reason.
 *
 * The second half of the file asserts the other half of the claim — that the
 * ceiling never reaches the model at all — at the payload level: what was
 * actually serialized and sent, not what we intended to send.
 */

const REFS = Array.from({ length: 40 }, (_, i) => `LD-${10400 + i}`);

/** Values a language model can emit that are not money. */
const HOSTILE_RATES: [label: string, value: unknown][] = [
  ["numeric string", "999999"],
  ["overflowing literal", 1e999],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["past MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER + 1],
  ["negative zero", -0],
  ["fractional cents", 2908.5],
  ["null", null],
  ["undefined", undefined],
  ["boxed number", { valueOf: () => 1 }],
  ["array", [1]],
];

type ComplianceAxis = "allow" | "flag" | "block" | "unverified";

async function harnessWith(compliance: ComplianceAxis, ref: string, covered: boolean) {
  const h = makeHarness();

  if (compliance === "allow") {
    await callTool(h.tools, "lookup_carrier", { mc_number: MC_ALLOWED });
  } else if (compliance === "flag") {
    // A DOT that disagrees with the registry lifts an allow to a flag.
    await callTool(h.tools, "lookup_carrier", {
      mc_number: MC_ALLOWED,
      claimed_dot: "9999999",
    });
  } else if (compliance === "block") {
    await callTool(h.tools, "lookup_carrier", { mc_number: MC_BLOCKED });
  }

  if (covered) {
    const load = h.loads.snapshot(ref)!;
    await h.deps.loads.cover({
      loadId: load.id,
      carrierId: "someone-else",
      bookedRateCents: load.rateFloorCents,
    });
  }

  return h;
}

const MC_FOR: Record<ComplianceAxis, string> = {
  allow: MC_ALLOWED,
  flag: MC_ALLOWED,
  block: MC_BLOCKED,
  unverified: MC_ALLOWED,
};

describe("book_load — the ceiling invariant, enumerated", () => {
  it("never books above the ceiling: 40 loads x 7 rates x 5 counter counts x 4 gates x 2 statuses", async () => {
    let attempts = 0;
    let booked = 0;

    for (const ref of REFS) {
      for (const compliance of ["allow", "flag", "block", "unverified"] as ComplianceAxis[]) {
        for (const covered of [false, true]) {
          const probe = makeHarness();
          const load = probe.loads.snapshot(ref)!;

          const rates = [
            load.rateCeilingCents - 1,
            load.rateCeilingCents,
            load.rateCeilingCents + 1,
            load.rateFloorCents,
            load.rateMarketCents,
            load.rateCeilingCents * 2,
            1,
          ];

          for (const rate_cents of rates) {
            for (let counters = 0; counters <= MAX_COUNTERS + 1; counters++) {
              const h = await harnessWith(compliance, ref, covered);

              // The last offer is set deliberately high so that only the
              // ceiling check can reject on rate. Otherwise `above_last_offer`
              // would mask the guard this test exists to prove, and deleting
              // the ceiling check would leave the suite green.
              for (let i = 0; i < counters; i++) {
                h.state.recordOffer(ref, load.rateCeilingCents * 4);
              }

              const result = (await callTool(h.tools, "book_load", {
                load_ref: ref,
                mc_number: MC_FOR[compliance],
                rate_cents,
              })) as { booked: boolean; rate_cents?: number };
              attempts++;

              if (result.booked) {
                booked++;
                expect(
                  result.rate_cents,
                  `${ref}: booked ${result.rate_cents} over ceiling ${load.rateCeilingCents}`,
                ).toBeLessThanOrEqual(load.rateCeilingCents);

                const persisted = h.loads.snapshot(ref)!;
                expect(persisted.bookedRateCents).toBeLessThanOrEqual(load.rateCeilingCents);
              }
            }
          }
        }
      }
    }

    // 40 x 4 x 2 x 7 x 5. Pinned so a refactor cannot quietly narrow the sweep
    // and leave the assertion looking healthy.
    expect(attempts).toBe(40 * 4 * 2 * 7 * (MAX_COUNTERS + 2));
    // And some of them must actually have succeeded — an invariant that holds
    // because nothing ever books is not the invariant we are claiming.
    expect(booked).toBeGreaterThan(0);
  }, 60_000);

  it("rejects one cent over the ceiling on every single load", async () => {
    for (const ref of REFS) {
      const h = await harnessWith("allow", ref, false);
      const load = h.loads.snapshot(ref)!;
      h.state.recordOffer(ref, load.rateCeilingCents * 4);

      const result = (await callTool(h.tools, "book_load", {
        load_ref: ref,
        mc_number: MC_ALLOWED,
        rate_cents: load.rateCeilingCents + 1,
      })) as { booked: boolean; reason: string };

      expect(result, ref).toMatchObject({ booked: false, reason: "above_ceiling" });
    }
  });

  it.each(HOSTILE_RATES)("refuses a %s rate from the model", async (_label, value) => {
    // These bypass the zod schema by calling execute directly. "The schema
    // catches it" is a claim about the SDK, not about our code.
    const h = await harnessWith("allow", REFS[0], false);
    h.state.recordOffer(REFS[0], h.loads.snapshot(REFS[0])!.rateCeilingCents * 4);

    const result = (await callTool(h.tools, "book_load", {
      load_ref: REFS[0],
      mc_number: MC_ALLOWED,
      rate_cents: value,
    })) as { booked: boolean };

    expect(result.booked).toBe(false);
    expect(h.loads.snapshot(REFS[0])?.status).toBe("available");
  });

  it("leaks no number when it refuses", async () => {
    // "You're $47 over" is an oracle a model can binary-search.
    const h = await harnessWith("allow", REFS[0], false);
    const load = h.loads.snapshot(REFS[0])!;

    const result = await callTool(h.tools, "book_load", {
      load_ref: REFS[0],
      mc_number: MC_ALLOWED,
      rate_cents: load.rateCeilingCents + 1,
    });

    expect(JSON.stringify(result)).toBe('{"booked":false,"reason":"above_ceiling"}');
  });
});

describe("the model never receives the ceiling", () => {
  it("is absent from every payload of a full booking conversation, on all 40 loads", async () => {
    for (const ref of REFS) {
      const h = makeHarness();
      const load = h.loads.snapshot(ref)!;

      // A complete call: verify, present, grind through every counter, book,
      // hang up. If the ceiling is reachable anywhere, it is reachable here.
      //
      // Every number the script uses is one the model could actually have
      // learned — an ask derived from the market rate get_load returned, and a
      // booking at that market rate. An earlier version had the script book at
      // the ceiling, which "failed" instantly: a fabricated model reciting a
      // number it was never told proves nothing about whether we leaked it.
      const ask = load.rateMarketCents * 2;
      const counter = {
        call: [{ tool: "counter_offer", input: { load_ref: ref, carrier_asked_cents: ask } }],
      };
      const model = scriptedModel([
        { call: [{ tool: "lookup_carrier", input: { mc_number: MC_ALLOWED } }] },
        { call: [{ tool: "get_load", input: { load_ref: ref } }] },
        counter,
        counter,
        counter,
        counter,
        {
          call: [
            {
              tool: "book_load",
              input: { load_ref: ref, mc_number: MC_ALLOWED, rate_cents: load.rateMarketCents },
            },
          ],
        },
        { call: [{ tool: "end_call", input: { outcome: "booked", summary: "done" } }] },
      ]);

      await runCall({
        model,
        tools: h.tools,
        messages: [{ role: "user", content: `MC ${MC_ALLOWED}, calling on ${ref}` }],
        trace: h.trace,
        maxSteps: 10,
      });

      // Everything the provider was sent: every prompt AND every tool schema.
      const sent = everythingSentTo(model);

      expect(sent, `${ref} leaked its ceiling value`).not.toContain(String(load.rateCeilingCents));
      expect(sent, `${ref} leaked the word ceiling`).not.toMatch(/ceiling/i);
    }
  }, 60_000);

  it("is absent from the serialized tool schemas", async () => {
    // Tool descriptions render into the request ahead of the system prompt, so
    // a `.describe()` string is as much a leak as a return value.
    const h = makeHarness();
    const model = scriptedModel([{ say: "hello" }]);

    await runCall({
      model,
      tools: h.tools,
      messages: [{ role: "user", content: "hi" }],
      trace: h.trace,
    });

    const tools = JSON.stringify(model.doGenerateCalls[0]?.tools ?? []);
    expect(tools).not.toMatch(/ceiling/i);
    expect(tools).not.toMatch(/walk.?away max/i);
    expect(tools).not.toMatch(/rate_floor/i);
  });

  it("keeps the ceiling out of a rejected booking's trace row", async () => {
    // The trace is rendered in the UI and persisted. A reason code that
    // embedded the number would leak it to anyone reading the run.
    const h = await harnessWith("allow", REFS[0], false);
    const load = h.loads.snapshot(REFS[0])!;

    await callTool(h.tools, "book_load", {
      load_ref: REFS[0],
      mc_number: MC_ALLOWED,
      rate_cents: load.rateCeilingCents + 1,
    });

    const row = JSON.stringify(h.trace.toolCalls()[0].result);
    expect(row).not.toContain(String(load.rateCeilingCents));
  });
});
