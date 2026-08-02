import { type ToolSet, tool } from "ai";
import { z } from "zod";

import type { CallState } from "@/lib/agent/state";
import { withTrace } from "@/lib/agent/trace";
import type { AgentDeps } from "@/lib/agent/types";
import { readThrough } from "@/lib/carriers/cache";
import { evaluateLookup } from "@/lib/carriers/compliance";
import { parseMcNumber } from "@/lib/carriers/normalize";
import { MAX_COUNTERS, canBook, nextOffer } from "@/lib/negotiation/policy";

import { toAgentLoad } from "./sanitize";

/**
 * The tool layer. This is where policy is enforced — not in the prompt.
 *
 * Two rules hold across every tool here, and both are asserted at the payload
 * level rather than trusted:
 *
 * 1. **Nothing returns `rate_ceiling_cents`, or anything derived from it.** Not
 *    the value, not the distance to it, not "you're close". A rejection carries
 *    a reason code and no arithmetic, because "you are $47 over" is an oracle a
 *    model can binary-search.
 * 2. **No tool description or schema mentions it either.** Tool schemas are
 *    serialized into the request ahead of the system prompt, so a `.describe()`
 *    string is just as much a leak as a return value.
 */

/** Everything a tool call needs. `state` is per-run; `deps` is per-process. */
export type ToolContext = { deps: AgentDeps; state: CallState };

export function buildTools({ deps, state }: ToolContext): ToolSet {
  const traced = <A, R>(name: string, fn: (args: A) => Promise<R>) =>
    withTrace(name, deps.trace, fn);

  return {
    lookup_carrier: tool({
      description:
        "Verify a carrier against FMCSA registration data. Call this before discussing a " +
        "load in any detail. Returns the carrier's legal identity and whether they are " +
        "cleared to haul.",
      inputSchema: z.object({
        mc_number: z
          .string()
          .describe("The MC (docket) number the caller gave you. Digits; 'MC-' prefix is fine."),
        claimed_dot: z
          .string()
          .optional()
          .describe("The DOT number the caller gave you, if they gave one. Omit if they did not."),
      }),
      execute: traced("lookup_carrier", async ({ mc_number, claimed_dot }) => {
        const now = deps.now();

        // Both of these already exist and are exhaustively tested; this tool is
        // a wrapper, deliberately. Reimplementing either would fork the rules
        // that decide whether freight moves.
        const result = await readThrough(mc_number, deps.source, deps.cache, { now });
        const compliance = evaluateLookup(result, {
          now,
          staleAgeMs: result.staleAgeMs,
          claimedDotNumber: claimed_dot ?? null,
        });

        const mcNumber = parseMcNumber(mc_number) ?? String(mc_number);
        state.rememberCompliance(mcNumber, compliance);

        if (result.status !== "found") {
          return {
            found: false,
            decision: compliance.decision,
            reasons: compliance.reasons,
            carrier: null,
            previous_calls: 0,
          };
        }

        const record = result.record;
        const stored = await deps.carriers.upsert(record);
        // Only a carrier that cleared the gate becomes the caller of record.
        // Assigning unconditionally let a blocked second lookup take the slot
        // and be written as the carrier a load was tendered to.
        state.rememberCarrier(mcNumber, record, stored);

        return {
          found: true,
          decision: compliance.decision,
          reasons: compliance.reasons,
          carrier: {
            mc_number: record.mcNumber,
            dot_number: record.dotNumber,
            legal_name: record.legalName,
            dba_name: record.dbaName,
            phone: record.phone,
            authority_status: record.authorityStatus,
            safety_rating: record.safetyRating,
            power_units: record.powerUnits,
          },
          // Day 7's memory beat: on call #2 this is not 1.
          previous_calls: Math.max(0, stored.totalCalls - 1),
        };
      }),
    }),

    check_compliance: tool({
      description:
        "Re-read the verification result for a carrier you already looked up. Use this to " +
        "restate why someone was cleared or blocked. Does not re-contact FMCSA.",
      inputSchema: z.object({
        mc_number: z.string().describe("The MC number you already looked up."),
      }),
      execute: traced("check_compliance", async ({ mc_number }) => {
        const mcNumber = parseMcNumber(mc_number) ?? String(mc_number);
        const compliance = state.complianceFor(mcNumber);

        // "Never looked up" is not "clean". Saying nothing here would let the
        // agent narrate a verification that never happened — the exact failure
        // DECISIONS #10 and #13 exist to prevent, one layer up.
        if (compliance === null) {
          return {
            verified: false,
            reason: "not_looked_up",
            message: `MC-${mcNumber} has not been verified on this call. Call lookup_carrier first.`,
          };
        }

        return { verified: true, decision: compliance.decision, reasons: compliance.reasons };
      }),
    }),

    get_load: tool({
      description: "Pull the details of a load on the board by its reference number.",
      inputSchema: z.object({
        load_ref: z.string().describe("The load reference, e.g. LD-10412."),
      }),
      execute: traced("get_load", async ({ load_ref }) => {
        const load = await deps.loads.byRef(load_ref);
        if (load === null) return { found: false, load_ref };

        // The allowlist projection. Never the raw row.
        return { found: true, load: toAgentLoad(load) };
      }),
    }),

    counter_offer: tool({
      description:
        "Decide what rate to offer the carrier. Pass what they asked for, if they named a " +
        "number. Returns the rate you should say out loud. You do not choose this number.",
      inputSchema: z.object({
        load_ref: z.string().describe("The load being negotiated."),
        mc_number: z.string().describe("The MC number of the carrier you are quoting."),
        carrier_asked_cents: z
          .number()
          .int()
          .positive()
          .nullable()
          .optional()
          .describe(
            "What the carrier asked for, in whole cents (e.g. 285000 for $2,850). " +
              "Omit if they have not named a number yet.",
          ),
      }),
      execute: traced("counter_offer", async ({ load_ref, mc_number, carrier_asked_cents }) => {
        // No rate before verification, and no rate to *this* carrier before
        // this carrier is verified. The prompt asks for the ordering, but the
        // model interleaves lookup_carrier with other calls in a single
        // parallel step, so asking is not enough — the Day 3 eval caught it
        // quoting $2,286.96 before the gate had answered.
        //
        // The MC argument is what scopes the check. Without it the gate could
        // only ask "has anyone on this call cleared", so a second lookup that
        // came back blocked was still quoted a rate. It also makes the quote
        // attributable in the trace: every offer names who it was for.
        const quotedMc = parseMcNumber(mc_number) ?? String(mc_number ?? "");
        const quotedCompliance = state.complianceFor(quotedMc);
        if (quotedCompliance === null || quotedCompliance.decision === "block") {
          return {
            action: "error" as const,
            reason: "carrier_not_verified",
            message: `Verify MC-${quotedMc} with lookup_carrier before quoting it any rate.`,
          };
        }
        // Belt and braces: the per-MC check above is the real gate, but a caller
        // of record must exist before any number is said out loud.
        if (!state.hasClearedCarrier()) {
          return {
            action: "error" as const,
            reason: "carrier_not_verified",
            message: "Verify the caller with lookup_carrier before quoting any rate.",
          };
        }

        const load = await deps.loads.byRef(load_ref);
        if (load === null) return { action: "error" as const, reason: "load_not_found" };
        if (state.isBooked(load_ref)) {
          return { action: "error" as const, reason: "already_booked" };
        }

        // A settled number stays settled. Recomputing the schedule after an
        // accept let a carrier reopen and be countered *upward*, which is
        // bidding against ourselves.
        const agreed = state.agreedRate(load_ref);
        if (agreed !== null) {
          return {
            action: "accept" as const,
            rate_cents: agreed,
            // The round that produced this number, not a new one. Nothing was
            // consumed here — this is a restatement — and saying so is what
            // stops a reader downstream inferring a counter from an answer.
            round: state.countersUsed(load_ref),
            counters_remaining: Math.max(0, MAX_COUNTERS - state.countersUsed(load_ref)),
          };
        }

        const policy = {
          floorCents: load.rateFloorCents,
          marketCents: load.rateMarketCents,
          ceilingCents: load.rateCeilingCents,
        };
        const round = state.nextRound(load_ref);
        const asked = carrier_asked_cents ?? null;
        const outcome = nextOffer({ policy, round, carrierAskedCents: asked });

        if (outcome.action === "walk_away") {
          // A walked-away turn does not consume a counter — there is nothing to
          // consume, because we did not say a number.
          return {
            action: "walk_away" as const,
            reason: outcome.reason,
            message:
              outcome.reason === "max_counters_exhausted"
                ? "You have made your final offer on this load. Do not name another number."
                : "This load's pricing is unavailable. Escalate rather than quoting.",
          };
        }

        state.recordOffer(load_ref, outcome.rateCents);
        if (outcome.action === "accept") state.recordAgreement(load_ref, outcome.rateCents);
        await deps.negotiations.record({
          runId: state.runId,
          loadId: load.id,
          turn: outcome.round,
          carrierAskedCents: asked,
          agentOfferedCents: outcome.rateCents,
          accepted: outcome.action === "accept",
        });

        return {
          action: outcome.action,
          rate_cents: outcome.rateCents,
          // The counter this actually was. Reported rather than left to be
          // counted downstream: a reader that counts answers instead of counters
          // disagrees with the tool layer the moment one of them is a
          // restatement. Like `counters_remaining` it is a count of turns and
          // carries no distance to any number.
          round: outcome.round,
          counters_remaining: Math.max(0, MAX_COUNTERS - state.countersUsed(load_ref)),
        };
      }),
    }),

    book_load: tool({
      description:
        "Book a load onto a verified carrier at an agreed rate. Only call this once the " +
        "carrier has accepted a rate you offered.",
      inputSchema: z.object({
        load_ref: z.string(),
        mc_number: z.string().describe("The MC number you verified earlier."),
        rate_cents: z.number().int().positive().describe("The agreed rate, in whole cents."),
      }),
      execute: traced(
        "book_load",
        // `unknown` in, deliberately: zod is defense in depth, not the defense.
        // This function must hold on its own, because the exhaustive tests call
        // it directly with values zod would have rejected.
        async (input: { load_ref: string; mc_number: string; rate_cents: unknown }) => {
          const { load_ref, mc_number, rate_cents } = input;

          const load = await deps.loads.byRef(load_ref);
          if (load === null) return { booked: false as const, reason: "load_not_found" };

          const mcNumber = parseMcNumber(mc_number) ?? String(mc_number);
          const compliance = state.complianceFor(mcNumber);
          if (compliance === null) {
            return { booked: false as const, reason: "carrier_not_verified" };
          }
          if (compliance.decision === "block") {
            return { booked: false as const, reason: "carrier_blocked" };
          }
          // Compliance answers "is this MC clean". It does not answer "is this
          // MC the party we are on the phone with", and the carrier row we are
          // about to write is the answer to the second question.
          if (!state.isVerifiedCaller(mcNumber)) {
            return { booked: false as const, reason: "carrier_not_verified" };
          }

          const decision = canBook({
            policy: {
              floorCents: load.rateFloorCents,
              marketCents: load.rateMarketCents,
              ceilingCents: load.rateCeilingCents,
            },
            rateCents: rate_cents,
            lastOfferedCents: state.lastOffer(load_ref),
          });

          // The reason code is the whole answer. No number, no distance, no
          // hint about which direction would work.
          if (!decision.ok) return { booked: false as const, reason: decision.reason };

          const covered = await deps.loads.cover({
            loadId: load.id,
            carrierId: state.carrier?.id ?? null,
            bookedRateCents: decision.rateCents,
          });
          if (!covered) return { booked: false as const, reason: "load_unavailable" };

          state.markBooked(load_ref, load.id, decision.rateCents);
          await deps.negotiations.record({
            runId: state.runId,
            loadId: load.id,
            turn: state.countersUsed(load_ref),
            carrierAskedCents: null,
            agentOfferedCents: decision.rateCents,
            accepted: true,
          });

          return {
            booked: true as const,
            load_ref,
            rate_cents: decision.rateCents,
            carrier_mc: mcNumber,
          };
        },
      ),
    }),

    escalate_to_human: tool({
      description:
        "Hand the call to a person. Use for system failures, disputes, or anything you are " +
        "not equipped to settle. Ends your part of the call.",
      inputSchema: z.object({
        reason: z.string().describe("Why a person is needed. One sentence."),
      }),
      execute: traced("escalate_to_human", async ({ reason }) => {
        // Cannot unwind a committed booking. See CallState.setOutcome.
        state.setOutcome("escalated");
        await deps.runs.finish({
          runId: state.runId,
          outcome: state.outcome,
          finalRateCents: state.finalRateCents,
          carrierId: state.carrier?.id ?? null,
          loadId: state.bookedLoadId,
        });
        return { escalated: true, reason };
      }),
    }),

    end_call: tool({
      description: "End the call. Always call this when the conversation is over, whatever happened.",
      inputSchema: z.object({
        outcome: z
          .enum(["booked", "rejected", "blocked", "abandoned"])
          .describe("How the call ended."),
        summary: z.string().describe("One or two sentences on what happened."),
      }),
      execute: traced("end_call", async ({ outcome, summary }) => {
        // A booking already set the outcome and the rate; end_call must not be
        // able to overwrite that with whatever the model believes happened.
        //
        // The reverse direction needed guarding too. `booked` is the one
        // outcome with a committed `loads` row behind it, and the model could
        // simply assert it: end_call({outcome: "booked"}) with no book_load
        // wrote outcome='booked' with a null rate, a null load and no covered
        // freight. Day 6's before/after delta counts those rows, so a model
        // that merely believed it had booked inflated the headline number.
        const claimed =
          outcome === "booked" && state.finalRateCents === null ? "abandoned" : outcome;
        state.setOutcome(claimed);

        await deps.runs.finish({
          runId: state.runId,
          outcome: state.outcome,
          finalRateCents: state.finalRateCents,
          carrierId: state.carrier?.id ?? null,
          loadId: state.bookedLoadId,
        });

        return { ended: true, outcome: state.outcome, summary };
      }),
    }),
  };
}
