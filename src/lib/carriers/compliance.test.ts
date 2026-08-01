import { describe, expect, it } from "vitest";

import {
  NEW_AUTHORITY_DAYS,
  RULES,
  evaluateCompliance,
  evaluateLookup,
  type ComplianceCode,
  type ComplianceDecision,
} from "./compliance";
import type { AuthorityStatus, CarrierRecord, SafetyRating } from "./types";

/**
 * evaluateCompliance is the safety-critical function in this system: a wrong
 * `allow` books freight onto a carrier that cannot legally haul it. The
 * combination space is enumerated, not sampled.
 */

/** Fixed so nothing depends on the system clock, which runs slow on this machine. */
const NOW = new Date("2026-08-01T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const AUTHORITY_STATUSES: AuthorityStatus[] = [
  "active",
  "inactive",
  "pending",
  "none",
  "unknown",
];
const OUT_OF_SERVICE: (boolean | null)[] = [true, false, null];
const SAFETY_RATINGS: (SafetyRating | null)[] = [
  "satisfactory",
  "conditional",
  "unsatisfactory",
  null,
];
const FOR_HIRE: (boolean | null)[] = [true, false, null];
const POWER_UNITS: (number | null)[] = [0, null, 12];
const PRIOR_REVOCATION: (boolean | null)[] = [true, false, null];

type Axes = {
  authorityStatus: AuthorityStatus;
  isOutOfService: boolean | null;
  safetyRating: SafetyRating | null;
  authorizedForHire: boolean | null;
  powerUnits: number | null;
  priorRevocation: boolean | null;
};

function recordFor(axes: Axes): CarrierRecord {
  return {
    mcNumber: "186800",
    dotNumber: "286764",
    legalName: "GENERAL TRANSPORT INC",
    dbaName: null,
    phone: "8006276055",
    ...axes,
    // Held constant across the product; exercised by their own suites below.
    authorityGrantedAt: new Date("1987-02-04T00:00:00.000Z"),
    source: "socrata",
    capabilities: {
      authorityStatus: true,
      // A source that returned a real boolean must have been able to check.
      outOfService: axes.isOutOfService !== null,
      safetyRating: true,
      powerUnits: true,
      priorRevocation: true,
      authorityGrantedAt: true,
    },
    ambiguousWith: [],
  };
}

/**
 * A second, independent statement of the rule table — written from the spec in
 * docs/PLAN.md rather than from RULES. If the two disagree, one of them is
 * wrong and the test says which case.
 */
function expected(axes: Axes): { decision: ComplianceDecision; codes: ComplianceCode[] } {
  const blocks: ComplianceCode[] = [];
  const flags: ComplianceCode[] = [];
  const infos: ComplianceCode[] = [];

  if (axes.authorityStatus !== "active") blocks.push("AUTHORITY_NOT_ACTIVE");
  if (axes.isOutOfService === true) blocks.push("OUT_OF_SERVICE");
  if (axes.safetyRating === "unsatisfactory") blocks.push("SAFETY_RATING_UNSATISFACTORY");
  if (axes.authorizedForHire === false) blocks.push("NOT_AUTHORIZED_FOR_HIRE");

  if (axes.safetyRating === "conditional") flags.push("SAFETY_RATING_CONDITIONAL");
  if (axes.priorRevocation === true) flags.push("PRIOR_AUTHORITY_REVOCATION");
  if (axes.powerUnits === 0) flags.push("NO_POWER_UNITS");

  if (axes.isOutOfService === null) infos.push("OOS_NOT_VERIFIED");

  const decision: ComplianceDecision =
    blocks.length > 0 ? "block" : flags.length > 0 ? "flag" : "allow";

  return { decision, codes: [...blocks, ...flags, ...infos] };
}

const ALL_CASES: Axes[] = AUTHORITY_STATUSES.flatMap((authorityStatus) =>
  OUT_OF_SERVICE.flatMap((isOutOfService) =>
    SAFETY_RATINGS.flatMap((safetyRating) =>
      FOR_HIRE.flatMap((authorizedForHire) =>
        POWER_UNITS.flatMap((powerUnits) =>
          PRIOR_REVOCATION.map((priorRevocation) => ({
            authorityStatus,
            isOutOfService,
            safetyRating,
            authorizedForHire,
            powerUnits,
            priorRevocation,
          })),
        ),
      ),
    ),
  ),
);

describe("evaluateCompliance — exhaustive combination space", () => {
  it("covers every combination, not a sample", () => {
    expect(ALL_CASES).toHaveLength(5 * 3 * 4 * 3 * 3 * 3);
    expect(ALL_CASES).toHaveLength(1620);
    expect(new Set(ALL_CASES.map((c) => JSON.stringify(c))).size).toBe(ALL_CASES.length);
  });

  it("matches the independently-written rule table on all 1620 cases", () => {
    const mismatches: string[] = [];

    for (const axes of ALL_CASES) {
      const actual = evaluateCompliance(recordFor(axes), { now: NOW });
      const want = expected(axes);
      const gotCodes = actual.reasons.map((r) => r.code);

      if (actual.decision !== want.decision || gotCodes.join(",") !== want.codes.join(",")) {
        mismatches.push(
          `${JSON.stringify(axes)}\n  expected ${want.decision} [${want.codes}]` +
            `\n  actual   ${actual.decision} [${gotCodes}]`,
        );
      }
    }

    expect(mismatches.join("\n\n")).toBe("");
  });

  it("never allows when any blocking reason is present", () => {
    // The wrong-`allow` bug, stated directly.
    for (const axes of ALL_CASES) {
      const result = evaluateCompliance(recordFor(axes), { now: NOW });
      if (result.reasons.some((r) => r.severity === "block")) {
        expect(result.decision).toBe("block");
      }
    }
  });

  it("emits no blocking or flagging reason when it allows", () => {
    for (const axes of ALL_CASES) {
      const result = evaluateCompliance(recordFor(axes), { now: NOW });
      if (result.decision === "allow") {
        expect(result.reasons.every((r) => r.severity === "info")).toBe(true);
      }
    }
  });

  it("returns reasons in declaration order, with no duplicates", () => {
    const order = RULES.map((r) => r.code);

    for (const axes of ALL_CASES) {
      const codes = evaluateCompliance(recordFor(axes), { now: NOW }).reasons.map((r) => r.code);
      expect(new Set(codes).size).toBe(codes.length);
      expect(codes).toEqual([...codes].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    }
  });

  it("gives every reason a non-empty, carrier-specific message", () => {
    for (const axes of ALL_CASES) {
      for (const reason of evaluateCompliance(recordFor(axes), { now: NOW }).reasons) {
        expect(reason.message.length).toBeGreaterThan(20);
        expect(reason.message).not.toContain("undefined");
        expect(reason.message).not.toContain("null");
      }
    }
  });
});

describe("evaluateCompliance — decision is monotone in risk", () => {
  const WORSE: { label: string; apply: (a: Axes) => Axes }[] = [
    { label: "authority goes inactive", apply: (a) => ({ ...a, authorityStatus: "inactive" }) },
    { label: "carrier goes out of service", apply: (a) => ({ ...a, isOutOfService: true }) },
    {
      label: "rating drops to unsatisfactory",
      apply: (a) => ({ ...a, safetyRating: "unsatisfactory" }),
    },
    { label: "loses for-hire registration", apply: (a) => ({ ...a, authorizedForHire: false }) },
    { label: "equipment drops to zero", apply: (a) => ({ ...a, powerUnits: 0 }) },
    { label: "prior revocation surfaces", apply: (a) => ({ ...a, priorRevocation: true }) },
  ];

  const RANK: Record<ComplianceDecision, number> = { allow: 0, flag: 1, block: 2 };

  it.each(WORSE)("$label never improves the decision", ({ apply }) => {
    // Independent of the rule table: learning something bad about a carrier
    // must never move it toward being bookable.
    for (const axes of ALL_CASES) {
      const before = evaluateCompliance(recordFor(axes), { now: NOW }).decision;
      const after = evaluateCompliance(recordFor(apply(axes)), { now: NOW }).decision;
      expect(RANK[after]).toBeGreaterThanOrEqual(RANK[before]);
    }
  });
});

describe("NEW_AUTHORITY boundary", () => {
  function withGrantAge(days: number | null) {
    const axes: Axes = {
      authorityStatus: "active",
      isOutOfService: false,
      safetyRating: "satisfactory",
      authorizedForHire: true,
      powerUnits: 12,
      priorRevocation: false,
    };
    return {
      ...recordFor(axes),
      authorityGrantedAt: days === null ? null : new Date(NOW.getTime() - days * DAY_MS),
    };
  }

  it.each([
    [0, true],
    [1, true],
    [NEW_AUTHORITY_DAYS - 1, true],
    [NEW_AUTHORITY_DAYS, false],
    [NEW_AUTHORITY_DAYS + 1, false],
    [3650, false],
  ])("authority granted %i days ago -> flagged: %s", (days, flagged) => {
    const result = evaluateCompliance(withGrantAge(days), { now: NOW });
    const codes = result.reasons.map((r) => r.code);

    expect(codes.includes("NEW_AUTHORITY")).toBe(flagged);
    expect(result.decision).toBe(flagged ? "flag" : "allow");
  });

  it("does not flag when the grant date is unknown", () => {
    expect(
      evaluateCompliance(withGrantAge(null), { now: NOW }).reasons.map((r) => r.code),
    ).not.toContain("NEW_AUTHORITY");
  });

  it("defaults now to the current clock without throwing", () => {
    expect(() => evaluateCompliance(withGrantAge(3650))).not.toThrow();
  });
});

describe("AMBIGUOUS_MC", () => {
  const clean: Axes = {
    authorityStatus: "active",
    isOutOfService: false,
    safetyRating: "satisfactory",
    authorizedForHire: true,
    powerUnits: 12,
    priorRevocation: false,
  };

  it("flags an otherwise clean carrier whose MC maps to several entities", () => {
    const result = evaluateCompliance(
      { ...recordFor(clean), ambiguousWith: ["329380", "381799"] },
      { now: NOW },
    );

    expect(result.decision).toBe("flag");
    const reason = result.reasons.find((r) => r.code === "AMBIGUOUS_MC");
    expect(reason?.message).toContain("3 FMCSA entities");
    expect(reason?.message).toContain("286764");
  });

  it("does not flag when the MC is unique", () => {
    expect(
      evaluateCompliance(recordFor(clean), { now: NOW }).reasons.map((r) => r.code),
    ).not.toContain("AMBIGUOUS_MC");
  });
});

describe("OOS_NOT_VERIFIED", () => {
  const clean: Axes = {
    authorityStatus: "active",
    isOutOfService: null,
    safetyRating: "satisfactory",
    authorizedForHire: true,
    powerUnits: 12,
    priorRevocation: false,
  };

  it("still allows, but says out loud what was not checked", () => {
    const result = evaluateCompliance(recordFor(clean), { now: NOW });

    expect(result.decision).toBe("allow");
    expect(result.reasons.map((r) => r.code)).toEqual(["OOS_NOT_VERIFIED"]);
    expect(result.reasons[0].severity).toBe("info");
  });

  it("goes silent once a source can answer the question", () => {
    const record = recordFor({ ...clean, isOutOfService: false });

    expect(record.capabilities.outOfService).toBe(true);
    expect(evaluateCompliance(record, { now: NOW }).reasons).toEqual([]);
  });
});

describe("evaluateLookup — lookup outcomes", () => {
  it("blocks a carrier with no FMCSA record", () => {
    const result = evaluateLookup({ status: "not_found", mcNumber: "9999999" }, { now: NOW });

    expect(result.decision).toBe("block");
    expect(result.reasons.map((r) => r.code)).toEqual(["NOT_FOUND"]);
    expect(result.reasons[0].message).toContain("9999999");
  });

  it("blocks on a failed lookup with a distinct code from not_found", () => {
    // An outage must never read as a fraud finding, and must never read as a
    // clean carrier either. It blocks — but as an escalation, not an accusation.
    const result = evaluateLookup(
      { status: "error", mcNumber: "186800", message: "Socrata returned 503" },
      { now: NOW },
    );

    expect(result.decision).toBe("block");
    expect(result.reasons.map((r) => r.code)).toEqual(["LOOKUP_FAILED"]);
    expect(result.reasons[0].message).toContain("503");
    expect(result.reasons[0].message).toContain("escalate");
  });

  it("delegates a found carrier to the rule table", () => {
    const record = recordFor({
      authorityStatus: "inactive",
      isOutOfService: null,
      safetyRating: null,
      authorizedForHire: true,
      powerUnits: 55,
      priorRevocation: true,
    });

    const result = evaluateLookup({ status: "found", record, raw: null }, { now: NOW });

    expect(result.decision).toBe("block");
    expect(result.reasons.map((r) => r.code)).toEqual([
      "AUTHORITY_NOT_ACTIVE",
      "PRIOR_AUTHORITY_REVOCATION",
      "OOS_NOT_VERIFIED",
    ]);
  });
});
