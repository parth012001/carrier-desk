import type { ComplianceDecision, ComplianceReason } from "@/lib/carriers/compliance";

import type { CallEvent } from "./events";

/**
 * Folds the event stream into what the screen shows.
 *
 * **Every pane is a projection of this one value.** The conversation, the
 * trace, the carrier card, the compliance block and the rate ladder are all
 * reads of the same fold, so they cannot disagree with one another and there
 * is no second endpoint for any of them to poll. It is a pure function of the
 * events, which is why it is tested here rather than clicked through.
 *
 * It reads tool results structurally because `run_events.result` is jsonb and
 * arrives as `unknown`. Every read is defensive: a shape it does not recognise
 * leaves the view unchanged rather than throwing, because a rendering bug must
 * never be able to take down the pane that is showing a live call.
 *
 * The ceiling is not derivable from anything here. No tool returns it or any
 * function of it (`docs/DECISIONS.md` #17, #19), so the ladder's ceiling line
 * comes from the server-rendered board instead — a separate, deliberate
 * channel for a separate audience.
 */

export type Turn = { speaker: "carrier" | "agent"; text: string };

export type TraceRow = {
  /**
   * Position in the whole call, counted here.
   *
   * Not `CallEvent.index`, which is local to one connection and restarts at
   * zero every turn — as a label it would count 1, 2, then 1 again, and as a
   * React key it would collide outright. The durable equivalent is
   * `run_events.seq`; this is the client-side counterpart of the same fix.
   */
  ordinal: number;
  name: string;
  args: unknown;
  result: unknown;
  durationMs: number | null;
};

export type CarrierView = {
  mcNumber: string;
  dotNumber: string | null;
  legalName: string;
  dbaName: string | null;
  phone: string | null;
  authorityStatus: string;
  safetyRating: string | null;
  powerUnits: number | null;
  previousCalls: number;
};

export type Offer = {
  round: number;
  rateCents: number;
  /** What the carrier asked for on the turn that produced this offer, if they named one. */
  askedCents: number | null;
  accepted: boolean;
};

/** A tool saying no. The gate refusing is a thing the broker should see. */
export type Refusal = { tool: string; reason: string };

export type CallView = {
  turns: Turn[];
  trace: TraceRow[];
  carrier: CarrierView | null;
  compliance: { decision: ComplianceDecision; reasons: ComplianceReason[] } | null;
  loadRef: string | null;
  offers: Offer[];
  booking: { loadRef: string; rateCents: number } | null;
  refusals: Refusal[];
  outcome: string | null;
  ended: boolean;
  error: string | null;
};

export const EMPTY_CALL_VIEW: CallView = {
  turns: [],
  trace: [],
  carrier: null,
  compliance: null,
  loadRef: null,
  offers: [],
  booking: null,
  refusals: [],
  outcome: null,
  ended: false,
  error: null,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * A message's content is a string on the way in and can be an array of parts
 * on the way back out of the SDK. Both have to render.
 */
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .join("")
      .trim();
  }
  return "";
}

function readCompliance(result: Record<string, unknown>): CallView["compliance"] {
  const decision = str(result.decision);
  if (decision !== "allow" && decision !== "flag" && decision !== "block") return null;
  const reasons = Array.isArray(result.reasons)
    ? (result.reasons.filter(
        (r) => isRecord(r) && typeof r.code === "string" && typeof r.message === "string",
      ) as ComplianceReason[])
    : [];
  return { decision: decision as ComplianceDecision, reasons };
}

function readCarrier(result: Record<string, unknown>): CarrierView | null {
  const carrier = result.carrier;
  if (!isRecord(carrier)) return null;
  const mcNumber = str(carrier.mc_number);
  const legalName = str(carrier.legal_name);
  if (mcNumber === null || legalName === null) return null;
  return {
    mcNumber,
    legalName,
    dotNumber: str(carrier.dot_number),
    dbaName: str(carrier.dba_name),
    phone: str(carrier.phone),
    authorityStatus: str(carrier.authority_status) ?? "unknown",
    safetyRating: str(carrier.safety_rating),
    powerUnits: num(carrier.power_units),
    previousCalls: num(result.previous_calls) ?? 0,
  };
}

function applyToolCall(view: CallView, row: TraceRow): CallView {
  const { name, args, result } = row;
  if (!isRecord(result)) return view;
  const argRecord = isRecord(args) ? args : {};

  switch (name) {
    case "lookup_carrier": {
      // The most recent lookup is what the card shows. `CallState` is stricter
      // — a blocked second lookup never becomes the caller of record — but the
      // screen is answering "who did we just check and what came back", and on
      // the block demo the blocked carrier is precisely the one to show.
      return {
        ...view,
        carrier: readCarrier(result) ?? view.carrier,
        compliance: readCompliance(result) ?? view.compliance,
      };
    }

    case "check_compliance": {
      return { ...view, compliance: readCompliance(result) ?? view.compliance };
    }

    case "get_load": {
      const load = isRecord(result.load) ? result.load : null;
      const ref = str(load?.load_ref) ?? str(argRecord.load_ref);
      return result.found === true && ref !== null ? { ...view, loadRef: ref } : view;
    }

    case "counter_offer": {
      const action = str(result.action);
      const rateCents = num(result.rate_cents);
      if ((action === "offer" || action === "accept") && rateCents !== null) {
        return {
          ...view,
          loadRef: str(argRecord.load_ref) ?? view.loadRef,
          offers: [
            ...view.offers,
            {
              round: view.offers.length + 1,
              rateCents,
              askedCents: num(argRecord.carrier_asked_cents),
              accepted: action === "accept",
            },
          ],
        };
      }
      const reason = str(result.reason);
      return reason === null
        ? view
        : { ...view, refusals: [...view.refusals, { tool: "counter_offer", reason }] };
    }

    case "book_load": {
      const rateCents = num(result.rate_cents);
      const ref = str(result.load_ref) ?? str(argRecord.load_ref);
      if (result.booked === true && rateCents !== null && ref !== null) {
        return { ...view, booking: { loadRef: ref, rateCents }, loadRef: ref };
      }
      const reason = str(result.reason);
      return reason === null
        ? view
        : { ...view, refusals: [...view.refusals, { tool: "book_load", reason }] };
    }

    case "end_call": {
      return { ...view, outcome: str(result.outcome) ?? view.outcome, ended: true };
    }

    case "escalate_to_human": {
      return { ...view, outcome: "escalated", ended: true };
    }

    default:
      return view;
  }
}

export function reduceCall(view: CallView, event: CallEvent): CallView {
  if (event.kind === "error") return { ...view, error: event.message };
  if (event.kind === "turn_end") return view;

  if (event.type === "user_message") {
    const text = textOf(event.result);
    return text === "" ? view : { ...view, turns: [...view.turns, { speaker: "carrier", text }] };
  }

  if (event.type === "assistant_message") {
    const text = textOf(event.result);
    return text === "" ? view : { ...view, turns: [...view.turns, { speaker: "agent", text }] };
  }

  if (event.name === null) return view;
  const row: TraceRow = {
    ordinal: view.trace.length + 1,
    name: event.name,
    args: event.args,
    result: event.result,
    durationMs: event.durationMs,
  };
  return applyToolCall({ ...view, trace: [...view.trace, row] }, row);
}

export function projectCall(events: readonly CallEvent[]): CallView {
  return events.reduce(reduceCall, EMPTY_CALL_VIEW);
}
