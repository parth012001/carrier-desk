import { z } from "zod";

import {
  parseFmcsaDate,
  parseIntOrNull,
  parseMcNumber,
  parseYesNo,
  trimOrNull,
} from "./normalize";
import type {
  AuthorityStatus,
  CarrierDataSource,
  CarrierRecord,
  LookupResult,
  SafetyRating,
  SourceCapabilities,
} from "./types";

/**
 * FMCSA Company Census File on data.transportation.gov, dataset az4n-8mr2.
 * Keyless: SOCRATA_APP_TOKEN only raises the rate limit.
 *
 * What this dataset is and is not:
 *
 * - It has 148 columns and NONE of them is out-of-service. Only QCMobile has
 *   that. `isOutOfService` is therefore always null here and the capability is
 *   declared false. See docs/DECISIONS.md #10.
 * - `docket1_status_code` is the authority signal, not `status_code`. They
 *   disagree constantly: a carrier can be entity-Active with an Inactive docket
 *   (authority gone, still operating — our demo bad actor) or entity-Inactive
 *   with an Active docket (just never filed its MCS-150).
 * - Docket status is only ever A/I/P. There is no "R", so a revoked authority
 *   and a voluntarily surrendered one are indistinguishable here; both are
 *   "inactive", and neither may haul freight.
 * - Every numeric-looking column is declared `text` and SoQL compares it
 *   lexically, so `power_units < '100'` is false for `'20'`. Never filter
 *   numerically in the query; parse to int here.
 * - Empty fields are omitted from the response entirely rather than sent null.
 */

const DATASET_URL = "https://data.transportation.gov/resource/az4n-8mr2.json";

export const SOCRATA_CAPABILITIES: SourceCapabilities = {
  authorityStatus: true,
  outOfService: false, // the census file has no such column
  safetyRating: true,
  powerUnits: true,
  priorRevocation: true,
};

/**
 * Loose on purpose. Socrata returns 56-odd populated keys out of 148 and adds
 * columns over time; a strict schema would fail a live lookup because the
 * government added a field. We validate the shape of what we read and ignore
 * the rest.
 */
const socrataRowSchema = z
  .looseObject({
    dot_number: z.union([z.string(), z.number()]).optional(),
    legal_name: z.string().optional(),
    dba_name: z.string().optional(),
    phone: z.string().optional(),
    status_code: z.string().optional(),
    docket1prefix: z.string().optional(),
    docket1: z.string().optional(),
    docket1_status_code: z.string().optional(),
    docket2prefix: z.string().optional(),
    docket2: z.string().optional(),
    docket2_status_code: z.string().optional(),
    docket3prefix: z.string().optional(),
    docket3: z.string().optional(),
    docket3_status_code: z.string().optional(),
    safety_rating: z.string().optional(),
    power_units: z.string().optional(),
    classdef: z.string().optional(),
    add_date: z.string().optional(),
    mcs150_date: z.string().optional(),
    prior_revoke_flag: z.string().optional(),
  })
  .readonly();

export type SocrataRow = z.output<typeof socrataRowSchema>;

const socrataResponseSchema = z.array(socrataRowSchema);

/** Socrata error body: `{"message": "...", "errorCode": "..."}`. */
const socrataErrorSchema = z.looseObject({
  message: z.string().optional(),
  errorCode: z.string().optional(),
});

type DocketSlot = 1 | 2 | 3;
const DOCKET_SLOTS: readonly DocketSlot[] = [1, 2, 3];

function docketOf(row: SocrataRow, slot: DocketSlot) {
  return {
    prefix: trimOrNull(row[`docket${slot}prefix`]),
    number: parseMcNumber(row[`docket${slot}`]),
    status: trimOrNull(row[`docket${slot}_status_code`])?.toUpperCase() ?? null,
  };
}

/** Which of the three docket slots holds the MC we asked about. */
function matchingDocket(row: SocrataRow, mcNumber: string) {
  for (const slot of DOCKET_SLOTS) {
    const docket = docketOf(row, slot);
    if (docket.prefix === "MC" && docket.number === mcNumber) return docket;
  }
  return null;
}

function toAuthorityStatus(statusCode: string | null): AuthorityStatus {
  switch (statusCode) {
    case "A":
      return "active";
    case "I":
      // Revoked, surrendered, or dismissed — this dataset cannot tell them
      // apart, and none of them may haul freight.
      return "inactive";
    case "P":
      return "pending";
    case null:
      return "none";
    default:
      return "unknown";
  }
}

function toSafetyRating(raw: string | null): SafetyRating | null {
  switch (raw?.toUpperCase()) {
    case "S":
      return "satisfactory";
    case "C":
      return "conditional";
    case "U":
      return "unsatisfactory";
    default:
      return null;
  }
}

/**
 * `classdef` is a `;`-delimited list: "AUTHORIZED FOR HIRE",
 * "PRIVATE PROPERTY;AUTHORIZED FOR HIRE", "OTHER-APPLYING FOR MC".
 * A private-property-only entity cannot legally take for-hire freight.
 */
function toAuthorizedForHire(classdef: string | null): boolean | null {
  if (classdef === null) return null;
  const classes = classdef.split(";").map((c) => c.trim().toUpperCase());
  return classes.includes("AUTHORIZED FOR HIRE");
}

/**
 * Deterministic resolution when one MC maps to several entities.
 *
 * MC numbers are not unique in this dataset: MC-143229 returns six rows across
 * two states, exactly one with active authority, and 1000+ MC values are
 * duplicated. `rows[0]` is nondeterministic on the path that decides whether to
 * book freight, so the ordering below is total — the DOT tiebreak guarantees no
 * two rows ever compare equal.
 *
 * Returns the winner plus the DOT numbers of everyone else, which become an
 * AMBIGUOUS_MC flag rather than being silently dropped.
 */
export function resolveCandidates(
  rows: readonly SocrataRow[],
  mcNumber: string,
): { winner: SocrataRow; others: string[] } | null {
  if (rows.length === 0) return null;

  const ranked = [...rows].sort((a, b) => {
    // 1. Active docket wins — this is the "can they legally haul" signal.
    const docketRank = rankActive(matchingDocket(a, mcNumber)?.status) - rankActive(matchingDocket(b, mcNumber)?.status);
    if (docketRank !== 0) return docketRank;

    // 2. Active entity wins.
    const entityRank =
      rankActive(trimOrNull(a.status_code)?.toUpperCase()) -
      rankActive(trimOrNull(b.status_code)?.toUpperCase());
    if (entityRank !== 0) return entityRank;

    // 3. Most recently updated MCS-150 wins — the freshest filing.
    const freshness = msSinceEpoch(b.mcs150_date) - msSinceEpoch(a.mcs150_date);
    if (freshness !== 0) return freshness;

    // 4. Lowest DOT number. Total ordering; no ties remain.
    return (parseIntOrNull(a.dot_number) ?? Infinity) - (parseIntOrNull(b.dot_number) ?? Infinity);
  });

  const [winner, ...rest] = ranked;
  const others = rest
    .map((row) => trimOrNull(String(row.dot_number ?? "")))
    .filter((dot): dot is string => dot !== null);

  return { winner, others };
}

/** Lower sorts first. Active beats everything; unknown sorts last. */
function rankActive(status: string | null | undefined): number {
  return status === "A" ? 0 : 1;
}

function msSinceEpoch(raw: unknown): number {
  return parseFmcsaDate(raw)?.getTime() ?? 0;
}

export class SocrataCarrierSource implements CarrierDataSource {
  readonly id = "socrata" as const;
  readonly capabilities = SOCRATA_CAPABILITIES;

  constructor(
    private readonly options: {
      appToken?: string;
      fetchImpl?: typeof fetch;
      datasetUrl?: string;
    } = {},
  ) {}

  /**
   * Dockets live in docket1/docket2/docket3 — 79k rows use slot 2 and 3.3k use
   * slot 3 — so the query ORs across all three with their prefixes. Searching
   * only docket1 silently misses tens of thousands of real carriers.
   */
  private buildUrl(mcNumber: string): string {
    const where = DOCKET_SLOTS.map(
      (slot) => `(docket${slot}='${mcNumber}' AND docket${slot}prefix='MC')`,
    ).join(" OR ");

    const url = new URL(this.options.datasetUrl ?? DATASET_URL);
    url.searchParams.set("$where", where);
    url.searchParams.set("$limit", "50");
    return url.toString();
  }

  async lookupByMc(rawMcNumber: string): Promise<LookupResult> {
    const mcNumber = parseMcNumber(rawMcNumber);
    if (mcNumber === null) {
      return {
        status: "error",
        mcNumber: String(rawMcNumber),
        message: `"${rawMcNumber}" is not a valid MC number`,
      };
    }

    const doFetch = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await doFetch(this.buildUrl(mcNumber), {
        headers: this.options.appToken ? { "X-App-Token": this.options.appToken } : undefined,
      });
    } catch (cause) {
      return {
        status: "error",
        mcNumber,
        message: `Socrata request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }

    if (!response.ok) {
      // Bad SoQL comes back 400 with {message, errorCode}. This is an outage or
      // a bug on our side — explicitly NOT the same as "carrier not found",
      // which is a 200 with an empty array.
      const body = await response.text().catch(() => "");
      const parsed = socrataErrorSchema.safeParse(safeJsonParse(body));
      const detail = parsed.success ? (parsed.data.message ?? body) : body;
      return {
        status: "error",
        mcNumber,
        message: `Socrata returned ${response.status}: ${detail.slice(0, 300)}`,
      };
    }

    const parsed = socrataResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      return { status: "error", mcNumber, message: "Socrata returned an unrecognised payload" };
    }

    if (parsed.data.length === 0) return { status: "not_found", mcNumber };

    const record = this.normalize(parsed.data, mcNumber);
    if (record === null) return { status: "not_found", mcNumber };

    return { status: "found", record, raw: parsed.data };
  }

  /**
   * Takes the whole row array, not one row — resolution across duplicate MCs is
   * part of normalization, so a cached payload replays through the identical
   * ordering and produces the identical record.
   */
  normalize(raw: unknown, rawMcNumber: string): CarrierRecord | null {
    const mcNumber = parseMcNumber(rawMcNumber);
    if (mcNumber === null) return null;

    const parsed = socrataResponseSchema.safeParse(raw);
    if (!parsed.success) return null;

    const resolved = resolveCandidates(parsed.data, mcNumber);
    if (resolved === null) return null;

    const { winner, others } = resolved;
    const docket = matchingDocket(winner, mcNumber);

    return {
      mcNumber,
      dotNumber: trimOrNull(String(winner.dot_number ?? "")),
      legalName: trimOrNull(winner.legal_name) ?? "Unknown",
      dbaName: trimOrNull(winner.dba_name),
      phone: trimOrNull(winner.phone),

      authorityStatus: toAuthorityStatus(docket?.status ?? null),
      isOutOfService: null, // not in this dataset, at all
      safetyRating: toSafetyRating(trimOrNull(winner.safety_rating)),
      powerUnits: parseIntOrNull(winner.power_units),
      authorizedForHire: toAuthorizedForHire(trimOrNull(winner.classdef)),
      authorityGrantedAt: parseFmcsaDate(winner.add_date),
      priorRevocation: parseYesNo(winner.prior_revoke_flag),

      source: this.id,
      capabilities: this.capabilities,
      ambiguousWith: others,
    };
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
