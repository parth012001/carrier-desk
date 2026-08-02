@AGENTS.md

# carrier-desk

An AI carrier sales rep for freight brokerage.

A carrier calls in about a load. The agent verifies their operating authority against real
FMCSA data, blocks bad actors, presents the load, negotiates the rate within policy, books it,
and writes everything back — building a carrier profile that makes the next call better.

**The product is company-neutral. Nothing in `src/` should ever name a company.** Per-company
framing — demo script, talking points, their metrics — lives in `docs/pitch/<company>.md` and
is swappable. This is a portfolio piece shown to multiple employers, not a demo for one.

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
pnpm test             # regression suite — must be green before any commit
pnpm eval             # run the adversarial eval suite, print scorecard

pnpm carrier:lookup <MC> [--refresh]   # live FMCSA lookup + compliance, through the cache
pnpm agent:smoke <MC> <LOAD_REF>       # one real conversation: live model + FMCSA + Postgres
pnpm fixture:record <MC> <label>       # record a real Socrata payload as an offline fixture
```

> `carrier:lookup`, `agent:smoke` and `eval` are the **only** things that touch a live API.
> `pnpm test` never does, and `src/test/setup.ts` enforces that mechanically.

> `pnpm db:push` needs `--force` (config sets `strict: true`):
> `pnpm exec drizzle-kit push --force`

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
- **A source must declare what it cannot answer.** A field the source can't see is `null`
  *and* its `SourceCapabilities` entry is `false` — never a defaulted `false`/`0`. The gate
  has to be able to tell *checked and clean* from *never checked*; anything else silently
  clears carriers on questions nobody asked. See `DECISIONS.md` #10.
- **The model's history is never less than what the tool layer has already done.** Tools move
  `CallState` and write their rows as they execute, so `messages` is the only half of a turn
  that *can* be rolled back — which is exactly why it must not be. A turn that fails partway
  commits the steps that completed; discarding them does not restore the world, it hides half
  of it, and the half it hides is the half that would have told the model it already countered.
  **`CallState` is never rewound the other way:** it mirrors effects already in Postgres, and
  an agent that forgets freight it booked is a worse bug than the one being fixed.
- **Every agent run writes a full trace** to `run_events` — one row per tool call with args,
  result, and duration. Observability is a feature of the demo, not a debug aid.
- **The agent core is headless.** Conversation policy is separate from transport, so the eval
  suite can run hundreds of turns without any UI or voice. Never couple them.
- **Cache every external API response.** The demo cannot depend on a live government API
  being up during an interview.

## Research protocol

**Never answer from memory about a library, API, or service.** Training data goes stale and
this project runs on versions newer than most of it (Next 16, Drizzle 0.45, Zod 4, AI SDK).

- **Context7 MCP** — for any library, framework, or SDK question. Drizzle, Next, Zod, Vitest,
  the AI SDK. Use it even when the answer feels obvious.
- **Exa MCP** — for anything on the open web. FMCSA and Socrata field semantics, freight
  domain questions, what carriers and brokers actually do, competitor behavior.
- Next.js specifically also ships its own docs at `node_modules/next/dist/docs/` — read those
  for routing, caching, and data-fetching questions.

Look it up, then write the code. Not the other way around.

## Testing bar

The point of the suite is to know, mechanically, whether the thing still works. It is not
coverage theater.

- **Every pure decision function gets table-driven tests.** `evaluateCompliance` is
  safety-critical — a wrong `allow` is the worst bug this system can have. Enumerate the
  combinations, don't sample them.
- **Never hit a live external API from a test.** Record one real payload per case, commit it
  as a fixture under `src/**/__fixtures__/`, and test against that. Tests must pass offline,
  on a plane, with the government API down.
- **Fixtures come from real lookups.** Record them from actual FMCSA/Socrata responses, then
  freeze. Real shape, deterministic replay.
- **Contract tests across implementations.** Every `CarrierDataSource` must normalize to an
  identical `CarrierRecord` shape, so swapping Socrata for QCMobile can't silently change
  behavior downstream.
- **When a bug is found, the regression test lands in the same commit as the fix.**
- `pnpm test` green is a precondition for every commit. No exceptions.

## Where truth lives

| File | Holds |
|---|---|
| `CLAUDE.md` | This file. Rules and invariants. Rarely changes. |
| `docs/PLAN.md` | The 7-day plan, kill order, and amendment log |
| `docs/STATE.md` | **Read this second, every session.** Where we are, what's next |
| `docs/DECISIONS.md` | Decisions and their *why*. Append-only. Don't re-litigate these. |
| `docs/pitch/<company>.md` | Per-company demo script and talking points. One file per employer. |

## Session protocol

- **Start:** read `CLAUDE.md`, then `docs/STATE.md`, then continue from "Next command".
- **During:** commit in **logical chunks as you go**, never one dump at the end. One commit =
  one coherent unit that typechecks and passes `pnpm test` on its own. A reviewer should be
  able to read the log and follow the reasoning. Code and its docs go in the *same* commit so
  they can never drift.
- **End:** stop at a green checkpoint, not when context runs out. Update `STATE.md`,
  append to `DECISIONS.md` and the active `docs/pitch/*.md`, commit, then clear.

If the plan changes, that is expected — log it in the Amendments table in `docs/PLAN.md`
with the reason. Changing the plan is fine. Changing it silently is not.
