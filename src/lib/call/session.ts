import type { ModelMessage } from "ai";

import type { CallState } from "@/lib/agent/state";
import type { AgentDeps } from "@/lib/agent/types";

/**
 * Everything one call needs to survive between turns.
 *
 * **None of this may cross to the browser.** `CallState` holds `countersUsed`,
 * `verifiedMcNumber` and `agreedByLoad` — it *is* the negotiation policy's
 * memory — and `messages` carries tool results forward. A client that held
 * either would not need prompt injection to beat the policy; it would just
 * edit the JSON. `docs/DECISIONS.md` #4, #17 and #19 all rest on this staying
 * server-side, so the wire carries display data only (`./events.ts`).
 *
 * `deps` is built once at call start, because `DrizzleTraceSink` is bound to
 * the `runId`. **`tools` is not stored here, and that is load-bearing.**
 * `buildTools` closes over `deps.trace` at construction, so a tool set built
 * at call start writes only to the durable sink — the live branch is per
 * connection and does not exist yet. Building the tools once meant the browser
 * received the conversation but not a single tool call, which is the entire
 * feature. Tools are cheap to rebuild and `state` is what actually has to
 * survive, so the turn route builds them per turn against a tee'd trace.
 */
export type CallSession = {
  readonly runId: string;
  readonly mcClaimed: string | null;
  readonly deps: AgentDeps;
  readonly state: CallState;
  /** Grows every turn. Tool results must be carried forward or the model forgets. */
  messages: ModelMessage[];
  /** One turn at a time. Two concurrent runs would race `state` and `messages`. */
  inFlight: boolean;
  lastTouchedAtMs: number;
};

export interface SessionStore {
  put(session: CallSession): void;
  /** Null means gone. Callers must fail, never rebuild — see `InMemorySessionStore`. */
  get(runId: string): CallSession | null;
  delete(runId: string): void;
  size(): number;
}

/** A call left open in a tab nobody came back to should not pin memory forever. */
export const SESSION_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Sessions in process memory.
 *
 * This is a deliberate, logged trade. It is correct under `next dev` and under
 * any single long-lived server, and it is wrong on a platform that gives no
 * instance affinity — on Vercel a second turn can land on a cold instance
 * where this map is empty. The fix is a second `SessionStore` implementation
 * backed by a snapshot of `CallState`, which is why the interface exists.
 *
 * **What makes the trade safe to take now is that the failure is loud.** A
 * missing session must produce an error, never a fresh `CallState`: rebuilding
 * one silently resets `countersUsed` to 0, so the three-counter cap quietly
 * stops existing and `hasClearedCarrier()` goes false, and nothing on any
 * screen says so. That is why this class only ever stores and retrieves — it
 * has no way to construct a session, so the silent path is not reachable from
 * here. `startCall` is the only thing that can make one.
 */
export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, CallSession>();

  constructor(private readonly maxAgeMs: number = SESSION_MAX_AGE_MS) {}

  put(session: CallSession): void {
    this.sweep();
    this.sessions.set(session.runId, session);
  }

  get(runId: string): CallSession | null {
    this.sweep();
    const session = this.sessions.get(runId);
    if (session === undefined) return null;
    session.lastTouchedAtMs = Date.now();
    return session;
  }

  delete(runId: string): void {
    this.sessions.delete(runId);
  }

  size(): number {
    return this.sessions.size;
  }

  private sweep(): void {
    const cutoff = Date.now() - this.maxAgeMs;
    for (const [runId, session] of this.sessions) {
      if (session.lastTouchedAtMs < cutoff) this.sessions.delete(runId);
    }
  }
}

/**
 * One store per process, held on `globalThis` so it survives hot reload.
 *
 * Without this, editing any file mid-call would empty the map and every
 * subsequent turn would 409 — which is the correct behaviour for a genuinely
 * lost session but a miserable way to build the interface that reads it.
 */
const globalForSessions = globalThis as typeof globalThis & {
  __carrierDeskSessions?: InMemorySessionStore;
};

export const sessions: SessionStore =
  globalForSessions.__carrierDeskSessions ??
  (globalForSessions.__carrierDeskSessions = new InMemorySessionStore());
