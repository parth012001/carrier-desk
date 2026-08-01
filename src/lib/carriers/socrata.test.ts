import { describe, expect, it } from "vitest";

import activeFixture from "./__fixtures__/socrata/mc-186800.active.json";
import ambiguousFixture from "./__fixtures__/socrata/mc-143229.ambiguous.json";
import authorityInactiveFixture from "./__fixtures__/socrata/mc-1175378.authority-inactive.json";
import docket2Fixture from "./__fixtures__/socrata/mc-170995.docket2.json";
import noPowerUnitsFixture from "./__fixtures__/socrata/mc-260679.no-power-units.json";
import notFoundFixture from "./__fixtures__/socrata/mc-9999999.not-found.json";
import unsatisfactoryFixture from "./__fixtures__/socrata/mc-895642.unsatisfactory.json";
import { SocrataCarrierSource, resolveCandidates, type SocrataRow } from "./socrata";

/**
 * Every fixture here is a real recorded Socrata response — see
 * scripts/record-fixture.ts. No test in this file touches the network.
 */

function sourceReturning(
  body: unknown,
  init: { status?: number; text?: string } = {},
): SocrataCarrierSource {
  const status = init.status ?? 200;
  return new SocrataCarrierSource({
    fetchImpl: async () =>
      new Response(init.text ?? JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  });
}

describe("SocrataCarrierSource.normalize — real recorded payloads", () => {
  const source = new SocrataCarrierSource();

  it("normalizes an active, satisfactory carrier", () => {
    const record = source.normalize(activeFixture, "186800");

    expect(record).toEqual({
      mcNumber: "186800",
      dotNumber: "286764",
      legalName: "GENERAL TRANSPORT INC",
      dbaName: null,
      phone: "8006276055",
      authorityStatus: "active",
      isOutOfService: null,
      safetyRating: "satisfactory",
      powerUnits: 85,
      authorizedForHire: true,
      authorityGrantedAt: new Date("1987-02-04T00:00:00.000Z"),
      priorRevocation: null,
      source: "socrata",
      capabilities: {
        authorityStatus: true,
        outOfService: false,
        safetyRating: true,
        powerUnits: true,
        priorRevocation: true,
        authorityGrantedAt: true,
      },
      ambiguousWith: [],
    });
  });

  it("reads authority from the docket, not the entity status", () => {
    // LB 168 INC: entity Active, docket Inactive, prior revocation on file.
    // The entity status alone would say this carrier is fine. It is not.
    const record = source.normalize(authorityInactiveFixture, "1175378");

    expect(authorityInactiveFixture[0].status_code).toBe("A");
    expect(record).toMatchObject({
      legalName: "LB 168 INC",
      authorityStatus: "inactive",
      priorRevocation: true,
      powerUnits: 55,
    });
  });

  it("normalizes an unsatisfactory safety rating on active authority", () => {
    expect(source.normalize(unsatisfactoryFixture, "895642")).toMatchObject({
      legalName: "WORLDWIDE TRANSPORT SOLUTIONS LLC",
      authorityStatus: "active",
      safetyRating: "unsatisfactory",
    });
  });

  it("keeps zero power units as 0, not null", () => {
    // Authority but no trucks is a double-brokering shape. Collapsing 0 to
    // null would erase the signal.
    expect(source.normalize(noPowerUnitsFixture, "260679")).toMatchObject({
      legalName: "MULDER INC",
      powerUnits: 0,
    });
  });

  it("finds an MC held in the docket2 slot", () => {
    // COLONIAL CARTAGE holds FF-12647 in slot 1 and MC-170995 in slot 2.
    // Reading only docket1 would report this active carrier as not found and
    // block it — 79k rows carry a docket2.
    expect(docket2Fixture[0].docket1prefix).toBe("FF");
    expect(source.normalize(docket2Fixture, "170995")).toMatchObject({
      legalName: "COLONIAL CARTAGE CORPORATION",
      authorityStatus: "active",
      safetyRating: "satisfactory",
      powerUnits: 61,
    });
  });

  it("reports null authority when no docket slot matches the MC", () => {
    expect(source.normalize(activeFixture, "999999")).toMatchObject({
      authorityStatus: "none",
    });
  });

  it("returns null for an unrecognised payload", () => {
    expect(source.normalize({ nope: true }, "186800")).toBeNull();
    expect(source.normalize([], "186800")).toBeNull();
    expect(source.normalize(activeFixture, "not-an-mc")).toBeNull();
  });

  it("never reports out-of-service — the census file has no such column", () => {
    const cases: [unknown, string][] = [
      [activeFixture, "186800"],
      [authorityInactiveFixture, "1175378"],
      [unsatisfactoryFixture, "895642"],
      [noPowerUnitsFixture, "260679"],
      [docket2Fixture, "170995"],
      [ambiguousFixture, "143229"],
    ];
    for (const [fixture, mc] of cases) {
      expect(source.normalize(fixture, mc)?.isOutOfService).toBeNull();
    }
    expect(source.capabilities.outOfService).toBe(false);
  });
});

describe("resolveCandidates — MC numbers are not unique", () => {
  const rows = ambiguousFixture as SocrataRow[];

  it("picks the one entity with active authority out of six", () => {
    expect(rows).toHaveLength(6);

    const resolved = resolveCandidates(rows, "143229");
    expect(resolved?.winner.dot_number).toBe("208293");
    expect(resolved?.winner.legal_name).toBe("AMERICAN SHIPPERS COMPANY INC");
    expect(resolved?.others).toHaveLength(5);
    expect(resolved?.others).not.toContain("208293");
  });

  it("is independent of input order", () => {
    // A sort that depends on the order rows happen to arrive in is a
    // nondeterministic booking decision. Every rotation must agree.
    const expected = resolveCandidates(rows, "143229");

    for (let offset = 1; offset < rows.length; offset++) {
      const rotated = [...rows.slice(offset), ...rows.slice(0, offset)];
      const resolved = resolveCandidates(rotated, "143229");
      expect(resolved?.winner.dot_number).toBe(expected?.winner.dot_number);
      expect([...(resolved?.others ?? [])].sort()).toEqual([...(expected?.others ?? [])].sort());
    }

    const reversed = resolveCandidates([...rows].reverse(), "143229");
    expect(reversed?.winner.dot_number).toBe(expected?.winner.dot_number);
  });

  it("surfaces the losing DOT numbers as ambiguity", () => {
    const record = new SocrataCarrierSource().normalize(ambiguousFixture, "143229");

    expect(record?.dotNumber).toBe("208293");
    expect(record?.ambiguousWith).toHaveLength(5);
    expect(record?.ambiguousWith).toEqual(
      expect.arrayContaining(["329380", "381799", "381802", "381805", "146793"]),
    );
  });

  it("falls back through the tiebreak chain when authority status ties", () => {
    const tied: SocrataRow[] = [
      { dot_number: "300", docket1prefix: "MC", docket1: "1", docket1_status_code: "A", status_code: "A" },
      { dot_number: "100", docket1prefix: "MC", docket1: "1", docket1_status_code: "A", status_code: "A" },
      { dot_number: "200", docket1prefix: "MC", docket1: "1", docket1_status_code: "A", status_code: "A" },
    ];
    // Identical on every signal, so the lowest DOT breaks it — total ordering.
    expect(resolveCandidates(tied, "1")?.winner.dot_number).toBe("100");

    const freshest: SocrataRow[] = [
      { ...tied[0], mcs150_date: "20200101 0000" },
      { ...tied[1], mcs150_date: "20240101 0000" },
    ];
    // Freshest MCS-150 outranks the DOT tiebreak.
    expect(resolveCandidates(freshest, "1")?.winner.dot_number).toBe("100");
    expect(
      resolveCandidates([{ ...tied[0], mcs150_date: "20240101 0000" }, tied[1]], "1")?.winner
        .dot_number,
    ).toBe("300");
  });

  it("returns null for an empty candidate list", () => {
    expect(resolveCandidates([], "143229")).toBeNull();
  });
});

describe("SocrataCarrierSource.lookupByMc — outcome kinds", () => {
  it("returns found for a real carrier", async () => {
    const result = await sourceReturning(activeFixture).lookupByMc("MC-186800");

    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(result.record.legalName).toBe("GENERAL TRANSPORT INC");
    expect(result.raw).toEqual(activeFixture);
  });

  it("returns not_found for an empty array — Socrata answers 200 with []", async () => {
    expect(notFoundFixture).toEqual([]);

    const result = await sourceReturning(notFoundFixture).lookupByMc("9999999");
    expect(result).toEqual({ status: "not_found", mcNumber: "9999999" });
  });

  it("returns error, not not_found, on an HTTP failure", async () => {
    // A 400 means our query is wrong or the service is degraded. Reporting it
    // as "no such carrier" would turn an outage into a fraud finding.
    const result = await sourceReturning(null, {
      status: 400,
      text: JSON.stringify({ message: "No such column: nope", errorCode: "query.soql.no-such-column" }),
    }).lookupByMc("186800");

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.message).toContain("400");
    expect(result.message).toContain("No such column");
  });

  it("returns error when the network throws", async () => {
    const source = new SocrataCarrierSource({
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });

    const result = await source.lookupByMc("186800");
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.message).toContain("ECONNREFUSED");
  });

  it("returns error for a malformed MC without making a request", async () => {
    let called = false;
    const source = new SocrataCarrierSource({
      fetchImpl: async () => {
        called = true;
        return new Response("[]");
      },
    });

    const result = await source.lookupByMc("not-an-mc");
    expect(result.status).toBe("error");
    expect(called).toBe(false);
  });

  it("strips prefixes and leading zeros before querying", async () => {
    let requested = "";
    const source = new SocrataCarrierSource({
      fetchImpl: async (input) => {
        requested = String(input);
        return new Response(JSON.stringify(activeFixture));
      },
    });

    await source.lookupByMc("  MC-00186800 ");

    const where = new URL(requested).searchParams.get("$where") ?? "";
    expect(where).toContain("docket1='186800'");
    expect(where).not.toContain("00186800");
  });

  it("queries all three docket slots", async () => {
    let requested = "";
    const source = new SocrataCarrierSource({
      fetchImpl: async (input) => {
        requested = String(input);
        return new Response(JSON.stringify(docket2Fixture));
      },
    });

    await source.lookupByMc("170995");

    const where = new URL(requested).searchParams.get("$where") ?? "";
    for (const slot of [1, 2, 3]) {
      expect(where).toContain(`docket${slot}='170995'`);
      expect(where).toContain(`docket${slot}prefix='MC'`);
    }
  });

  it("sends the app token only when one is configured", async () => {
    const headersSeen: (HeadersInit | undefined)[] = [];
    const capture: typeof fetch = async (_input, init) => {
      headersSeen.push(init?.headers);
      return new Response(JSON.stringify(activeFixture));
    };

    await new SocrataCarrierSource({ fetchImpl: capture }).lookupByMc("186800");
    await new SocrataCarrierSource({ fetchImpl: capture, appToken: "tok" }).lookupByMc("186800");

    expect(headersSeen[0]).toBeUndefined();
    expect(headersSeen[1]).toEqual({ "X-App-Token": "tok" });
  });
});
