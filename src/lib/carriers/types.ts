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
};

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
   * DOT numbers of other entities sharing this MC number. MC numbers are not
   * unique in FMCSA data — MC-143229 maps to six distinct legal entities — so
   * the losers of the resolution sort are carried here rather than discarded.
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
