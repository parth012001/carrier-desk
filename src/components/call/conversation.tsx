"use client";

import { useEffect, useRef, useState } from "react";

import type { Turn } from "@/lib/call/projection";

/**
 * The call itself.
 *
 * You type as the carrier, which is the honest framing: this is the side of
 * the conversation a broker never controls. The agent's replies land a step at
 * a time rather than a token at a time, because the loop underneath is
 * `generateText` and keeping it that way is what lets the eval push hundreds
 * of headless turns through the same function.
 */
export function Conversation({
  turns,
  running,
  ended,
  error,
  openers,
  onSend,
}: {
  turns: Turn[];
  running: boolean;
  ended: boolean;
  error: string | null;
  openers: { label: string; message: string }[];
  onSend: (message: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const tail = useRef<HTMLDivElement>(null);

  useEffect(() => {
    tail.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns.length, running]);

  const submit = (message: string) => {
    const trimmed = message.trim();
    if (trimmed === "" || running || ended) return;
    setDraft("");
    onSend(trimmed);
  };

  return (
    // Stacked on a phone the flex child collapses to its composer, so the
    // transcript gets a floor until the three-column layout takes over.
    <section className="flex min-h-[26rem] flex-col rounded-lg border border-zinc-800 bg-zinc-900/40 lg:min-h-0">
      <header className="flex items-baseline justify-between border-b border-zinc-800 px-4 py-2">
        <h2 className="text-[11px] font-medium tracking-[0.14em] text-zinc-500 uppercase">
          Call
        </h2>
        <span className="font-mono text-[11px] text-zinc-600">
          {ended ? "ended" : running ? "agent is working" : "your turn"}
        </span>
      </header>

      <div className="thin-scroll min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {turns.length === 0 && (
          <div className="py-6">
            <p className="text-xs leading-relaxed text-zinc-500">
              You are the carrier calling in. Give an MC number and ask about a load.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {openers.map((opener) => (
                <button
                  key={opener.label}
                  type="button"
                  onClick={() => submit(opener.message)}
                  className="rounded border border-zinc-700 px-2.5 py-1 font-mono text-[11px] text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500"
                >
                  {opener.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((turn, index) => (
          <article key={`${index}-${turn.speaker}`} className="trace-row-in">
            <p
              className={`mb-1 font-mono text-[10px] tracking-[0.12em] uppercase ${
                turn.speaker === "carrier" ? "text-zinc-500" : "text-sky-400/80"
              }`}
            >
              {turn.speaker}
            </p>
            <p
              className={`text-sm leading-relaxed whitespace-pre-wrap ${
                turn.speaker === "carrier" ? "text-zinc-400" : "text-zinc-100"
              }`}
            >
              {turn.text}
            </p>
          </article>
        ))}

        {error !== null && (
          <p className="rounded border border-rose-500/40 bg-rose-500/[0.08] px-3 py-2 font-mono text-[11px] text-rose-300">
            {error}
          </p>
        )}

        <div ref={tail} />
      </div>

      <form
        className="border-t border-zinc-800 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit(draft);
        }}
      >
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit(draft);
              }
            }}
            rows={2}
            disabled={ended}
            placeholder={ended ? "This call has ended." : "Say something as the carrier…"}
            className="thin-scroll flex-1 resize-none rounded border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={running || ended || draft.trim() === ""}
            className="rounded bg-zinc-100 px-3 py-2 text-xs font-medium text-zinc-900 transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 disabled:opacity-30"
          >
            Send
          </button>
        </div>
      </form>
    </section>
  );
}
