import { asc } from "drizzle-orm";
import { db, loads } from "@/db";

export const dynamic = "force-dynamic";

const usd = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const EQUIPMENT_LABEL: Record<string, string> = {
  dry_van: "Dry van",
  reefer: "Reefer",
  flatbed: "Flatbed",
};

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "available"
      ? "bg-emerald-500/10 text-emerald-400 ring-emerald-500/20"
      : status === "covered"
        ? "bg-sky-500/10 text-sky-400 ring-sky-500/20"
        : "bg-zinc-500/10 text-zinc-400 ring-zinc-500/20";
  return (
    <span className={`inline-flex rounded px-1.5 py-0.5 text-[11px] font-medium capitalize ring-1 ${tone}`}>
      {status}
    </span>
  );
}

export default async function LoadBoardPage() {
  const rows = await db.select().from(loads).orderBy(asc(loads.pickupStart), asc(loads.ref));

  const available = rows.filter((r) => r.status === "available").length;
  const totalValue = rows.reduce((sum, r) => sum + r.rateMarketCents, 0);

  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-10 text-zinc-100">
      <div className="mx-auto max-w-7xl">
        <header className="mb-8">
          <h1 className="text-lg font-semibold tracking-tight">Load board</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {rows.length} loads · {available} available · {usd(totalValue)} on the board
          </p>
        </header>

        {rows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-800 p-12 text-center text-sm text-zinc-500">
            No loads yet. Run <code className="text-zinc-300">pnpm db:seed</code>.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-900/60 text-left text-[11px] uppercase tracking-wider text-zinc-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Ref</th>
                  <th className="px-4 py-2.5 font-medium">Lane</th>
                  <th className="px-4 py-2.5 font-medium">Equipment</th>
                  <th className="px-4 py-2.5 text-right font-medium">Miles</th>
                  <th className="px-4 py-2.5 text-right font-medium">Weight</th>
                  <th className="px-4 py-2.5 font-medium">Pickup</th>
                  <th className="px-4 py-2.5 text-right font-medium">Market</th>
                  <th className="px-4 py-2.5 text-right font-medium">$/mi</th>
                  <th className="px-4 py-2.5 text-right font-medium">Policy band</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/70">
                {rows.map((load) => (
                  <tr key={load.id} className="hover:bg-zinc-900/40">
                    <td className="px-4 py-2.5 font-mono text-xs text-zinc-400">{load.ref}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <span className="text-zinc-100">
                        {load.originCity}, {load.originState}
                      </span>
                      <span className="mx-1.5 text-zinc-600">→</span>
                      <span className="text-zinc-100">
                        {load.destCity}, {load.destState}
                      </span>
                      {load.commodity && (
                        <div className="text-xs text-zinc-500">{load.commodity}</div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-zinc-300">
                      {EQUIPMENT_LABEL[load.equipment] ?? load.equipment}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs text-zinc-300">
                      {load.miles.toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs text-zinc-400">
                      {load.weightLbs.toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-xs text-zinc-400">
                      {load.pickupStart.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                      <span className="ml-1.5 text-zinc-600">
                        {load.pickupStart.toLocaleTimeString("en-US", { hour: "numeric" })}–
                        {load.pickupEnd.toLocaleTimeString("en-US", { hour: "numeric" })}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-zinc-100">
                      {usd(load.rateMarketCents)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs text-zinc-400">
                      {(load.rateMarketCents / 100 / load.miles).toFixed(2)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs whitespace-nowrap text-zinc-500">
                      {usd(load.rateFloorCents)} – {usd(load.rateCeilingCents)}
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusPill status={load.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-4 text-xs text-zinc-600">
          Policy band is internal. The agent opens at floor and may never book above ceiling —
          enforced in the tool layer, not the prompt.
        </p>
      </div>
    </main>
  );
}
