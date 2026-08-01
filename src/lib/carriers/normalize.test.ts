import { describe, expect, it } from "vitest";

import {
  parseFmcsaDate,
  parseIntOrNull,
  parseMcNumber,
  parseYesNo,
  trimOrNull,
} from "./normalize";

describe("parseMcNumber", () => {
  it.each([
    ["186800", "186800"],
    ["MC-186800", "186800"],
    ["MC186800", "186800"],
    ["mc 186800", "186800"],
    ["  MC-186800  ", "186800"],
    // Socrata stores dockets unpadded; a padded input must still hit.
    ["00186800", "186800"],
    ["0000186800", "186800"],
    ["1175378", "1175378"],
  ])("normalizes %o to %o", (input, expected) => {
    expect(parseMcNumber(input)).toBe(expected);
  });

  it.each([
    ["", "empty"],
    ["   ", "whitespace"],
    ["MC-", "prefix with no digits"],
    ["ABC123", "letters"],
    ["12 34", "internal space"],
    ["123-456", "internal dash"],
    ["-186800", "negative"],
    ["186800.0", "decimal"],
    ["0", "zero"],
    ["000", "all zeros"],
    [null, "null"],
    [undefined, "undefined"],
    [{}, "object"],
  ])("rejects %o (%s)", (input, _reason) => {
    expect(parseMcNumber(input)).toBeNull();
  });

  it("accepts a numeric MC", () => {
    expect(parseMcNumber(186800)).toBe("186800");
    expect(parseMcNumber(0)).toBeNull();
    expect(parseMcNumber(-1)).toBeNull();
    expect(parseMcNumber(1.5)).toBeNull();
  });
});

describe("parseIntOrNull", () => {
  it.each([
    ["85", 85],
    [" 24 ", 24],
    // 0 power units is a real, meaningful value: authority but no trucks.
    ["0", 0],
    ["1175378", 1175378],
    [55, 55],
  ])("parses %o to %o", (input, expected) => {
    expect(parseIntOrNull(input)).toBe(expected);
  });

  it.each([[""], ["   "], ["abc"], ["8.5"], ["8a"], [null], [undefined], [{}], [Number.NaN]])(
    "returns null for %o",
    (input) => {
      expect(parseIntOrNull(input)).toBeNull();
    },
  );
});

describe("parseFmcsaDate", () => {
  it("parses add_date (YYYYMMDD) as UTC", () => {
    expect(parseFmcsaDate("19870204")?.toISOString()).toBe("1987-02-04T00:00:00.000Z");
  });

  it("parses mcs150_date (YYYYMMDD HHMM) as UTC", () => {
    expect(parseFmcsaDate("20260123 2120")?.toISOString()).toBe("2026-01-23T21:20:00.000Z");
  });

  it("parses the midnight variant seen on older rows", () => {
    expect(parseFmcsaDate("20120719 0000")?.toISOString()).toBe("2012-07-19T00:00:00.000Z");
  });

  it("rejects impossible dates rather than rolling them over", () => {
    // new Date(Date.UTC(2025, 1, 31)) silently becomes March 3rd.
    expect(parseFmcsaDate("20250231")).toBeNull();
    expect(parseFmcsaDate("20251301")).toBeNull();
    expect(parseFmcsaDate("20250100")).toBeNull();
  });

  it.each([[""], ["   "], ["1987-02-04"], ["870204"], ["20260123 2560"], ["20260123 2461"], [null], [42]])(
    "returns null for %o",
    (input) => {
      expect(parseFmcsaDate(input)).toBeNull();
    },
  );
});

describe("trimOrNull", () => {
  it.each([
    ["GENERAL TRANSPORT INC", "GENERAL TRANSPORT INC"],
    ["  ARMOUR TRANSPORTATION SYSTEMS  ", "ARMOUR TRANSPORTATION SYSTEMS"],
  ])("trims %o", (input, expected) => {
    expect(trimOrNull(input)).toBe(expected);
  });

  it.each([[""], ["   "], [null], [undefined], [0]])("returns null for %o", (input) => {
    expect(trimOrNull(input)).toBeNull();
  });
});

describe("parseYesNo", () => {
  it.each([
    ["Y", true],
    ["y", true],
    ["Yes", true],
    ["N", false],
    ["n", false],
    ["No", false],
  ])("parses %o to %o", (input, expected) => {
    expect(parseYesNo(input)).toBe(expected);
  });

  it.each([
    // Cargo columns use "X" as a set-flag; it is not a yes/no and must not
    // be read as one.
    ["X"],
    ["U"],
    [""],
    ["   "],
    [null],
    [undefined],
    [true],
  ])("returns null for %o rather than defaulting to false", (input) => {
    expect(parseYesNo(input)).toBeNull();
  });
});
