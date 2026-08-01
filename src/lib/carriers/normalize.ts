/**
 * Shared parsing primitives for turning provider payloads into a CarrierRecord.
 *
 * FMCSA data is uniformly stringly-typed — every numeric-looking column in the
 * Socrata census file is declared `text`, and empty fields are omitted from the
 * response entirely rather than sent as null. Everything here returns `null`
 * rather than throwing or coercing, so a malformed field degrades one value
 * instead of failing a whole lookup.
 */

/**
 * Canonical MC number: digits only, no prefix, no leading zeros.
 *
 * Callers hand us whatever the carrier said on the phone — "MC-123456",
 * "mc 123456", "00123456". Socrata stores dockets unpadded ("189877",
 * "1425217"), so leading zeros must go or the lookup silently misses.
 *
 * Returns null for anything that isn't a plausible docket number.
 */
export function parseMcNumber(input: unknown): string | null {
  if (typeof input === "number") {
    return Number.isSafeInteger(input) && input > 0 ? String(input) : null;
  }
  if (typeof input !== "string") return null;

  const withoutPrefix = input.trim().replace(/^mc[-\s]*/i, "");
  if (!/^\d+$/.test(withoutPrefix)) return null;

  const withoutLeadingZeros = withoutPrefix.replace(/^0+/, "");
  return withoutLeadingZeros.length > 0 ? withoutLeadingZeros : null;
}

/** Text-typed integer column -> number. `"0"` is a real value, not a miss. */
export function parseIntOrNull(input: unknown): number | null {
  if (typeof input === "number") return Number.isFinite(input) ? Math.trunc(input) : null;
  if (typeof input !== "string") return null;

  const trimmed = input.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;

  const parsed = Number.parseInt(trimmed, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * FMCSA dates arrive as `YYYYMMDD` (add_date) or `YYYYMMDD HHMM` (mcs150_date).
 * Parsed as UTC so the result does not shift with the machine's timezone —
 * and this machine's clock is known to run slow, so nothing here may depend on
 * the local clock. See docs/STATE.md.
 */
export function parseFmcsaDate(input: unknown): Date | null {
  if (typeof input !== "string") return null;

  const match = /^(\d{4})(\d{2})(\d{2})(?:\s+(\d{2})(\d{2}))?$/.exec(input.trim());
  if (!match) return null;

  const [, y, m, d, hh, mm] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  const hour = hh ? Number(hh) : 0;
  const minute = mm ? Number(mm) : 0;

  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59) return null;

  const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
  // Rejects real-looking-but-impossible dates like 20250231, which Date rolls over.
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;

  return date;
}

/** Trim a text field, collapsing blanks and whitespace-only values to null. */
export function trimOrNull(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** FMCSA Y/N flags. Anything unrecognised is `null`, never a silent `false`. */
export function parseYesNo(input: unknown): boolean | null {
  const value = trimOrNull(input)?.toUpperCase();
  if (value === "Y" || value === "YES") return true;
  if (value === "N" || value === "NO") return false;
  return null;
}
