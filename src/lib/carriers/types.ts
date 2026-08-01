/**
 * The normalized carrier shape and the interface every data source implements.
 *
 * Compliance logic must never see a raw provider payload — see docs/DECISIONS.md #5.
 * Two sources exist: Socrata (keyless census data) and QCMobile (richer, WebKey-gated).
 * They do not expose the same facts, and that asymmetry is modelled explicitly here
 * rather than papered over.
 */

export type SourceId = "socrata" | "qcmobile";

export type AuthorityStatus =
  /** Docket is in effect. The carrier can legally haul for hire. */
  | "active"
  /** Docket is on record but not in effect — revoked, surrendered, or dismissed. */
  | "inactive"
  /** Application filed, not yet granted. */
  | "pending"
  /** Entity exists in the registry but holds no docket at all. */
  | "none"
  /** The source returned a value we do not recognise. Never treat as safe. */
  | "unknown";

export type SafetyRating = "satisfactory" | "conditional" | "unsatisfactory";

/**
 * What a source is *able* to answer, independent of what it did answer.
 *
 * This is the difference between "we checked and the carrier is fine" and
 * "we never checked". The Socrata census file has no out-of-service column at
 * all — all 148 of them — so it can only ever return `isOutOfService: null`.
 * Reporting that as `false` would mean the gate silently clears carriers on a
 * question it never asked.
 */
export type SourceCapabilities = {
  authorityStatus: boolean;
  outOfService: boolean;
  safetyRating: boolean;
  powerUnits: boolean;
  priorRevocation: boolean;
  authorityGrantedAt: boolean;
  authorizedForHire: boolean;
};

/**
 * The CarrierRecord fields a source may decline to answer. Every one of these
 * has a matching SourceCapabilities key, and the cross-source contract test
 * asserts that a `false` capability always pairs with a `null` value — so a
 * difference between two sources is always a declared gap, never a bug.
 */
export const CAPABILITY_FIELDS = {
  authorityStatus: "authorityStatus",
  outOfService: "isOutOfService",
  safetyRating: "safetyRating",
  powerUnits: "powerUnits",
  priorRevocation: "priorRevocation",
  authorityGrantedAt: "authorityGrantedAt",
  authorizedForHire: "authorizedForHire",
} as const satisfies Record<keyof SourceCapabilities, keyof CarrierRecord>;

export type CarrierRecord = {
  /** Digits only. No "MC-" prefix, no leading zeros. */
  mcNumber: string;
  dotNumber: string | null;
  legalName: string;
  dbaName: string | null;
  phone: string | null;

  authorityStatus: AuthorityStatus;
  /** `null` means this source cannot determine it — never "not out of service". */
  isOutOfService: boolean | null;
  safetyRating: SafetyRating | null;
  powerUnits: number | null;
  /** Whether the entity is registered to haul for hire at all. */
  authorizedForHire: boolean | null;
  /** When the entity was first registered. Drives the chameleon-carrier check. */
  authorityGrantedAt: Date | null;
  /** Whether this entity has had an authority revoked before. */
  priorRevocation: boolean | null;

  source: SourceId;
  capabilities: SourceCapabilities;
  /**
   * How many OTHER entities share this MC number. MC numbers are not unique in
   * FMCSA data — MC-143229 maps to six distinct legal entities.
   *
   * This is the ambiguity signal, not `ambiguousWith`. It is derived from the
   * row count, so it holds even when the losing rows carry no DOT number —
   * Socrata omits empty fields entirely, and keying the flag off `ambiguousWith`
   * meant ambiguity silently disappeared exactly when we knew least about the
   * other entities.
   */
  ambiguousCount: number;
  /**
   * DOT numbers of the other entities, where FMCSA gave us one. Best-effort
   * identification for the human — never the trigger for a compliance rule.
   */
  ambiguousWith: string[];
};

/**
 * Three outcomes, not two. "No such carrier" and "the API is down" lead to
 * opposite actions: the first is a hard block, the second is a retry or an
 * escalation to a human. Collapsing them into `null` would let an outage read
 * as a fraud finding.
 */
export type LookupResult =
  | { status: "found"; record: CarrierRecord; raw: unknown }
  | { status: "not_found"; mcNumber: string }
  | { status: "error"; mcNumber: string; message: string };

export interface CarrierDataSource {
  readonly id: SourceId;
  readonly capabilities: SourceCapabilities;

  /** Look up by MC (docket) number. Input may be dirty: "MC-123456", " 00123456 ". */
  lookupByMc(mcNumber: string): Promise<LookupResult>;

  /**
   * Re-normalize a payload previously returned in `raw`, without any network
   * call. The cache replays through this, so a cached lookup and a live lookup
   * produce byte-identical records.
   */
  normalize(raw: unknown, mcNumber: string): CarrierRecord | null;
}
