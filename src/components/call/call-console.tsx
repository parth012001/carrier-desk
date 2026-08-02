"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { type CallEvent, decodeCallEvents } from "@/lib/call/events";
import { EQUIPMENT_LABEL, humanCode, pickupWindow, usd } from "@/lib/call/format";
import { projectCall } from "@/lib/call/projection";
import type { BrokerLoad } from "@/lib/tools/sanitize";

import { CarrierPanel } from "./carrier-panel";
import { Conversation } from "./conversation";
import { RateLadder } from "./rate-ladder";
import { TracePane } from "./trace-pane";

/**
 * The desk.
 *
 * Everything on this screen is a fold over one ordered event stream, so no two
 * panels can disagree and none of them polls anything. The board arrives
 * server-rendered because the policy band is the broker's own data and travels
 * by a different, deliberate channel than the call — the wire carries no
 * ceiling at all, which is what `wire.test.ts` pins.
 */

/** The two fixture carriers the demo turns on. Typing MC numbers live is a bad bet. */
const OPENERS = [
  {
    label: "clean carrier",
    message:
      "Hi, this is Dave with MC 186800. I'm calling about load LD-10401 — is it still available?",
  },
  {
    label: "revoked authority",
    message: "Hey, MC 1175378 here. What have you got going out of Ontario this week?",
  },
];

/** Best effort, for the `runs` row only. The gate never trusts this. */
function claimedMc(message: string): string | null {
  return /\bMC[-\s]?(\d{4,8})\b/i.exec(message)?.[1] ?? null;
}

export function CallConsole({ loads }: { loads: BrokerLoad[] }) {
  const [events, setEvents] = useState<CallEvent[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  /**
   * Bumped by `reset`. A turn belongs to the call that started it, and the only
   * thing that used to say so was hope: "new call" emptied `events` while the
   * previous turn's read loop was still appending into it, so call A's carrier,
   * compliance verdict and booking landed inside call B's view.
   */
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const view = useMemo(() => projectCall(events), [events]);
  const load = useMemo(
    () => (view.loadRef === null ? null : (loads.find((l) => l.ref === view.loadRef) ?? null)),
    [loads, view.loadRef],
  );

  const send = useCallback(async (message: string) => {
    const generation = generationRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    /** False once this turn's call has been replaced. Nothing stale may write. */
    const current = () => generationRef.current === generation && !controller.signal.aborted;

    setRunning(true);
    setFatal(null);
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      if (runIdRef.current === null) {
        const started = await fetch("/api/call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mc_number: claimedMc(message) }),
          signal: controller.signal,
        });
        // Parsed defensively: a proxy or framework error page is HTML, and an
        // unguarded `.json()` reports a syntax error rather than the real one.
        const body = await started.json().catch(() => null);
        if (!started.ok || typeof body?.run_id !== "string") {
          throw new Error(
            body?.message ?? body?.error ?? `Could not start the call (${started.status}).`,
          );
        }
        if (!current()) return;
        runIdRef.current = body.run_id;
        setRunId(body.run_id);
      }

      const activeRunId = runIdRef.current;
      if (activeRunId === null) throw new Error("Could not start the call.");

      const response = await fetch(`/api/call/${encodeURIComponent(activeRunId)}/turn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
        signal: controller.signal,
      });

      if (!response.ok || response.body === null) {
        const body = await response.json().catch(() => null);
        // Gone, not busy — the two share a 409 and need opposite recoveries.
        // Keeping the dead runId sent every retry back to the same session that
        // no longer exists, so the console stayed wedged until someone found
        // "new call". Dropping it lets the next message open a fresh call.
        if (body?.error === "session_not_found") {
          runIdRef.current = null;
          setRunId(null);
        }
        throw new Error(body?.message ?? body?.error ?? `Turn failed (${response.status}).`);
      }

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let rest = "";
      /** A stream that ends without one of these was cut, not completed. */
      let sawTerminal = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        // A chunk boundary lands wherever the network puts it, routinely
        // mid-object, so whatever is left over waits for the next chunk.
        const parsed = decodeCallEvents(rest + decoder.decode(value, { stream: true }));
        rest = parsed.rest;
        if (parsed.events.some((e) => e.kind === "turn_end" || e.kind === "error")) {
          sawTerminal = true;
        }
        if (parsed.events.length > 0) {
          if (!current()) return;
          setEvents((previous) => [...previous, ...parsed.events]);
        }
      }

      // Silence used to read as success. The function being killed at
      // `maxDuration`, or a proxy half-closing, left the composer saying "your
      // turn" while the agent had kept going — and if `book_load` had already
      // committed, the load sat covered with nothing on screen to say so.
      if (!sawTerminal) {
        throw new Error(
          "The call stream ended before the turn finished. The agent may have kept running — " +
            "check the run before trusting this screen.",
        );
      }
    } catch (error) {
      if (!current()) return;
      setFatal(error instanceof Error ? error.message : String(error));
    } finally {
      await reader?.cancel().catch(() => {});
      if (current()) setRunning(false);
    }
  }, []);

  const reset = useCallback(() => {
    // Abort first. The in-flight reader has to lose its claim on this view
    // before the view is emptied, or it refills it with the old call.
    generationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    runIdRef.current = null;
    setRunId(null);
    setEvents([]);
    setFatal(null);
    setRunning(false);
  }, []);

  return (
    <main className="flex h-dvh flex-col bg-zinc-950 text-zinc-100">
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-zinc-800 px-4 py-2.5">
        <h1 className="font-mono text-sm tracking-tight text-zinc-100">carrier-desk</h1>
        <span
          className={`flex items-center gap-1.5 font-mono text-[11px] ${
            view.ended ? "text-zinc-500" : running ? "text-sky-300" : "text-emerald-300"
          }`}
        >
          <span
            aria-hidden
            className={`size-1.5 rounded-full ${
              view.ended ? "bg-zinc-600" : running ? "animate-pulse bg-sky-400" : "bg-emerald-400"
            }`}
          />
          {view.ended ? `ended · ${view.outcome ?? "closed"}` : running ? "working" : "open"}
        </span>
        {runId !== null && (
          <span className="font-mono text-[11px] text-zinc-600">run {runId.slice(0, 8)}</span>
        )}
        <div className="ml-auto flex items-center gap-3">
          {view.booking !== null && (
            <span className="tabular font-mono text-[11px] text-emerald-300">
              {view.booking.loadRef} booked at {usd(view.booking.rateCents)}
            </span>
          )}
          <button
            type="button"
            onClick={reset}
            className="rounded border border-zinc-800 px-2 py-1 font-mono text-[11px] text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500"
          >
            new call
          </button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 lg:grid-cols-[19rem_minmax(0,1fr)_minmax(0,27rem)] lg:overflow-hidden">
        <aside className="thin-scroll flex flex-col gap-3 lg:min-h-0 lg:overflow-y-auto">
          <CarrierPanel carrier={view.carrier} compliance={view.compliance} />
          {load !== null && <LoadPanel load={load} booking={view.booking} />}
          {load !== null && (
            <RateLadder load={load} offers={view.offers} booking={view.booking} />
          )}
          {view.refusals.length > 0 && <RefusalPanel refusals={view.refusals} />}
        </aside>

        <Conversation
          turns={view.turns}
          running={running}
          ended={view.ended}
          error={fatal ?? view.error}
          openers={OPENERS}
          onSend={send}
        />

        <TracePane rows={view.trace} running={running} />
      </div>
    </main>
  );
}

function LoadPanel({
  load,
  booking,
}: {
  load: BrokerLoad;
  booking: { loadRef: string; rateCents: number } | null;
}) {
  const covered = booking?.loadRef === load.ref || load.status === "covered";
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40">
      <header className="flex items-baseline justify-between border-b border-zinc-800 px-3 py-2">
        <h2 className="text-[11px] font-medium tracking-[0.14em] text-zinc-500 uppercase">Load</h2>
        <span
          className={`font-mono text-[11px] ${covered ? "text-emerald-300" : "text-zinc-500"}`}
        >
          {covered ? "covered" : load.status}
        </span>
      </header>
      <div className="px-3 py-3">
        <p className="font-mono text-xs text-zinc-500">{load.ref}</p>
        <p className="mt-1 text-sm leading-tight text-zinc-100">
          {load.origin} <span className="text-zinc-600">→</span> {load.destination}
        </p>
        {load.commodity !== null && (
          <p className="mt-0.5 text-xs text-zinc-500">{load.commodity}</p>
        )}
        <dl className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1.5 font-mono text-[11px]">
          <Cell label="Equipment" value={EQUIPMENT_LABEL[load.equipment] ?? load.equipment} />
          <Cell label="Miles" value={load.miles.toLocaleString()} />
          <Cell label="Weight" value={`${load.weightLbs.toLocaleString()} lb`} />
          <Cell label="Pickup" value={pickupWindow(load.pickupStart, load.pickupEnd)} />
        </dl>
      </div>
    </section>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] tracking-wide text-zinc-600 uppercase">{label}</dt>
      <dd className="tabular text-zinc-300">{value}</dd>
    </div>
  );
}

/**
 * The tool layer saying no.
 *
 * Worth its own panel rather than only a trace row: a refusal is the policy
 * doing its job, and it is the thing a person watching should be able to point
 * at when they ask what stops prompt injection.
 */
function RefusalPanel({ refusals }: { refusals: { tool: string; reason: string }[] }) {
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40">
      <header className="border-b border-zinc-800 px-3 py-2">
        <h2 className="text-[11px] font-medium tracking-[0.14em] text-zinc-500 uppercase">
          Refused by policy
        </h2>
      </header>
      <ul className="divide-y divide-zinc-800/60">
        {refusals.map((refusal, index) => (
          <li key={`${refusal.tool}-${refusal.reason}-${index}`} className="px-3 py-2">
            <p className="font-mono text-[11px] text-zinc-300">{refusal.tool}</p>
            <p className="font-mono text-[11px] text-amber-300/90">{humanCode(refusal.reason)}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
