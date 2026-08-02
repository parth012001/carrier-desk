import { describe, expect, it } from "vitest";

import { CallState } from "./state";

describe("CallState — the counter count", () => {
  it("counts per load, so a second load starts fresh", () => {
    const state = new CallState("run-1");

    state.recordOffer("LD-10400", 245_100);
    state.recordOffer("LD-10400", 270_000);
    state.recordOffer("LD-10401", 300_000);

    expect(state.countersUsed("LD-10400")).toBe(2);
    expect(state.countersUsed("LD-10401")).toBe(1);
    expect(state.nextRound("LD-10400")).toBe(3);
  });

  it("only moves forward", () => {
    // recordOffer is the only mutator, and it increments. There is no reset, no
    // setter, and no decrement anywhere on the public surface.
    //
    // The stronger claim — that a *carrier* cannot talk their way to a fourth
    // counter — is a property of the tool schemas, not of this class, and is
    // asserted where those live. TypeScript's `private` is compile-time only,
    // so nothing here would prove it.
    const state = new CallState("run-1");
    const seen: number[] = [];

    for (let i = 0; i < 5; i++) {
      state.recordOffer("LD-10400", 250_000 + i);
      seen.push(state.countersUsed("LD-10400"));
    }

    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });

  it("remembers the last number we actually said", () => {
    const state = new CallState("run-1");
    state.recordOffer("LD-10400", 245_100);
    state.recordOffer("LD-10400", 270_000);

    expect(state.lastOffer("LD-10400")).toBe(270_000);
    expect(state.lastOffer("LD-99999")).toBeNull();
  });

  it("reports no compliance rather than clean compliance for a carrier never looked up", () => {
    // The difference between "checked and fine" and "never checked" is the
    // failure DECISIONS #10 and #13 both exist to prevent. null, not allow.
    const state = new CallState("run-1");

    expect(state.complianceFor("186800")).toBeNull();
  });

  it("carries the compliance result booking will re-read", () => {
    const state = new CallState("run-1");
    state.rememberCompliance("1175378", { decision: "block", reasons: [] });

    expect(state.complianceFor("1175378")?.decision).toBe("block");
  });

  it("starts in_progress and lands on booked", () => {
    const state = new CallState("run-1");
    expect(state.outcome).toBe("in_progress");

    state.markBooked("LD-10400", "load-0000", 270_000);

    expect(state.outcome).toBe("booked");
    expect(state.finalRateCents).toBe(270_000);
    expect(state.bookedLoadId).toBe("load-0000");
    expect(state.isBooked("LD-10400")).toBe(true);
    expect(state.isBooked("LD-10401")).toBe(false);
  });
});
