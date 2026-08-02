import { usd, usdWhole } from "@/lib/call/format";
import type { Offer } from "@/lib/call/projection";
import type { BrokerLoad } from "@/lib/tools/sanitize";

/**
 * The policy band, with the agent's offers drawn on it as they land.
 *
 * This is the one place the interface raises its voice, and it is making a
 * single argument: the bright line at the top is a number the model was never
 * given, and everything the agent did happened underneath it. The empty space
 * between the highest offer and that line is the point of the whole system —
 * not a chart of it, the thing itself, drawn from the same rows the tool layer
 * enforced.
 *
 * The ceiling reaches this component from the server-rendered board
 * (`toBrokerLoad`), never from the event stream. Those are two deliberate
 * channels for two audiences, and keeping them separate is what lets the wire
 * be tested for the ceiling's total absence.
 */
export function RateLadder({
  load,
  offers,
  booking,
}: {
  load: BrokerLoad;
  offers: Offer[];
  booking: { loadRef: string; rateCents: number } | null;
}) {
  const span = Math.max(1, load.ceilingCents - load.floorCents);
  /** 0% is the ceiling, 100% is the floor. Offers sit where their money sits. */
  const depth = (cents: number) =>
    Math.min(100, Math.max(0, ((load.ceilingCents - cents) / span) * 100));

  const best = offers.reduce((top, offer) => Math.max(top, offer.rateCents), 0);
  const committed = booking?.loadRef === load.ref ? booking.rateCents : null;
  const headroom = load.ceilingCents - (committed ?? best);

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40">
      <header className="flex items-baseline justify-between border-b border-zinc-800 px-3 py-2">
        <h2 className="text-[11px] font-medium tracking-[0.14em] text-zinc-500 uppercase">
          Rate policy
        </h2>
        <span className="font-mono text-[11px] text-zinc-500">{load.ref}</span>
      </header>

      <div className="px-3 py-4">
        <div className="relative h-52">
          {/* The ceiling. The brightest thing in the panel, and the only line
              nothing is ever allowed to cross. */}
          <Marker
            depth={0}
            label="ceiling"
            value={usd(load.ceilingCents)}
            tone="text-zinc-100"
            rule="bg-zinc-100"
            note="withheld from the model"
          />
          <Marker
            depth={depth(load.marketCents)}
            label="market"
            value={usd(load.marketCents)}
            tone="text-zinc-400"
            rule="bg-zinc-700"
            dashed
          />
          <Marker
            depth={100}
            label="floor"
            value={usd(load.floorCents)}
            tone="text-zinc-400"
            rule="bg-zinc-700"
          />

          {offers.map((offer) => (
            <Rung
              key={`${offer.round}-${offer.rateCents}`}
              depth={depth(offer.rateCents)}
              offer={offer}
              committed={committed === offer.rateCents}
            />
          ))}
        </div>
      </div>

      <footer className="border-t border-zinc-800 px-3 py-2.5">
        {offers.length === 0 ? (
          <p className="text-[11px] text-zinc-600">No rate quoted yet.</p>
        ) : (
          <p className="text-[11px] text-zinc-500">
            <span className="tabular font-mono text-zinc-200">{usdWhole(headroom)}</span>{" "}
            {committed === null ? "of headroom unspent" : "under the walk-away, booked"}
          </p>
        )}
      </footer>
    </section>
  );
}

function Marker({
  depth,
  label,
  value,
  tone,
  rule,
  note,
  dashed = false,
}: {
  depth: number;
  label: string;
  value: string;
  tone: string;
  rule: string;
  note?: string;
  dashed?: boolean;
}) {
  return (
    <div className="absolute inset-x-0 -translate-y-1/2" style={{ top: `${depth}%` }}>
      <div className="flex items-center gap-2">
        <span className={`w-12 shrink-0 font-mono text-[10px] tracking-wide ${tone}`}>{label}</span>
        <span
          aria-hidden
          className={`h-px flex-1 ${rule} ${dashed ? "opacity-50 [mask-image:repeating-linear-gradient(90deg,#000_0_4px,transparent_4px_8px)]" : ""}`}
        />
        <span className={`tabular shrink-0 font-mono text-xs ${tone}`}>{value}</span>
      </div>
      {note !== undefined && (
        <p className="mt-1 ml-14 text-[10px] tracking-[0.1em] text-zinc-600 uppercase">{note}</p>
      )}
    </div>
  );
}

function Rung({
  depth,
  offer,
  committed,
}: {
  depth: number;
  offer: Offer;
  committed: boolean;
}) {
  const settled = offer.accepted || committed;
  return (
    <div
      // Above the band markers: round one is the floor exactly, by design, so
      // an offer sitting on a marker is the common case rather than an edge one.
      className="trace-row-in absolute inset-x-0 z-10 -translate-y-1/2"
      style={{ top: `${depth}%` }}
    >
      <div className="flex items-center gap-2">
        <span className="w-12 shrink-0" />
        <span
          aria-hidden
          className={`size-1.5 shrink-0 rounded-full ${settled ? "bg-emerald-400" : "bg-sky-400"}`}
        />
        <span className="font-mono text-[10px] text-zinc-500">
          {settled ? "agreed" : `offer ${offer.round}`}
        </span>
        <span aria-hidden className="h-px flex-1 bg-zinc-800" />
        <span
          className={`tabular shrink-0 font-mono text-xs ${settled ? "text-emerald-300" : "text-sky-300"}`}
        >
          {usd(offer.rateCents)}
        </span>
      </div>
    </div>
  );
}
