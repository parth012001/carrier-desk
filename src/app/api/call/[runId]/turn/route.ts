import type { ModelMessage } from "ai";
import { z } from "zod";

import { agentModel } from "@/lib/agent/models";
import { runCall } from "@/lib/agent/run";
import { CallbackTraceSink, TeeTraceSink } from "@/lib/agent/trace";
import { type CallEvent, encodeCallEvent, toCallEvent } from "@/lib/call/events";
import { sessions } from "@/lib/call/session";
import { buildTools } from "@/lib/tools";

/**
 * One carrier turn, streamed as NDJSON.
 *
 * The agent loop is untouched by this file. `runCall` already routes every
 * user turn, assistant turn and tool call through a `TraceSink`, so the live
 * view is a second sink tee'd alongside the durable one — not a rewrite of the
 * loop around a transport. That separation is what lets Day 5 push hundreds of
 * adversarial turns through the same function with no HTTP anywhere.
 *
 * The cost, taken deliberately: `generateText` resolves a step at a time, so
 * the reply lands per step rather than per token. The tool trace is what this
 * demo is arguing about, and that streams live with real latencies.
 */

export const dynamic = "force-dynamic";
/** A twelve-step call runs well past Vercel's default. */
export const maxDuration = 60;

const TurnBody = z.object({
  message: z.string().trim().min(1).max(2000),
});

export async function POST(
  request: Request,
  ctx: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const { runId } = await ctx.params;

  const session = sessions.get(runId);
  if (session === null) {
    // Loud, never silent. Rebuilding a `CallState` here would reset
    // `countersUsed` to 0 and `hasClearedCarrier()` to false — the three-counter
    // cap would quietly stop existing and nothing on any screen would say so.
    // A lost session has to be an error the operator sees.
    return Response.json(
      {
        error: "session_not_found",
        message: "That call is no longer open on this server. Start a new one.",
      },
      { status: 409 },
    );
  }

  const parsed = TurnBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  // One turn at a time. Two concurrent runs would interleave writes to the same
  // `CallState` and `messages`, and `CallState` is where the counter cap lives.
  if (session.inFlight) {
    return Response.json({ error: "turn_in_progress" }, { status: 409 });
  }
  session.inFlight = true;

  const userMessage: ModelMessage = { role: "user", content: parsed.data.message };
  // Built as a candidate, not pushed. If the turn fails the session is left
  // exactly as it was, so a retry does not stack orphaned user turns.
  const turnMessages = [...session.messages, userMessage];

  const encoder = new TextEncoder();
  let stream: ReadableStream<Uint8Array>;
  try {
    stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: CallEvent) => {
          let line: string;
          try {
            line = encodeCallEvent(event);
          } catch (error) {
            // Not the reader's fault, and not silent. A payload that will not
            // serialise is a hole in a pane that claims to show everything, so
            // it has to reach the logs even though the durable row was written.
            console.error(`[call ${runId}] could not serialise a ${event.kind} event:`, error);
            return;
          }
          try {
            controller.enqueue(encoder.encode(line));
          } catch {
            // The reader went away. The call keeps running and keeps writing to
            // run_events — which is the whole reason the sinks are tee'd.
          }
        };

        const trace = new TeeTraceSink(
          session.deps.trace,
          new CallbackTraceSink((event) => send(toCallEvent(event))),
        );

        // Tools are built here, not at call start, because `buildTools` captures
        // `deps.trace` — and the live branch of that trace belongs to *this*
        // connection. Tools built once at call start wrote only to Postgres, so
        // the browser saw the conversation and not one tool call, which is the
        // whole pane. `state` is the object that has to survive between turns;
        // the tool set is a closure over it and costs nothing to rebuild.
        const tools = buildTools({
          deps: { ...session.deps, trace },
          state: session.state,
        });

        // Deliberately not awaited. The Response has to be returned while this is
        // still running, or there is nothing to stream.
        runCall({ model: agentModel(), tools, messages: turnMessages, trace })
          .then((result) => {
            session.messages = [...turnMessages, ...result.responseMessages];
            send({
              kind: "turn_end",
              text: result.text,
              finished: !result.stoppedOnStepCap,
              toolCalls: result.toolCalls,
            });
          })
          .catch((error: unknown) => {
            console.error(`[call ${runId}] turn failed:`, error);
            send({
              kind: "error",
              message: error instanceof Error ? error.message : String(error),
            });
          })
          .finally(() => {
            session.inFlight = false;
            session.lastTouchedAtMs = Date.now();
            try {
              controller.close();
            } catch {
              // Already closed, because the client cancelled the stream.
            }
          });
      },
    });
  } catch (error) {
    // `start` runs synchronously inside the constructor, so a throw from
    // building the tee, the tools or the model lands here — *before* the
    // `.finally` that releases the lock has been registered. Without this the
    // session stays `inFlight` and answers 409 to every later turn until the
    // hour-long sweep collects it, with no way for the operator to clear it.
    session.inFlight = false;
    throw error;
  }

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
      // Without this a buffering proxy holds the whole response and the trace
      // arrives all at once at the end, which defeats the point of streaming.
      "x-accel-buffering": "no",
    },
  });
}
