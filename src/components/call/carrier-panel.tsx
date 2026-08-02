import { humanCode } from "@/lib/call/format";
import type { CallView } from "@/lib/call/projection";
import type { ComplianceDecision } from "@/lib/carriers/compliance";

/**
 * Who is on the phone, and whether they may haul.
 *
 * Brokers already run this check across FMCSA, an insurance database and a
 * watchdog list in separate tabs; the thing they say they want is one profile,
 * one status, one decision, with the reasoning attached to every flagged rule.
 * So the verdict is the loudest element on the page and each reason carries
 * its own code and sentence — a block a person cannot explain is one they will
 * override.
 */

const VERDICT: Record<ComplianceDecision, { label: string; panel: string; text: string }> = {
  allow: {
    label: "Cleared to haul",
    panel: "border-emerald-500/30 bg-emerald-500/[0.07]",
    text: "text-emerald-300",
  },
  flag: {
    label: "Cleared with flags",
    panel: "border-amber-500/30 bg-amber-500/[0.07]",
    text: "text-amber-300",
  },
  block: {
    label: "Blocked",
    panel: "border-rose-500/40 bg-rose-500/[0.09]",
    text: "text-rose-300",
  },
};

const SEVERITY_TEXT: Record<string, string> = {
  block: "text-rose-300",
  flag: "text-amber-300",
  info: "text-zinc-400",
};

export function CarrierPanel({
  carrier,
  compliance,
}: {
  carrier: CallView["carrier"];
  compliance: CallView["compliance"];
}) {
  if (compliance === null && carrier === null) {
    return (
      <section className="rounded-lg border border-dashed border-zinc-800 px-3 py-6">
        <h2 className="text-[11px] font-medium tracking-[0.14em] text-zinc-500 uppercase">
          Carrier
        </h2>
        <p className="mt-2 text-xs leading-relaxed text-zinc-600">
          Unverified. The gate runs against FMCSA on the first MC number the caller gives.
        </p>
      </section>
    );
  }

  const verdict = compliance === null ? null : VERDICT[compliance.decision];

  return (
    <section
      className={`rounded-lg border ${verdict?.panel ?? "border-zinc-800 bg-zinc-900/40"}`}
      aria-live="polite"
    >
      <header className="flex items-center justify-between border-b border-inherit px-3 py-2">
        <h2 className="text-[11px] font-medium tracking-[0.14em] text-zinc-500 uppercase">
          Carrier
        </h2>
        {verdict !== null && (
          <span className={`text-[11px] font-semibold tracking-wide ${verdict.text}`}>
            {verdict.label}
          </span>
        )}
      </header>

      {carrier !== null && (
        <div className="border-b border-inherit px-3 py-3">
          <p className="text-sm leading-tight font-medium text-zinc-100">{carrier.legalName}</p>
          {carrier.dbaName !== null && (
            <p className="text-xs text-zinc-500">dba {carrier.dbaName}</p>
          )}
          <dl className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1.5 font-mono text-[11px]">
            <Field label="MC" value={carrier.mcNumber} />
            <Field label="DOT" value={carrier.dotNumber ?? "—"} />
            <Field label="Authority" value={carrier.authorityStatus} />
            <Field label="Rating" value={carrier.safetyRating ?? "none on file"} />
            <Field label="Power units" value={carrier.powerUnits?.toLocaleString() ?? "—"} />
            <Field
              label="Prior calls"
              value={String(carrier.previousCalls)}
              // Day 7's memory beat: on the second call this is not zero, and
              // it is the one number on this card that comes from our own data
              // rather than the government's.
              highlight={carrier.previousCalls > 0}
            />
          </dl>
        </div>
      )}

      {compliance !== null && compliance.reasons.length > 0 && (
        <ul className="divide-y divide-zinc-800/60">
          {compliance.reasons.map((reason) => (
            <li key={reason.code} className="px-3 py-2">
              <p
                className={`font-mono text-[11px] tracking-wide ${SEVERITY_TEXT[reason.severity] ?? "text-zinc-400"}`}
              >
                {humanCode(reason.code)}
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-zinc-400">{reason.message}</p>
            </li>
          ))}
        </ul>
      )}

      {compliance !== null && compliance.reasons.length === 0 && (
        <p className="px-3 py-2.5 text-xs text-zinc-500">
          Every rule checked, nothing to report.
        </p>
      )}
    </section>
  );
}

function Field({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div>
      <dt className="text-[10px] tracking-wide text-zinc-600 uppercase">{label}</dt>
      <dd className={`tabular ${highlight ? "text-sky-300" : "text-zinc-300"}`}>{value}</dd>
    </div>
  );
}
