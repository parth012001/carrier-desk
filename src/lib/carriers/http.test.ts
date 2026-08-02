import { describe, expect, it } from "vitest";

import { DEFAULT_FETCH_TIMEOUT_MS, isAbortError } from "./http";
import { QCMobileCarrierSource } from "./qcmobile";
import { SocrataCarrierSource } from "./socrata";

/**
 * Every outbound call now carries a deadline. Without one, undici waits ~300s,
 * which on the path this code actually runs means a driver holding a phone for
 * five minutes while a government API decides nothing.
 *
 * These tests use a tiny budget so they finish instantly, but they exercise the
 * real `AbortSignal.timeout` wiring rather than faking the rejection.
 */

const TINY_BUDGET_MS = 25;

/** A fetch that never answers, and rejects only when the caller's signal fires. */
function hangingFetch(observe?: (signal: AbortSignal | null | undefined) => void): typeof fetch {
  return ((_input: RequestInfo | URL, init?: RequestInit) => {
    observe?.(init?.signal);
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      // No signal means the deadline was never wired up. Reject loudly rather
      // than hanging the suite, so the failure names the actual bug.
      if (!signal) return reject(new Error("fetch was called with no AbortSignal"));
      signal.addEventListener("abort", () => reject(signal.reason));
    });
  }) as typeof fetch;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

describe("isAbortError", () => {
  it("recognises both shapes of giving up", () => {
    expect(isAbortError(new DOMException("timed out", "TimeoutError"))).toBe(true);
    expect(isAbortError(new DOMException("aborted", "AbortError"))).toBe(true);
  });

  it("does not swallow a genuine network fault", () => {
    // A connection refused is a different fact from a deadline, and reporting
    // one as the other sends whoever debugs it at the wrong system.
    expect(isAbortError(new TypeError("fetch failed"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError("TimeoutError")).toBe(false);
  });
});

describe("SocrataCarrierSource — request budget", () => {
  it("gives up on a hung request and says so with the budget", async () => {
    const source = new SocrataCarrierSource({
      fetchImpl: hangingFetch(),
      timeoutMs: TINY_BUDGET_MS,
    });

    const result = await source.lookupByMc("186800");

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.message).toContain(`${TINY_BUDGET_MS}ms`);
    expect(result.message).toContain("connecting");
  });

  it("passes a real AbortSignal to fetch", async () => {
    let seen: AbortSignal | null | undefined;
    const source = new SocrataCarrierSource({
      fetchImpl: hangingFetch((signal) => {
        seen = signal;
      }),
      timeoutMs: TINY_BUDGET_MS,
    });

    await source.lookupByMc("186800");

    expect(seen).toBeInstanceOf(AbortSignal);
  });

  it("reports a stalled response body as a timeout, not as a bad payload", async () => {
    // Regression guard: `.json().catch(() => null)` used to swallow the abort,
    // so a timeout surfaced as "unrecognised payload" and pointed the blame at
    // our parser instead of at the network.
    const source = new SocrataCarrierSource({
      timeoutMs: TINY_BUDGET_MS,
      fetchImpl: async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new DOMException("The operation was aborted.", "AbortError");
          },
          text: async () => "",
        }) as unknown as Response,
    });

    const result = await source.lookupByMc("186800");

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.message).toContain("did not respond");
    expect(result.message).toContain("reading the response");
    expect(result.message).not.toContain("unrecognised");
  });

  it("still reports a genuine failure as a failure, not a timeout", async () => {
    const source = new SocrataCarrierSource({
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });

    const result = await source.lookupByMc("186800");

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.message).toContain("request failed");
    expect(result.message).not.toContain("did not respond");
  });

  it("times out rather than reporting not_found — an outage is not a fraud finding", async () => {
    const source = new SocrataCarrierSource({
      fetchImpl: hangingFetch(),
      timeoutMs: TINY_BUDGET_MS,
    });

    const result = await source.lookupByMc("9999999");

    // not_found blocks the carrier permanently and reads as "this MC is fake".
    // A slow API must never produce that.
    expect(result.status).toBe("error");
  });
});

describe("QCMobileCarrierSource — one deadline across both legs", () => {
  it("shares a single AbortSignal between the docket and authority calls", async () => {
    // This source makes two sequential requests. A per-call budget would give
    // the richer source double the worst case of the keyless one, which is
    // backwards. Signal identity is the whole proof: one object created once at
    // the start of the lookup means one deadline covering both legs.
    const signals: (AbortSignal | null | undefined)[] = [];
    const source = new QCMobileCarrierSource({
      webKey: "test-key",
      timeoutMs: 5_000,
      fetchImpl: async (_input, init) => {
        signals.push(init?.signal);
        return signals.length === 1
          ? jsonResponse({ content: [{ carrier: { dotNumber: "286764", legalName: "TEST" } }] })
          : jsonResponse({ content: [] });
      },
    });

    await source.lookupByMc("186800");

    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]).toBe(signals[1]);
  });

  it("gives up on a hung docket call with the budget in the message", async () => {
    const source = new QCMobileCarrierSource({
      webKey: "test-key",
      fetchImpl: hangingFetch(),
      timeoutMs: TINY_BUDGET_MS,
    });

    const result = await source.lookupByMc("186800");

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.message).toContain(`${TINY_BUDGET_MS}ms`);
  });

  it("never leaks the WebKey in a timeout message", async () => {
    // Timeout messages reach a ComplianceReason, which the agent reads aloud
    // and which is persisted to run_events.
    const source = new QCMobileCarrierSource({
      webKey: "super-secret-webkey",
      fetchImpl: hangingFetch(),
      timeoutMs: TINY_BUDGET_MS,
    });

    const result = await source.lookupByMc("186800");

    if (result.status !== "error") throw new Error("expected error");
    expect(result.message).not.toContain("super-secret-webkey");
  });
});

describe("the default budget", () => {
  it("is short enough to matter on a live call", () => {
    // Not a tautology: this is the number a human waits through, and the point
    // of pinning it is that raising it should be a deliberate edit with a
    // failing test attached, not a quiet drift back toward undici's ~300s.
    expect(DEFAULT_FETCH_TIMEOUT_MS).toBeLessThanOrEqual(8_000);
    expect(DEFAULT_FETCH_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
  });
});
