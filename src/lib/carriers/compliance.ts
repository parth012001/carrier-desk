import type { CarrierRecord, LookupResult } from "./types";

/**
 * The compliance gate. Pure — no I/O, no clock, no network — so it is
 * exhaustively testable and the agent's tool layer can call it freely.
 *
 * A wrong `allow` is the worst bug in this system: it books freight onto a
 * carrier that cannot legally haul it, with no insurance backstop. Every rule
 * below is a row in RULES, `decision` is the highest severity present, and
 * compliance.test.ts enumerates the full combination space rather than
 * sampling it.
 */

export type Severity = "block" | "flag" | "info";

export type ComplianceCode =
  | "NOT_FOUND"
  | "LOOKUP_FAILED"
  | "AUTHORITY_NOT_ACTIVE"
  | "OUT_OF_SERVICE"
  | "SAFETY_RATING_UNSATISFACTORY"
  | "NOT_AUTHORIZED_FOR_HIRE"
  | "SAFETY_RATING_CONDITIONAL"
  | "PRIOR_AUTHORITY_REVOCATION"
  | "NO_POWER_UNITS"
  | "NEW_AUTHORITY"
  | "AMBIGUOUS_MC"
  | "OOS_NOT_VERIFIED"
  | "FOR_HIRE_NOT_VERIFIED"
  | "STALE_LOOKUP"
  | "MC_DOT_MISMATCH";

export type ComplianceDecision = "allow" | "flag" | "block";

export type ComplianceReason = {
  code: ComplianceCode;
  severity: Severity;
  /** Written to be read aloud by the agent and rendered in the trace UI. */
  message: string;
};

export type ComplianceResult = {
  decision: ComplianceDecision;
  reasons: ComplianceReason[];
};

/** Authority younger than this is the primary chameleon-carrier window. */
export const NEW_AUTHORITY_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

type Rule = {
  code: ComplianceCode;
  severity: Severity;
  applies: (record: CarrierRecord, now: Date) => boolean;
  message: (record: CarrierRecord) => string;
};

const AUTHORITY_LABEL: Record<CarrierRecord["authorityStatus"], string> = {
  active: "active",
  inactive: "not active",
  pending: "still pending",
  none: "not on file",
  unknown: "unreadable",
};

/**
 * Declaration order is output order, so reasons read blockers-first and
 * snapshots stay stable.
 */
export const RULES: readonly Rule[] = [
  {
    code: "AUTHORITY_NOT_ACTIVE",
    severity: "block",
    applies: (r) => r.authorityStatus !== "active",
    message: (r) =>
      `Operating authority for MC-${r.mcNumber} is ${AUTHORITY_LABEL[r.authorityStatus]}. ` +
      `A carrier without active authority cannot legally haul this load.`,
  },
  {
    code: "OUT_OF_SERVICE",
    severity: "block",
    applies: (r) => r.isOutOfService === true,
    message: (r) => `${r.legalName} is under an FMCSA out-of-service order.`,
  },
  {
    code: "SAFETY_RATING_UNSATISFACTORY",
    severity: "block",
    // 49 CFR 385.13: a final Unsatisfactory rating prohibits the carrier from
    // operating a CMV in interstate commerce. This is a legal bar, not a
    // preference, so it blocks even when authority still reads active.
    applies: (r) => r.safetyRating === "unsatisfactory",
    message: (r) =>
      `${r.legalName} holds an Unsatisfactory FMCSA safety rating and is prohibited ` +
      `from operating in interstate commerce under 49 CFR 385.13.`,
  },
  {
    code: "NOT_AUTHORIZED_FOR_HIRE",
    severity: "block",
    applies: (r) => r.authorizedForHire === false,
    message: (r) =>
      `${r.legalName} is not registered for-hire with FMCSA, so it cannot be paid ` +
      `to haul freight for a third party.`,
  },
  {
    code: "SAFETY_RATING_CONDITIONAL",
    severity: "flag",
    applies: (r) => r.safetyRating === "conditional",
    message: (r) => `${r.legalName} holds a Conditional safety rating — needs human review.`,
  },
  {
    code: "PRIOR_AUTHORITY_REVOCATION",
    severity: "flag",
    applies: (r) => r.priorRevocation === true,
    message: (r) =>
      `${r.legalName} has had operating authority revoked before — a chameleon-carrier signal.`,
  },
  {
    code: "NO_POWER_UNITS",
    severity: "flag",
    // Authority but no trucks is the classic double-brokering shape: the entity
    // takes the load and re-tenders it to someone you never vetted.
    applies: (r) => r.powerUnits === 0,
    message: (r) =>
      `${r.legalName} reports zero power units to FMCSA. A carrier with authority ` +
      `but no equipment is a double-brokering risk.`,
  },
  {
    code: "NEW_AUTHORITY",
    severity: "flag",
    applies: (r, now) =>
      r.authorityGrantedAt !== null &&
      now.getTime() - r.authorityGrantedAt.getTime() < NEW_AUTHORITY_DAYS * DAY_MS,
    message: (r) =>
      `Operating authority for MC-${r.mcNumber} was granted within the last ` +
      `${NEW_AUTHORITY_DAYS} days — the window where chameleon carriers reappear.`,
  },
  {
    code: "AMBIGUOUS_MC",
    severity: "flag",
    // Keyed off the count, not off `ambiguousWith`. Socrata omits empty fields,
    // so losing rows may carry no DOT number — and reading the signal off that
    // array made the flag disappear on exactly the lookups where we knew least
    // about who else holds this MC.
    applies: (r) => r.ambiguousCount > 0,
    message: (r) =>
      `MC-${r.mcNumber} resolves to ${r.ambiguousCount + 1} FMCSA entities. ` +
      `Proceeding with DOT ${r.dotNumber ?? "unknown"}; confirm which company is calling.`,
  },
  {
    code: "OOS_NOT_VERIFIED",
    severity: "info",
    // Keyed off the VALUE, not the capability bit. QCMobile declares it can
    // answer this, but omits elements that have no value — so a real record can
    // come back with the capability true and the answer still null. Reading the
    // capability alone reported "checked and clean" about a question that got no
    // answer, which is the failure docs/DECISIONS.md #10 exists to prevent.
    //
    // Deliberately info, not flag. Every Socrata lookup trips this, so a flag
    // would be noise — but dropping it would overstate what the gate proved.
    applies: (r) => r.isOutOfService === null,
    message: (r) =>
      r.capabilities.outOfService
        ? `Out-of-service status came back empty from FMCSA — not confirmed clear.`
        : `Out-of-service status was not verified — the FMCSA census source does not ` +
          `carry that field. Confirm via QCMobile before high-value freight.`,
  },
  {
    code: "FOR_HIRE_NOT_VERIFIED",
    severity: "info",
    // Same rule, applied to the other field that drives a block. A null here is
    // "we never established it", not "they are registered for hire".
    // Scoped to active authority on purpose. Every source returns null here for
    // pending/inactive/none, which already block — adding an info line there is
    // noise stacked on the demo's headline moment.
    applies: (r) => r.authorizedForHire === null && r.authorityStatus === "active",
    message: (r) => `For-hire registration for MC-${r.mcNumber} could not be determined.`,
  },
];

const SEVERITY_RANK: Record<Severity, number> = { info: 0, flag: 1, block: 2 };
const DECISION_BY_RANK: Record<number, ComplianceDecision> = {
  0: "allow",
  1: "flag",
  2: "block",
};

/** The decision is always the highest severity present. Never anything else. */
function decisionFor(reasons: readonly ComplianceReason[]): ComplianceDecision {
  const rank = reasons.reduce((max, reason) => Math.max(max, SEVERITY_RANK[reason.severity]), 0);
  return DECISION_BY_RANK[rank];
}

/**
 * Decide whether a carrier may be booked.
 *
 * `now` is injected rather than read from the clock so tests are deterministic
 * — and because this machine's system clock runs slow. See docs/STATE.md.
 */
export function evaluateCompliance(
  record: CarrierRecord,
  options: { now?: Date } = {},
): ComplianceResult {
  const now = options.now ?? new Date();

  const reasons = RULES.filter((rule) => rule.applies(record, now)).map((rule) => ({
    code: rule.code,
    severity: rule.severity,
    message: rule.message(record),
  }));

  return { decision: decisionFor(reasons), reasons };
}

export type EvaluateLookupOptions = {
  now?: Date;
  /**
   * Age of the served payload when the live lookup failed and a past-TTL cache
   * entry was used instead — i.e. `ReadThroughResult.staleAgeMs`, passed
   * straight through. Undefined on the happy path.
   */
  staleAgeMs?: number;
  /**
   * The DOT number the *caller* volunteered, digits only. Compared against the
   * DOT the registry actually has for this MC.
   */
  claimedDotNumber?: string | null;
};

/**
 * A caller whose claimed DOT does not match the DOT on their claimed MC is
 * reading two identities off two different pieces of paper. That is the shape
 * of a carrier reciting a legitimate company's MC while operating as someone
 * else — the identity-theft variant of double-brokering, and one of the few
 * fraud signals available before any freight moves.
 *
 * Like STALE_LOOKUP this is a fact about the *lookup*, not about the carrier:
 * the claim lives in the conversation, not in the FMCSA record, so it cannot
 * be a RULES entry without handing evaluateCompliance something a CarrierRecord
 * does not have.
 *
 * Flag rather than block: transposed digits on a phone call are common, and the
 * right response is a human asking which company is calling, not a hang-up.
 */
function mcDotMismatchReason(record: CarrierRecord, claimed: string): ComplianceReason {
  return {
    code: "MC_DOT_MISMATCH",
    severity: "flag",
    message:
      `Caller gave DOT ${claimed}, but MC-${record.mcNumber} is registered to ` +
      `DOT ${record.dotNumber ?? "no DOT on file"} (${record.legalName}). ` +
      `Confirm which company is calling before tendering freight.`,
  };
}

/**
 * Staleness is a property of the *lookup*, not of the carrier, so it lives here
 * rather than in RULES. Putting it in RULES would mean `evaluateCompliance`
 * needs a fact that does not exist on a CarrierRecord, and would drag a clock
 * and a cache into the one function in this system that is deliberately pure.
 *
 * Severity is **flag**, and the contrast with OOS_NOT_VERIFIED is the argument:
 * that one is info because it fires on every single Socrata lookup, and a flag
 * on everything trains everyone to ignore flags. This one fires only when a
 * government API actually failed to answer, which is rare and worth hearing.
 */
function staleReason(mcNumber: string, staleAgeMs: number): ComplianceReason {
  const hours = Math.round(staleAgeMs / (60 * 60 * 1000));
  return {
    code: "STALE_LOOKUP",
    severity: "flag",
    message:
      `The live FMCSA lookup for MC-${mcNumber} failed, so this decision was made on a ` +
      `cached record roughly ${hours}h old. Re-verify before high-value freight.`,
  };
}

/**
 * The gate as the agent actually calls it: straight from a lookup outcome.
 *
 * A carrier we could not find and a source we could not reach are both blocks,
 * but for different reasons and with different follow-ups — one is a bad actor,
 * the other is an escalation to a human.
 */
export function evaluateLookup(
  result: LookupResult,
  options: EvaluateLookupOptions = {},
): ComplianceResult {
  // Prepended, not appended. RULES order puts blockers first so reasons read
  // worst-first, but staleness is a caveat about the whole lookup — whoever
  // reads this should know the data is old *before* they read anything
  // concluded from it.
  const stale =
    options.staleAgeMs !== undefined && options.staleAgeMs > 0
      ? [staleReason(mcNumberOf(result), options.staleAgeMs)]
      : [];

  switch (result.status) {
    case "found": {
      const base = evaluateCompliance(result.record, options);

      // Compared as digits, so "DOT 286764", " 0286764 " and "286764" all agree.
      // A claim we cannot parse is not evidence of a mismatch — it is a caller
      // mumbling — so it raises nothing.
      const claimed = parseDigits(options.claimedDotNumber);
      const mismatch =
        claimed !== null && result.record.dotNumber !== null && claimed !== result.record.dotNumber
          ? [mcDotMismatchReason(result.record, claimed)]
          : [];

      if (stale.length === 0 && mismatch.length === 0) return base;
      const reasons = [...stale, ...mismatch, ...base.reasons];
      return { decision: decisionFor(reasons), reasons };
    }
    case "not_found": {
      const reasons: ComplianceReason[] = [
        ...stale,
        {
          code: "NOT_FOUND",
          severity: "block",
          message:
            `No FMCSA record exists for MC-${result.mcNumber}. ` +
            `Nothing about this carrier can be verified.`,
        },
      ];
      return { decision: decisionFor(reasons), reasons };
    }
    case "error": {
      // Reaching here means the stale fallback found nothing usable either —
      // no cache entry, or one past the fallback cap. Both mean we know
      // nothing current about this carrier.
      const reasons: ComplianceReason[] = [
        ...stale,
        {
          code: "LOOKUP_FAILED",
          severity: "block",
          message:
            `FMCSA lookup for MC-${result.mcNumber} failed: ${result.message}. ` +
            `Cannot verify this carrier — escalate to a human rather than booking.`,
        },
      ];
      return { decision: decisionFor(reasons), reasons };
    }
  }
}

function mcNumberOf(result: LookupResult): string {
  return result.status === "found" ? result.record.mcNumber : result.mcNumber;
}

/** Digits only, leading zeros dropped. null when there is nothing numeric to read. */
function parseDigits(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/\D/g, "").replace(/^0+/, "");
  return digits === "" ? null : digits;
}
