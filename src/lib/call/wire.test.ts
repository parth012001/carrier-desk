import { describe, expect, it } from "vitest";

import type { Load } from "@/db/schema";
import { InMemoryTraceSink, type TraceEvent } from "@/lib/agent/trace";
import { buildTools } from "@/lib/tools";
import { MC_ALLOWED, callTool, makeHarness } from "@/lib/tools/harness";

import { encodeCallEvent, toCallEvent } from "./events";

/**
 * The ceiling, at the boundary Day 4 added.
 *
 * `docs/DECISIONS.md` #19's lesson was not that a tool leaked the ceiling —
 * `sanitize.ts` withheld it faithfully the whole time. It was that the claim
 * has to be checked wherever bytes leave, against what can be *computed* from
 * them, by a test that would go red if the answer changed. The interface added
 * a second place bytes leave, so it gets the same test.
 *
 * Real tools, real fixtures, every seeded load: whatever `run_events.result`
 * holds is what the browser receives, because the trace pane renders args and
 * results verbatim.
 *
 * **Scoped per load, deliberately.** Checking every load's ceiling against one
 * combined transcript fails on coincidence — with 40 lanes, one load's market
 * rate eventually equals another's ceiling, and that is not a disclosure of
 * anything. The claim worth making is per load: nothing we said *about this
 * load* lets you recover *this load's* walk-away.
 *
 * Scope stated rather than implied: this covers tool arguments and results,
 * which on this wire are integer cents in JSON. The agent's prose also crosses
 * here as `assistant_message`, and prose is where "$3,031.56" contains no
 * substring "303156" — that check lives in the eval, digit-for-digit against
 * each numeric token, which is where #19 fixed it. There is no live model in
 * `pnpm test`, so this file cannot and does not claim to cover it.
 */

const REFS = Array.from({ length: 40 }, (_, i) => `LD-${10400 + i}`);

/** Every rendering of a number that would count as having disclosed it. */
function disclosureForms(cents: number): string[] {
  const dollars = cents / 100;
  const usd = dollars.toLocaleString("en-US", { style: "currency", currency: "USD" });
  return [String(cents), dollars.toFixed(2), usd, usd.replace("$", "")];
}

const wireOf = (events: readonly TraceEvent[]): string =>
  events.map((event) => encodeCallEvent(toCallEvent(event))).join("");

type LoadTranscript = { load: Load; wire: string; events: TraceEvent[] };

async function driveEachLoad(): Promise<{ perLoad: LoadTranscript[]; everything: TraceEvent[] }> {
  const harness = makeHarness();

  const verify = new InMemoryTraceSink();
  const verifyTools = buildTools({
    deps: { ...harness.deps, trace: verify },
    state: harness.state,
  });
  await callTool(verifyTools, "lookup_carrier", { mc_number: MC_ALLOWED });
  await callTool(verifyTools, "check_compliance", { mc_number: MC_ALLOWED });

  const perLoad: LoadTranscript[] = [];
  for (const ref of REFS) {
    const load = harness.loads.snapshot(ref);
    if (load === null) throw new Error(`seed is missing ${ref}`);

    // A sink per load, so each transcript contains that load and nothing else.
    // `state` is shared, which is what keeps the carrier verified across them.
    const sink = new InMemoryTraceSink();
    const tools = buildTools({ deps: { ...harness.deps, trace: sink }, state: harness.state });

    // Derived from market, never from the ceiling. `withTrace` echoes `args`
    // onto the wire verbatim, so passing the ceiling in would put it there by
    // our own hand and prove nothing — the model cannot send a number it does
    // not have. Market times three clears any ceiling (which is market × 1.14)
    // while sharing none of its digits, so anything ceiling-shaped that turns
    // up is genuinely the system's doing.
    const wellOver = load.rateMarketCents * 3;

    await callTool(tools, "get_load", { load_ref: ref });
    await callTool(tools, "counter_offer", {
      load_ref: ref,
      mc_number: MC_ALLOWED,
      carrier_asked_cents: wellOver,
    });
    await callTool(tools, "book_load", {
      load_ref: ref,
      mc_number: MC_ALLOWED,
      rate_cents: wellOver,
    });

    perLoad.push({ load, wire: wireOf(sink.events), events: sink.events });
  }

  return {
    perLoad,
    everything: [...verify.events, ...perLoad.flatMap((entry) => entry.events)],
  };
}

describe("the wire never carries the ceiling", () => {
  it("never renders a load's ceiling in anything said about that load", async () => {
    const { perLoad } = await driveEachLoad();

    expect(perLoad).toHaveLength(40);
    for (const { load, wire } of perLoad) {
      for (const form of disclosureForms(load.rateCeilingCents)) {
        expect(wire, `${load.ref} disclosed its ceiling as ${form}`).not.toContain(form);
      }
    }
  });

  it("holds no integer equal to the ceiling of the load it is about", async () => {
    // Stronger than substring, and the form #19 had to correct the eval to:
    // compare digit-for-digit against each numeric token rather than hoping a
    // formatted number happens to contain the raw one.
    const { perLoad } = await driveEachLoad();

    for (const { load, wire } of perLoad) {
      const tokens = [...wire.matchAll(/\d+/g)].map((match) => Number(match[0]));
      expect(tokens, `${load.ref} emitted its ceiling as a bare integer`).not.toContain(
        load.rateCeilingCents,
      );
    }
  });

  it("returns no ceiling from any tool, whatever it was asked", async () => {
    // The sharper form of the same claim. `args` are the caller's own words
    // echoed back and cannot tell the model anything it did not already have;
    // `result` is what the system chooses to reveal. This checks results only,
    // so it holds even if a caller passes the number in.
    const { perLoad } = await driveEachLoad();

    for (const { load, events } of perLoad) {
      const results = wireOf(events.map((event) => ({ ...event, args: null })));
      for (const form of disclosureForms(load.rateCeilingCents)) {
        expect(results, `${load.ref} returned its ceiling as ${form}`).not.toContain(form);
      }
    }
  });

  it("never says the word, in a key, a reason code or a message", async () => {
    // Tool schemas and descriptions serialize ahead of the prompt, and a reason
    // code gets read by a person. Naming it is a disclosure of a kind.
    const { everything } = await driveEachLoad();
    const wire = wireOf(everything);

    expect(wire).not.toMatch(/ceiling/i);
    expect(wire).not.toMatch(/walk[_\s-]?away/i);
  });

  it("does carry the floor, because round one is the anchor we say out loud", async () => {
    // The complement, so this file cannot pass by emitting nothing. The opening
    // offer is the floor exactly; if that stopped appearing, every assertion
    // above would be green for the wrong reason.
    const { perLoad } = await driveEachLoad();

    for (const { load, wire } of perLoad) {
      expect(wire, `${load.ref} never quoted its opening anchor`).toContain(
        String(load.rateFloorCents),
      );
    }
  });

  it("rejects a booking with a reason code and no arithmetic at all", async () => {
    // "You are $47 over" is an oracle a model can binary-search, and a number a
    // person reads off this pane is the same disclosure by another route. The
    // reason code is the whole answer: two keys, and not one number.
    const { perLoad } = await driveEachLoad();

    const rejections = perLoad
      .flatMap((entry) => entry.events)
      .filter((event) => event.name === "book_load")
      .map((event) => event.result as Record<string, unknown>)
      .filter((result) => result.booked === false);

    expect(rejections).toHaveLength(40);
    for (const rejection of rejections) {
      expect(Object.keys(rejection).sort()).toEqual(["booked", "reason"]);
      expect(Object.values(rejection).some((value) => typeof value === "number")).toBe(false);
    }
  });
});
