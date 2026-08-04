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

describe("CallState — the caller of record", () => {
  /** Enough of a CarrierRecord and a StoredCarrier for the slot logic. */
  function carrier(mcNumber: string) {
    return {
      record: { mcNumber } as unknown as Parameters<CallState["rememberCarrier"]>[1],
      stored: { id: `carrier-${mcNumber}`, mcNumber } as unknown as Parameters<
        CallState["rememberCarrier"]
      >[2],
    };
  }

  function remember(state: CallState, mcNumber: string) {
    const { record, stored } = carrier(mcNumber);
    state.rememberCarrier(mcNumber, record, stored);
  }

  it("is claimed by the first carrier that clears the gate", () => {
    const state = new CallState("run-1");
    state.rememberCompliance("186800", { decision: "allow", reasons: [] });

    remember(state, "186800");

    expect(state.verifiedMcNumber).toBe("186800");
    expect(state.isVerifiedCaller("186800")).toBe(true);
    expect(state.hasClearedCarrier()).toBe(true);
  });

  it("is not taken by a second lookup that the gate blocked", () => {
    // "Check my partner's number too" — a blocked carrier taking the slot would
    // have written the blocked entity's id into `covered_by_carrier_id`.
    const state = new CallState("run-1");
    state.rememberCompliance("186800", { decision: "allow", reasons: [] });
    state.rememberCompliance("1175378", { decision: "block", reasons: [] });

    remember(state, "186800");
    remember(state, "1175378");

    expect(state.verifiedMcNumber).toBe("186800");
    expect(state.isVerifiedCaller("1175378")).toBe(false);
  });

  it("is not taken by a second lookup the gate cleared either", () => {
    // The double-broker attack, and the half the block guard above never
    // covered: the partner MC is real, active and clean, so compliance answers
    // `allow` and cannot help. Last-write-wins handed them the slot, and
    // `book_load` then tendered freight to a carrier who was never on the call.
    const state = new CallState("run-1");
    state.rememberCompliance("186800", { decision: "allow", reasons: [] });
    state.rememberCompliance("170995", { decision: "allow", reasons: [] });

    remember(state, "186800");
    remember(state, "170995");

    expect(state.verifiedMcNumber).toBe("186800");
    expect(state.isVerifiedCaller("170995")).toBe(false);
    expect(state.carrier?.id).toBe("carrier-186800");
  });

  it("refreshes the same carrier when they are looked up twice", () => {
    // Not re-pointing is about a *different* MC. Re-reading the same one is an
    // ordinary thing for the model to do and must keep the stored row current.
    const state = new CallState("run-1");
    state.rememberCompliance("186800", { decision: "allow", reasons: [] });

    remember(state, "186800");
    const refreshed = { id: "carrier-refreshed", mcNumber: "186800" } as unknown as Parameters<
      CallState["rememberCarrier"]
    >[2];
    state.rememberCarrier("186800", carrier("186800").record, refreshed);

    expect(state.carrier?.id).toBe("carrier-refreshed");
    expect(state.verifiedMcNumber).toBe("186800");
  });

  it("lets a clean carrier claim the slot after a blocked one failed to", () => {
    // The mangled-MC shape: the first number the caller gave does not clear, so
    // it never held the slot, and the corrected one is free to take it.
    const state = new CallState("run-1");
    state.rememberCompliance("1868000", { decision: "block", reasons: [] });
    state.rememberCompliance("186800", { decision: "allow", reasons: [] });

    remember(state, "1868000");
    expect(state.hasClearedCarrier()).toBe(false);

    remember(state, "186800");

    expect(state.verifiedMcNumber).toBe("186800");
    expect(state.isVerifiedCaller("186800")).toBe(true);
  });
});
