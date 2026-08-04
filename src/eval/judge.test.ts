import type { LanguageModel } from "ai";
import { describe, expect, it, vi } from "vitest";

import { sayingModel } from "@/test/fake-model";

import { HANGUP_MARKER, carrierLine, carrierTurn } from "./judge";
import { MID_CALL_HANGUP, PERSONAS } from "./personas";

/**
 * Only `personaModel` is mocked, through `importOriginal`, so the rest of the
 * module — model ids, provider options — stays real. Same pattern the route
 * handler tests use.
 */
const mocked = vi.hoisted(() => ({ model: null as LanguageModel | null }));
vi.mock("@/lib/agent/models", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/models")>()),
  personaModel: () => mocked.model,
}));

/**
 * The carrier simulator's one piece of logic that is not a model call.
 *
 * `carrierTurn` needs an API key; `carrierLine` decides whether the call is
 * over, which is the part that must not be discovered by spending one. The
 * runner stops on an empty carrier turn, so this function is the entire
 * definition of "the carrier hung up".
 */

describe("carrierLine", () => {
  it("passes an ordinary line through, trimmed", () => {
    expect(carrierLine("  What's it pay?  ")).toBe("What's it pay?");
  });

  it("turns the marker into the empty turn the runner stops on", () => {
    expect(carrierLine(HANGUP_MARKER)).toBe("");
  });

  it("counts the marker anywhere in the reply, not only alone", () => {
    // Haiku will sometimes wrap it or trail a line before it. Strict equality
    // would leave the one persona whose title is about hanging up never hanging
    // up — and that failure is invisible: the call simply runs to maxTurns and
    // grades fine.
    expect(carrierLine(`Yeah, forget it. ${HANGUP_MARKER}`)).toBe("");
    expect(carrierLine(`*${HANGUP_MARKER}*`)).toBe("");
    expect(carrierLine(`${HANGUP_MARKER}\n`)).toBe("");
  });

  it("drops whatever was said alongside the marker", () => {
    // Deliberate, not incidental: a carrier who is gone did not get a closing
    // line out, and delivering one would hand the agent a turn the scenario says
    // it never got.
    expect(carrierLine(`Hold on— ${HANGUP_MARKER}`)).not.toContain("Hold on");
  });

  it("treats a reply that is only whitespace as a hang-up too", () => {
    expect(carrierLine("   \n  ")).toBe("");
  });

  it("does not fire on a line that merely mentions brackets", () => {
    expect(carrierLine("It's [LD-10405], the Akron one")).toBe("It's [LD-10405], the Akron one");
  });
});

describe("the hang-up marker", () => {
  it("is spelled the same way in the persona's instructions and the parser", () => {
    // The drift this guards: instructions that say one thing and a parser that
    // reads another produce a persona which never hangs up, on a scorecard that
    // says nothing is wrong. Importing the constant is the fix; this is the test
    // that notices if someone retypes it.
    expect(MID_CALL_HANGUP.instructions).toContain(HANGUP_MARKER);
  });

  it("is not handed to any persona that is supposed to keep talking", () => {
    // A stray marker in another persona's script would end its call early and
    // quietly shrink the scenario to whatever happened before it.
    for (const persona of PERSONAS) {
      if (persona.id === MID_CALL_HANGUP.id) continue;
      expect(persona.instructions, persona.id).not.toContain(HANGUP_MARKER);
    }
  });
});

describe("carrierTurn", () => {
  // Found by mutation, and it survived: reverting `carrierTurn` to `text.trim()`
  // left every `carrierLine` test green while the simulator stopped consulting
  // it, so the hang-up marker would have been delivered to the agent as an
  // ordinary line. A tested function nothing calls is the same tautology as a
  // test that reimplements the thing it checks.
  it("routes the model's reply through carrierLine", async () => {
    mocked.model = sayingModel(`Hold on— ${HANGUP_MARKER}`);

    expect(await carrierTurn(MID_CALL_HANGUP, [])).toBe("");
  });

  it("returns an ordinary reply as the carrier's line", async () => {
    mocked.model = sayingModel("  What's LD-10405 paying?  ");

    expect(await carrierTurn(MID_CALL_HANGUP, [])).toBe("What's LD-10405 paying?");
  });
});
