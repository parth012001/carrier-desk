/**
 * Formatting for the broker's screen. Client-safe — no server imports.
 *
 * Money is integer cents everywhere in this system and only ever becomes a
 * decimal here, at the last possible moment before a person reads it.
 */

export const usd = (cents: number): string =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

/** Whole dollars, for the ladder where the cents are noise against the gap. */
export const usdWhole = (cents: number): string =>
  (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

export const EQUIPMENT_LABEL: Record<string, string> = {
  dry_van: "Dry van",
  reefer: "Reefer",
  flatbed: "Flatbed",
};

/**
 * A duration as a broker would say it. A tool that took 8ms and one that took
 * 400ms are different kinds of event — one is a cache, one is a government
 * API — so the unit changes rather than the number growing a decimal.
 */
export const latency = (ms: number | null): string => {
  if (ms === null) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
};

export const pickupWindow = (startIso: string, endIso: string): string => {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const day = start.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const from = start.toLocaleTimeString("en-US", { hour: "numeric" });
  const to = end.toLocaleTimeString("en-US", { hour: "numeric" });
  return `${day} · ${from}–${to}`;
};

/** Reason codes are SCREAMING_SNAKE in the data and read better spaced out. */
export const humanCode = (code: string): string => code.replace(/_/g, " ").toLowerCase();
