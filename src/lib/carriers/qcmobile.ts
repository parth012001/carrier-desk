import { z } from "zod";

import { parseIntOrNull, parseMcNumber, parseYesNo, trimOrNull } from "./normalize";
import type {
  AuthorityStatus,
  CarrierDataSource,
  CarrierRecord,
  LookupResult,
  SafetyRating,
  SourceCapabilities,
} from "./types";

/**
 * FMCSA QCMobile API — https://mobile.fmcsa.dot.gov/qc/services/
 *
 * The richer of the two sources: it carries out-of-service status and
 * per-type authority, neither of which exists in the Socrata census file.
 * It requires a WebKey (Login.gov), and hard-fails without one — an unkeyed
 * request 404s with {"content":"Must provide Webkey"}, and a wrong key 404s
 * with {"content":"Webkey not found"}. So the constructor throws rather than
 * letting a half-configured source silently degrade during a demo.
 *
 * Until the WebKey lands this class is exercised entirely through fixtures.
 * Its normalize() is the real thing and is contract-tested against Socrata;
 * only the network path is dark.
 */

const BASE_URL = "https://mobile.fmcsa.dot.gov/qc/services";

export const QCMOBILE_CAPABILITIES: SourceCapabilities = {
  authorityStatus: true,
  outOfService: true, // the reason this source exists
  safetyRating: true,
  powerUnits: true,
  priorRevocation: false, // no prior-revocation flag in the QCMobile payload
  authorityGrantedAt: false, // no authority-grant date either — Socrata has it
};

/**
 * QCMobile omits any element that has no value, so nearly everything is
 * optional. Loose so a new government field cannot fail a live lookup.
 */
const carrierSchema = z.looseObject({
  dotNumber: z.union([z.string(), z.number()]).optional(),
  legalName: z.string().optional(),
  dbaName: z.string().nullish(),
  telephone: z.string().nullish(),
  statusCode: z.string().nullish(),
  safetyRating: z.string().nullish(),
  totalPowerUnits: z.union([z.string(), z.number()]).nullish(),
  outOfService: z.string().nullish(),
  outOfServiceDate: z.string().nullish(),
  /**
   * The published element table calls this `allowToOperate`; live responses are
   * widely reported as `allowedToOperate`. Without a WebKey I cannot confirm
   * which one this deployment sends, so both are accepted and whichever is
   * present wins. Collapse to one name once a real payload is recorded.
   */
  allowToOperate: z.string().nullish(),
  allowedToOperate: z.string().nullish(),
});

const authoritySchema = z.looseObject({
  commonAuthorityStatus: z.string().nullish(),
  contractAuthorityStatus: z.string().nullish(),
  brokerAuthorityStatus: z.string().nullish(),
});

/**
 * The envelope we cache and normalize from: one carrier record plus its
 * authority rows, since QCMobile splits them across two endpoints.
 */
const envelopeSchema = z.object({
  carrier: carrierSchema,
  authority: z.array(authoritySchema).default([]),
});

export type QCMobileEnvelope = z.output<typeof envelopeSchema>;

/** QCMobile wraps every response as {content, retrievalDate, _links}. */
const contentSchema = z.looseObject({ content: z.unknown() });

function toSafetyRating(raw: string | null): SafetyRating | null {
  const value = raw?.trim().toUpperCase();
  if (value === "S" || value === "SATISFACTORY") return "satisfactory";
  if (value === "C" || value === "CONDITIONAL") return "conditional";
  if (value === "U" || value === "UNSATISFACTORY") return "unsatisfactory";
  return null;
}

function toAuthorityCode(raw: string | null | undefined): string | null {
  return trimOrNull(raw)?.toUpperCase() ?? null;
}

/**
 * A carrier hauling freight needs common or contract authority. Broker
 * authority alone means the entity is a broker, and tendering a load to it is
 * by definition double-brokering — so that case reports authorizedForHire
 * false and the gate blocks it. This distinction does not exist in the Socrata
 * census file at all.
 */
function resolveAuthority(rows: QCMobileEnvelope["authority"]): {
  status: AuthorityStatus;
  authorizedForHire: boolean | null;
} {
  if (rows.length === 0) return { status: "unknown", authorizedForHire: null };

  const codes = rows.flatMap((row) => [
    toAuthorityCode(row.commonAuthorityStatus),
    toAuthorityCode(row.contractAuthorityStatus),
  ]);
  const brokerCodes = rows.map((row) => toAuthorityCode(row.brokerAuthorityStatus));

  const carrierAuthority = codes.filter((c): c is string => c !== null);
  if (carrierAuthority.includes("A")) return { status: "active", authorizedForHire: true };

  const hasBrokerAuthority = brokerCodes.includes("A");
  if (hasBrokerAuthority) {
    // Active as an entity, but only as a broker.
    return { status: "active", authorizedForHire: false };
  }

  if (carrierAuthority.includes("P")) return { status: "pending", authorizedForHire: null };
  if (carrierAuthority.includes("I") || carrierAuthority.includes("N")) {
    return { status: "inactive", authorizedForHire: null };
  }
  if (carrierAuthority.length === 0) return { status: "none", authorizedForHire: null };

  return { status: "unknown", authorizedForHire: null };
}

export class QCMobileCarrierSource implements CarrierDataSource {
  readonly id = "qcmobile" as const;
  readonly capabilities = QCMOBILE_CAPABILITIES;

  private readonly webKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(options: { webKey?: string; fetchImpl?: typeof fetch; baseUrl?: string } = {}) {
    const webKey = options.webKey ?? process.env.FMCSA_WEB_KEY;
    if (!webKey) {
      // Better to fail at construction than to look configured and 404 on the
      // first carrier call during a live demo.
      throw new Error(
        "QCMobileCarrierSource requires a WebKey. Set FMCSA_WEB_KEY or pass { webKey }. " +
          "Use SocrataCarrierSource for keyless lookups.",
      );
    }
    this.webKey = webKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? BASE_URL;
  }

  private url(path: string): string {
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set("webKey", this.webKey);
    return url.toString();
  }

  private async getContent(path: string): Promise<{ ok: true; content: unknown } | { ok: false; message: string }> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path));
    } catch (cause) {
      return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
    }

    const parsed = contentSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      return { ok: false, message: `QCMobile returned an unrecognised payload for ${path}` };
    }

    // QCMobile answers auth failures with 404 and a string content, not a 401.
    if (typeof parsed.data.content === "string") {
      return { ok: false, message: `QCMobile: ${parsed.data.content}` };
    }
    if (!response.ok) {
      return { ok: false, message: `QCMobile returned ${response.status} for ${path}` };
    }

    return { ok: true, content: parsed.data.content };
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

    const byDocket = await this.getContent(`/carriers/docket-number/${mcNumber}`);
    if (!byDocket.ok) return { status: "error", mcNumber, message: byDocket.message };

    const carrier = firstCarrier(byDocket.content);
    if (carrier === null) return { status: "not_found", mcNumber };

    const dotNumber = trimOrNull(String(carrier.dotNumber ?? ""));
    let authority: unknown[] = [];
    if (dotNumber !== null) {
      const result = await this.getContent(`/carriers/${dotNumber}/authority`);
      if (!result.ok) return { status: "error", mcNumber, message: result.message };
      authority = Array.isArray(result.content) ? result.content : [];
    }

    const raw = { carrier, authority };
    const record = this.normalize(raw, mcNumber);
    if (record === null) return { status: "not_found", mcNumber };

    return { status: "found", record, raw };
  }

  normalize(raw: unknown, rawMcNumber: string): CarrierRecord | null {
    const mcNumber = parseMcNumber(rawMcNumber);
    if (mcNumber === null) return null;

    const parsed = envelopeSchema.safeParse(stripDerivationNote(raw));
    if (!parsed.success) return null;

    const { carrier, authority } = parsed.data;
    const { status, authorizedForHire } = resolveAuthority(authority);

    // Two independent signals for out-of-service. allowToOperate === "N" is
    // authoritative even when the outOfService element is absent — the docs
    // note the two are mutually exclusive and only populated elements appear.
    const explicitOos = parseYesNo(carrier.outOfService);
    const allowedToOperate = parseYesNo(carrier.allowToOperate ?? carrier.allowedToOperate);
    const isOutOfService =
      explicitOos ?? (allowedToOperate === null ? null : !allowedToOperate);

    return {
      mcNumber,
      dotNumber: trimOrNull(String(carrier.dotNumber ?? "")),
      legalName: trimOrNull(carrier.legalName) ?? "Unknown",
      dbaName: trimOrNull(carrier.dbaName),
      phone: trimOrNull(carrier.telephone),

      authorityStatus: status,
      isOutOfService,
      safetyRating: toSafetyRating(trimOrNull(carrier.safetyRating)),
      powerUnits: parseIntOrNull(carrier.totalPowerUnits),
      authorizedForHire,
      // QCMobile carries no authority-grant date and no prior-revocation flag.
      authorityGrantedAt: null,
      priorRevocation: null,

      source: this.id,
      capabilities: this.capabilities,
      ambiguousWith: [],
    };
  }
}

/** Docket lookups return a list; DOT lookups return one object. Accept both. */
function firstCarrier(content: unknown): z.output<typeof carrierSchema> | null {
  const items = Array.isArray(content) ? content : [content];

  for (const item of items) {
    const wrapped = z.looseObject({ carrier: z.unknown() }).safeParse(item);
    const candidate = wrapped.success && wrapped.data.carrier ? wrapped.data.carrier : item;
    const parsed = carrierSchema.safeParse(candidate);
    if (parsed.success && (parsed.data.dotNumber !== undefined || parsed.data.legalName)) {
      return parsed.data;
    }
  }

  return null;
}

/** Fixtures carry a `_derivation` provenance key. It is not part of the payload. */
function stripDerivationNote(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const { _derivation: _ignored, ...rest } = raw as Record<string, unknown>;
  return rest;
}
