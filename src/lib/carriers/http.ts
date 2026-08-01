/**
 * Outbound request budget for the FMCSA sources.
 *
 * Node's undici defaults to roughly 300 seconds when no signal is supplied, so
 * a hung government API stalls a live carrier call for five minutes with a
 * driver on the phone. That is the failure this module exists to prevent.
 *
 * 6s is the budget. Day 2 live verification put a working Socrata query well
 * under 2s, so the budget is generous against the happy path while staying
 * inside what a human on a call will tolerate before the agent recovers.
 *
 * QCMobile makes two sequential calls and shares ONE deadline across both, so
 * its worst case is also 6s rather than 12s. A per-call budget would have made
 * the richer source the slower one to fail, which is backwards.
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 6_000;

/**
 * True when a fetch rejection was our own deadline firing rather than the
 * network refusing us.
 *
 * `AbortSignal.timeout()` rejects with a `TimeoutError`; an explicitly aborted
 * signal rejects with an `AbortError`. Both mean "we stopped waiting", which is
 * a different fact from "the request failed" and deserves a different message —
 * that message reaches a `ComplianceReason`, which the agent reads aloud and
 * which is persisted to `run_events`.
 */
export function isAbortError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "name" in cause &&
    (cause.name === "TimeoutError" || cause.name === "AbortError")
  );
}
