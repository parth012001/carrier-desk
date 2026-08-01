import { readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import socrataActive from "./__fixtures__/socrata/mc-186800.active.json";
import qcActive from "./__fixtures__/qcmobile/dot-286764.active.derived.json";
import qcBrokerOnly from "./__fixtures__/qcmobile/dot-286764.broker-only.derived.json";
import qcOos from "./__fixtures__/qcmobile/dot-286764.oos.derived.json";
import { evaluateCompliance, evaluateLookup } from "./compliance";
import { QCMobileCarrierSource, redactWebKey } from "./qcmobile";
import { SocrataCarrierSource } from "./socrata";
import { CAPABILITY_FIELDS, type CarrierRecord } from "./types";

const NOW = new Date("2026-08-01T00:00:00.000Z");
const FIXTURE_DIR = path.join(import.meta.dirname, "__fixtures__");

const socrata = new SocrataCarrierSource();
const qcmobile = new QCMobileCarrierSource({ webKey: "test-key" });

describe("fixture provenance", () => {
  it("marks every QCMobile fixture as derived until a WebKey lands", () => {
    // QCMobile 404s without a WebKey, so nothing here can be a real recording
    // yet. The naming convention plus the _derivation key make it impossible
    // to mistake a hand-built payload for observed government data.
    const files = readdirSync(path.join(FIXTURE_DIR, "qcmobile"));

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file).toMatch(/\.derived\.json$/);
    }
  });

  it("gives every derived fixture a provenance record", () => {
    for (const fixture of [qcActive, qcOos, qcBrokerOnly]) {
      expect(fixture._derivation).toBeDefined();
      expect(fixture._derivation.status).toContain("DERIVED");
      expect(fixture._derivation.derivedFrom.length).toBeGreaterThan(10);
      expect(fixture._derivation.replaceWhen.length).toBeGreaterThan(10);
    }
  });

  it("keeps Socrata fixtures free of a provenance key — they are real", () => {
    const files = readdirSync(path.join(FIXTURE_DIR, "socrata"));

    for (const file of files) {
      expect(file).not.toMatch(/\.derived\.json$/);
    }
    for (const row of socrataActive) {
      expect(row).not.toHaveProperty("_derivation");
    }
  });

  it("ignores the provenance key when normalizing", () => {
    expect(qcmobile.normalize(qcActive, "186800")).not.toBeNull();
  });
});

describe("cross-source contract — the same carrier through both sources", () => {
  const fromSocrata = socrata.normalize(socrataActive, "186800");
  const fromQcMobile = qcmobile.normalize(qcActive, "186800");

  it("both sources produce a record", () => {
    expect(fromSocrata).not.toBeNull();
    expect(fromQcMobile).not.toBeNull();
  });

  /** Fields both sources claim they can answer must agree exactly. */
  const SHARED_FIELDS = [
    "mcNumber",
    "dotNumber",
    "legalName",
    "dbaName",
    "phone",
    "authorityStatus",
    "safetyRating",
    "powerUnits",
    "authorizedForHire",
  ] as const satisfies readonly (keyof CarrierRecord)[];

  it.each(SHARED_FIELDS)("agrees on %s", (field) => {
    expect(fromQcMobile?.[field]).toEqual(fromSocrata?.[field]);
  });

  it("reaches the same compliance decision from either source", () => {
    // This is the point of the interface: swapping the source behind it must
    // not silently change who gets booked.
    const viaSocrata = evaluateCompliance(fromSocrata!, { now: NOW });
    const viaQcMobile = evaluateCompliance(fromQcMobile!, { now: NOW });

    expect(viaSocrata.decision).toBe("allow");
    expect(viaQcMobile.decision).toBe("allow");
  });

  it("declares every difference in capabilities rather than leaving it accidental", () => {
    // The headline divergence: Socrata cannot see out-of-service and answers
    // null; QCMobile checked and answered false. That must be explained by a
    // declared capability, not by a normalization bug.
    expect(fromSocrata?.isOutOfService).toBeNull();
    expect(fromSocrata?.capabilities.outOfService).toBe(false);

    expect(fromQcMobile?.isOutOfService).toBe(false);
    expect(fromQcMobile?.capabilities.outOfService).toBe(true);

    // And the same rule mechanically, over every capability there is — so a
    // field added later cannot diverge silently the way authorityGrantedAt did.
    for (const record of [fromSocrata!, fromQcMobile!]) {
      for (const [capability, field] of Object.entries(CAPABILITY_FIELDS)) {
        if (record.capabilities[capability as keyof typeof CAPABILITY_FIELDS] === false) {
          expect(
            record[field],
            `${record.source} declares it cannot answer ${capability}, so ${field} must be null`,
          ).toBeNull();
        }
      }
    }
  });

  it("explains every field the two sources disagree on", () => {
    const differing = (Object.keys(CAPABILITY_FIELDS) as (keyof typeof CAPABILITY_FIELDS)[])
      .filter((capability) => {
        const field = CAPABILITY_FIELDS[capability];
        return JSON.stringify(fromSocrata?.[field]) !== JSON.stringify(fromQcMobile?.[field]);
      })
      .sort();

    // Exactly the two asymmetries the sources declare: Socrata has the
    // authority-grant date and QCMobile does not; QCMobile has out-of-service
    // and Socrata does not. Anything else appearing here is a real bug.
    expect(differing).toEqual(["authorityGrantedAt", "outOfService"]);

    for (const capability of differing) {
      expect(fromSocrata!.capabilities[capability]).not.toBe(
        fromQcMobile!.capabilities[capability],
      );
    }
  });

  it("counts MC ambiguity the same way through either source", () => {
    // Regression, and the sharpest example of why this file exists: QCMobile
    // hardcoded ambiguousCount: 0 while its docket lookup silently kept only the
    // first entity. The same multi-entity MC came back `flag [AMBIGUOUS_MC]`
    // through Socrata and `allow []` through QCMobile — a wrong-allow produced
    // purely by which source sat behind the interface.
    const threeEntities = [
      { docket1prefix: "MC", docket1: "1", docket1_status_code: "A", status_code: "A", legal_name: "ONE", dot_number: "1", classdef: "AUTHORIZED FOR HIRE" },
      { docket1prefix: "MC", docket1: "1", docket1_status_code: "I", status_code: "A", legal_name: "TWO", dot_number: "2" },
      { docket1prefix: "MC", docket1: "1", docket1_status_code: "I", status_code: "A", legal_name: "THREE", dot_number: "3" },
    ];
    const viaSocrata = socrata.normalize(threeEntities, "1")!;

    const viaQcMobile = qcmobile.normalize(
      {
        carrier: { dotNumber: 1, legalName: "ONE", safetyRating: "S", totalPowerUnits: 5, outOfService: "N" },
        authority: [{ commonAuthorityStatus: "A" }],
        ambiguousCount: 2,
      },
      "1",
    )!;

    expect(viaSocrata.ambiguousCount).toBe(2);
    expect(viaQcMobile.ambiguousCount).toBe(2);
    expect(evaluateCompliance(viaQcMobile, { now: NOW }).decision).toBe(
      evaluateCompliance(viaSocrata, { now: NOW }).decision,
    );
    expect(evaluateCompliance(viaQcMobile, { now: NOW }).reasons.map((r) => r.code)).toContain(
      "AMBIGUOUS_MC",
    );
  });

  it("carries the ambiguity count through a QCMobile docket list", async () => {
    // The count has to come from the list the source actually received, and
    // survive onto the cached envelope.
    const source = new QCMobileCarrierSource({
      webKey: "secret",
      fetchImpl: async (input) =>
        Response.json({
          content: String(input).includes("/authority")
            ? [{ commonAuthorityStatus: "A" }]
            : [
                { carrier: { dotNumber: 1, legalName: "ONE" } },
                { carrier: { dotNumber: 2, legalName: "TWO" } },
                { carrier: { dotNumber: 3, legalName: "THREE" } },
              ],
        }),
    });

    const result = await source.lookupByMc("1");

    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(result.record.ambiguousCount).toBe(2);
    // And the same after a cache replay off the stored envelope.
    expect(source.normalize(result.raw, "1")?.ambiguousCount).toBe(2);
  });

  it("changes only the OOS caveat between the two, not the outcome", () => {
    const socrataCodes = evaluateCompliance(fromSocrata!, { now: NOW }).reasons.map((r) => r.code);
    const qcCodes = evaluateCompliance(fromQcMobile!, { now: NOW }).reasons.map((r) => r.code);

    expect(socrataCodes).toEqual(["OOS_NOT_VERIFIED"]);
    expect(qcCodes).toEqual([]);
  });
});

describe("QCMobile answers what Socrata cannot", () => {
  it("blocks a carrier under an out-of-service order", () => {
    const record = qcmobile.normalize(qcOos, "186800");

    expect(record?.isOutOfService).toBe(true);
    const result = evaluateCompliance(record!, { now: NOW });
    expect(result.decision).toBe("block");
    expect(result.reasons.map((r) => r.code)).toContain("OUT_OF_SERVICE");
  });

  it("blocks an entity holding only broker authority", () => {
    // Tendering a load to a broker-only entity is double-brokering. Socrata's
    // classdef says AUTHORIZED FOR HIRE for brokers and carriers alike, so this
    // check is only possible with QCMobile's per-type authority split.
    const record = qcmobile.normalize(qcBrokerOnly, "186800");

    expect(record?.authorizedForHire).toBe(false);
    const result = evaluateCompliance(record!, { now: NOW });
    expect(result.decision).toBe("block");
    expect(result.reasons.map((r) => r.code)).toContain("NOT_AUTHORIZED_FOR_HIRE");
  });

  it("derives out-of-service from allowedToOperate when the flag is absent", () => {
    const { outOfService: _dropped, ...carrier } = qcOos.carrier;
    const record = qcmobile.normalize({ carrier, authority: qcOos.authority }, "186800");

    expect(carrier.allowedToOperate).toBe("N");
    expect(record?.isOutOfService).toBe(true);
  });

  it("reports null out-of-service when neither signal is present", () => {
    const record = qcmobile.normalize(
      { carrier: { dotNumber: 286764, legalName: "X" }, authority: [] },
      "186800",
    );

    expect(record?.isOutOfService).toBeNull();
  });
});

describe("QCMobileCarrierSource construction and transport", () => {
  it("refuses to construct without a WebKey", () => {
    // A half-configured source that 404s on the first carrier call mid-demo is
    // worse than one that never starts.
    expect(() => new QCMobileCarrierSource({ webKey: "" })).toThrow(/WebKey/);
  });

  it("appends the webKey to every request", async () => {
    const urls: string[] = [];
    const source = new QCMobileCarrierSource({
      webKey: "secret",
      fetchImpl: async (input) => {
        urls.push(String(input));
        const isAuthority = String(input).includes("/authority");
        return Response.json({
          content: isAuthority ? qcActive.authority : [{ carrier: qcActive.carrier }],
        });
      },
    });

    const result = await source.lookupByMc("MC-186800");

    expect(result.status).toBe("found");
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("/carriers/docket-number/186800");
    expect(urls[1]).toContain("/carriers/286764/authority");
    for (const url of urls) {
      expect(new URL(url).searchParams.get("webKey")).toBe("secret");
    }
  });

  it("treats a webkey rejection as an error, not a missing carrier", async () => {
    // QCMobile answers auth failures with 404 and a string body, which would
    // otherwise read as "no such carrier" and block a legitimate caller.
    const source = new QCMobileCarrierSource({
      webKey: "bogus",
      fetchImpl: async () =>
        Response.json({ content: "Webkey not found" }, { status: 404 }),
    });

    const result = await source.lookupByMc("186800");

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.message).toContain("Webkey not found");
  });

  it("never lets the WebKey escape into an error message", async () => {
    // Regression: transport errors quote the request URL, and the URL carries the
    // key. That message reaches a ComplianceReason, which the agent reads aloud
    // and which is persisted to run_events.
    const source = new QCMobileCarrierSource({
      webKey: "SUPERSECRET-WEBKEY-abc123",
      fetchImpl: async (input) => {
        throw new Error(`connect ECONNREFUSED ${String(input)}`);
      },
    });

    const result = await source.lookupByMc("186800");

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.message).not.toContain("SUPERSECRET-WEBKEY-abc123");
    expect(result.message).toContain("webKey=REDACTED");

    // And the same string, once it reaches the gate.
    const spoken = evaluateLookup(result, { now: NOW }).reasons[0].message;
    expect(spoken).not.toContain("SUPERSECRET-WEBKEY-abc123");
  });

  it("walks the cause chain and still redacts — the shape Node's fetch throws", async () => {
    // Node rejects with a bare "fetch failed" and hides the real reason in
    // `cause`, where the URL (and therefore the key) also lives. Reading only
    // .message meant the redactor had nothing to redact AND the operator lost
    // the diagnostic.
    const source = new QCMobileCarrierSource({
      webKey: "SUPERSECRET-abc123",
      fetchImpl: async (input) => {
        throw new Error("fetch failed", {
          cause: new Error(`connect ECONNREFUSED ${String(input)}`),
        });
      },
    });

    const result = await source.lookupByMc("186800");

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.message).not.toContain("SUPERSECRET-abc123");
    expect(result.message).toContain("ECONNREFUSED");
  });

  it("redacts the key wherever it appears in a message", () => {
    expect(redactWebKey("GET https://x/y?webKey=abc123 failed")).toBe(
      "GET https://x/y?webKey=REDACTED failed",
    );
    expect(redactWebKey("https://x/y?a=1&webKey=abc123&b=2")).toBe(
      "https://x/y?a=1&webKey=REDACTED&b=2",
    );
    expect(redactWebKey("nothing sensitive here")).toBe("nothing sensitive here");
  });

  it("returns not_found for an empty docket response", async () => {
    const source = new QCMobileCarrierSource({
      webKey: "secret",
      fetchImpl: async () => Response.json({ content: [] }),
    });

    expect(await source.lookupByMc("9999999")).toEqual({
      status: "not_found",
      mcNumber: "9999999",
    });
  });
});
