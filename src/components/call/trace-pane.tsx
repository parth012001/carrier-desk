import { humanCode, latency, usd } from "@/lib/call/format";
import type { TraceRow } from "@/lib/call/projection";

/**
 * Every tool call, in order, with what it was asked and what it answered.
 *
 * The rows are numbered because the order is content here, not decoration: the
 * model issues tool calls in parallel within a step, and "the rate was quoted
 * before verification came back" is a defect you can only see by reading a
 * sequence. Latency is shown for the same reason — a 400ms row is a live
 * government API and an 8ms row is a cache, and the difference is the
 * difference between a demo and a mock.
 *
 * Args and results render verbatim. A summarised trace is one nobody can
 * check, and being checkable is the entire claim.
 */
export function TracePane({ rows, running }: { rows: TraceRow[]; running: boolean }) {
  return (
    <section className="flex min-h-[18rem] flex-col rounded-lg border border-zinc-800 bg-zinc-900/40 lg:min-h-0">
      <header className="flex items-baseline justify-between border-b border-zinc-800 px-3 py-2">
        <h2 className="text-[11px] font-medium tracking-[0.14em] text-zinc-500 uppercase">
          Tool trace
        </h2>
        <span className="tabular font-mono text-[11px] text-zinc-600">
          {rows.length} {rows.length === 1 ? "call" : "calls"}
        </span>
      </header>

      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <p className="px-3 py-6 text-xs leading-relaxed text-zinc-600">
            Nothing called yet. Every tool the agent reaches for lands here with its arguments,
            its result and how long it took.
          </p>
        ) : (
          <ol className="divide-y divide-zinc-800/60">
            {rows.map((row) => (
              <TraceRowItem key={row.ordinal} row={row} />
            ))}
          </ol>
        )}
        {running && (
          <p className="px-3 py-2 font-mono text-[11px] text-zinc-600" aria-live="polite">
            <span className="mr-1.5 inline-block size-1.5 animate-pulse rounded-full bg-sky-400 align-middle" />
            thinking
          </p>
        )}
      </div>
    </section>
  );
}

function TraceRowItem({ row }: { row: TraceRow }) {
  const outcome = summarise(row);
  return (
    <li className="trace-row-in">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-baseline gap-2 px-3 py-2 hover:bg-zinc-800/30 focus-visible:bg-zinc-800/30 focus-visible:outline-2 focus-visible:outline-sky-500">
          <span className="tabular w-5 shrink-0 font-mono text-[10px] text-zinc-600">
            {String(row.ordinal).padStart(2, "0")}
          </span>
          <span className="min-w-0 flex-1">
            <span className="font-mono text-xs text-zinc-200">{row.name}</span>
            {outcome !== null && (
              <span className={`ml-2 font-mono text-[11px] ${outcome.tone}`}>{outcome.text}</span>
            )}
          </span>
          <span className="tabular shrink-0 font-mono text-[10px] text-zinc-600">
            {latency(row.durationMs)}
          </span>
        </summary>
        <div className="space-y-2 px-3 pt-1 pb-3 pl-10">
          <Payload label="args" value={row.args} />
          <Payload label="result" value={row.result} />
        </div>
      </details>
    </li>
  );
}

function Payload({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  return (
    <div>
      <p className="mb-1 text-[10px] tracking-[0.1em] text-zinc-600 uppercase">{label}</p>
      <pre className="thin-scroll overflow-x-auto rounded border border-zinc-800/80 bg-zinc-950/60 px-2 py-1.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-zinc-400">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

/**
 * The one line a person reads while the call is still moving.
 *
 * Deliberately derived from the result rather than stored alongside it, so it
 * cannot drift from what the tool actually returned — and the full payload is
 * one keystroke away underneath.
 */
function summarise(row: TraceRow): { text: string; tone: string } | null {
  const result = row.result;
  if (typeof result !== "object" || result === null) return null;
  const record = result as Record<string, unknown>;

  const dim = "text-zinc-500";
  const bad = "text-rose-300";
  const good = "text-emerald-300";
  const live = "text-sky-300";

  switch (row.name) {
    case "lookup_carrier":
    case "check_compliance": {
      const decision = record.decision;
      if (typeof decision !== "string") {
        return { text: String(record.reason ?? "not verified"), tone: dim };
      }
      const count = Array.isArray(record.reasons) ? record.reasons.length : 0;
      const tone = decision === "block" ? bad : decision === "flag" ? "text-amber-300" : good;
      return { text: `${decision}${count > 0 ? ` · ${count} reason${count > 1 ? "s" : ""}` : ""}`, tone };
    }

    case "get_load": {
      if (record.found !== true) return { text: "not on the board", tone: dim };
      const load = record.load as Record<string, unknown> | undefined;
      return { text: String(load?.status ?? "found"), tone: dim };
    }

    case "counter_offer": {
      const action = record.action;
      if (action === "offer" || action === "accept") {
        const rate = typeof record.rate_cents === "number" ? usd(record.rate_cents) : "";
        return { text: `${action} ${rate}`, tone: action === "accept" ? good : live };
      }
      return { text: humanCode(String(record.reason ?? action ?? "")), tone: bad };
    }

    case "book_load": {
      if (record.booked === true) {
        const rate = typeof record.rate_cents === "number" ? usd(record.rate_cents) : "";
        return { text: `booked ${rate}`, tone: good };
      }
      return { text: `refused · ${humanCode(String(record.reason ?? ""))}`, tone: bad };
    }

    case "end_call":
      return { text: String(record.outcome ?? "ended"), tone: dim };

    case "escalate_to_human":
      return { text: "handed to a person", tone: "text-amber-300" };

    default:
      return null;
  }
}
