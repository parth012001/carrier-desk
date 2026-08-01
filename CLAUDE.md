@AGENTS.md

# carrier-desk

An AI carrier sales rep for freight brokerage.

A carrier calls in about a load. The agent verifies their operating authority against real
FMCSA data, blocks bad actors, presents the load, negotiates the rate within policy, books it,
and writes everything back — building a carrier profile that makes the next call better.

## Demo contract — this is what must work, live, at the end

1. Take a carrier conversation end to end and book a load
2. Block a revoked-authority carrier at the compliance gate, with the reason shown
3. Show the adversarial eval scorecard with a real before/after delta
4. Run a second call from the same MC where the agent remembers the first

Everything else is negotiable. These four are not. If a day slips, cut scope — never the
timeline. See the kill order in `docs/PLAN.md`.

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind 4 · Drizzle ORM · Neon Postgres ·
Vercel AI SDK (Anthropic) · deployed on Vercel

Next 16 differs from older App Router conventions — see `AGENTS.md`, read the bundled guides
in `node_modules/next/dist/docs/` before writing routing or data-fetching code.

## Commands

```bash
pnpm dev              # dev server
pnpm db:push          # push schema to Neon
pnpm db:seed          # seed loads + carriers
pnpm db:studio        # drizzle studio
pnpm eval             # run the adversarial eval suite, print scorecard
```

## Hard rules

- **Negotiation policy lives in code, never in the prompt.** Floor, ceiling, and max counter
  count are enforced in the tool layer. This is the answer to "what stops prompt injection" —
  and the answer is not "a better prompt."
  - We are the **broker buying capacity**, so the risk is paying *too much*.
    `floor` = opening anchor · `market` = expected fair rate · `ceiling` = walk-away max.
  - **Invariant: `booked_rate_cents <= rate_ceiling_cents`, always.** The model never sees
    `ceiling`, and `book_load` rejects anything above it regardless of what the model asks.
- **Money is integer cents.** Never floats. Columns are `*_cents`.
- **Carrier lookup goes through the `CarrierDataSource` interface.** Two implementations:
  Socrata (no key) and QCMobile (richer, needs a WebKey). Compliance logic must not know
  which one is behind it.
- **Every agent run writes a full trace** to `run_events` — one row per tool call with args,
  result, and duration. Observability is a feature of the demo, not a debug aid.
- **The agent core is headless.** Conversation policy is separate from transport, so the eval
  suite can run hundreds of turns without any UI or voice. Never couple them.
- **Cache every external API response.** The demo cannot depend on a live government API
  being up during an interview.

## Where truth lives

| File | Holds |
|---|---|
| `CLAUDE.md` | This file. Rules and invariants. Rarely changes. |
| `docs/PLAN.md` | The 7-day plan, kill order, and amendment log |
| `docs/STATE.md` | **Read this second, every session.** Where we are, what's next |
| `docs/DECISIONS.md` | Decisions and their *why*. Append-only. Don't re-litigate these. |
| `docs/INTERVIEW.md` | Demo script and talking points, collected as they happen |

## Session protocol

- **Start:** read `CLAUDE.md`, then `docs/STATE.md`, then continue from "Next command".
- **During:** commit at each checkpoint. Code and docs go in the *same* commit so they
  can never drift.
- **End:** stop at a green checkpoint, not when context runs out. Update `STATE.md`,
  append to `DECISIONS.md` and `INTERVIEW.md`, commit, then clear.

If the plan changes, that is expected — log it in the Amendments table in `docs/PLAN.md`
with the reason. Changing the plan is fine. Changing it silently is not.
