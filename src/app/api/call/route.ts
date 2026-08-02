import { z } from "zod";

import { sessions } from "@/lib/call/session";
import { startCall } from "@/lib/call/start";

/**
 * Opens a call: writes the `runs` row and builds the tools bound to it.
 *
 * A route handler rather than a Server Action. Actions are dispatched one at a
 * time per client and answer with a single Flight response carrying a return
 * value plus a re-rendered tree — a mutation primitive, not an event channel.
 * The turn endpoint next door needs to stream tool calls as they happen, so
 * both live here and the pair stays one shape.
 */

export const dynamic = "force-dynamic";

const StartBody = z.object({
  /** What the caller claims before anything is verified. Recorded, not trusted. */
  mc_number: z.string().trim().max(32).nullish(),
});

export async function POST(request: Request): Promise<Response> {
  const parsed = StartBody.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    const session = await startCall({ mcClaimed: parsed.data.mc_number ?? null });
    sessions.put(session);
    return Response.json({ run_id: session.runId }, { status: 201 });
  } catch (error) {
    console.error("[call] could not start:", error);
    return Response.json(
      {
        error: "call_unavailable",
        message: error instanceof Error ? error.message : "Could not start the call.",
      },
      { status: 503 },
    );
  }
}
