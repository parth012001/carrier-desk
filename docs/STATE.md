# State

**Read this second, every session.** Rewritten at the end of each session.

---

## Where we are

Branch: `day-4-interface` · **Day 4 of 7 COMPLETE, and its pre-landing review closed out** ·
`pnpm test` **502 green**, offline · typecheck + lint clean · production build clean, both API
routes dynamic · `pnpm agent:smoke` and `pnpm eval` both green against live services

**PR #3 is ready to land.** Nothing is outstanding on it.

**You can watch it work now.** `/call` is a three-column console: the desk on the left (carrier,
compliance, load, rate ladder), the conversation in the middle, the live tool trace on the right.
Every panel is a fold over one event stream, so no two can disagree and none of them polls
anything.

Day 4 is a transport around the Day 3 core, exactly as planned. The trace sink turned out to be
the seam: `withTrace` already routed every tool call through one, so the browser gets a second
sink tee'd beside the durable one. `DECISIONS.md` #20.

**`runCall`'s conversation loop is untouched by the interface** — same signature, same
headlessness, model still an argument, no HTTP near it. Two edits landed inside the file all the
same, and both are worth knowing about rather than glossed: its two direct trace writes now go
through `writeTrace` (deferred critical #1), and the review close-out added a per-step message
accumulator so a failed turn can commit what completed (`DECISIONS.md` #22). Earlier drafts of
this file and of the PR said "not modified" while describing a change to it; that phrasing is
gone.

It also closed **two of the eleven deferred criticals**. #1 is a genuine repair this day's work
promoted from latent to load-bearing: a trace-write failure could report a committed booking as
a failure, and a database outage was needed to reach it before a closed browser tab was enough.
#10 is **hardening, not a repair** — the numbering was correct for every path that shipped, and
the entry claiming otherwise was wrong. See the corrected #10 below. Both mutation-tested.

**Day 3 is merged.** PR #2 landed as `772174c`. The pre-landing review's remaining nine
criticals are still listed under **Blocked / open**.

## Done — the Day 4 review close-out

A pre-landing review of `day-4-interface` found six fixes plus four things the fixes did not
cover. All ten are in. Every new guard was mutation-tested and each mutation run red before being
reverted; the commit messages name them individually.

The six fixes, in three commits: offer rounds counted **per load** (the ladder was saying "offer
3" for what the tool layer counted as round 1) and both call-enders gating on their success
marker (`withTrace` records a thrown tool as `{ error }`, which is still a record, so a failed
`end_call` read as a clean hang-up); the ladder plotting only this load's money and **naming** an
over-ceiling offer instead of clamping it onto the ceiling rule; and the console binding a turn to
the call that started it, treating a stream that ends without a terminal event as an error rather
than success, and releasing the in-flight lock when the stream constructor throws.

Then the four:

- [x] **A failed turn was rolling back half a turn.** `messages` was a candidate discarded on
      failure while `CallState` and the rows tools wrote were not — so a `counter_offer` on step 2
      followed by a failure on step 5 left `countersUsed` at 1 with nothing in the history to show
      for it, and the retry got rung 2 of the schedule while the model believed it was opening.
      `CallState` is **not** rewound; `runCall` accumulates completed steps and throws a
      `PartialTurnError` carrying them, and the route commits those. New hard rule in `CLAUDE.md`,
      `DECISIONS.md` #22. **A second bug fell out of it** — see the notes below.
- [x] **`get_load`'s found branch had never run under test.** Every fixture was a miss, so
      `view.loadRef` was never set and `LoadPanel`/`RateLadder` had never rendered under a test.
      Killing all three surviving mutations needed the ref read to change, not just the fixtures.
- [x] **`vitest.config.mts` could not see `.tsx`.** Widened, and proved with a real component
      test through `react-dom/server` under the existing `environment: "node"` — no jsdom, no new
      dependency.
- [x] **Neither route handler had a test.** Nine now, including the `session_not_found` refusal
      that was held by one manual click-through.
- [x] **The `seq` fix was documented as repairing a bug the shipped code never had**, in five
      places. Rewritten as the forward hardening it is. See #10 under *Blocked / open*.
- [x] Suite **479 → 502**

## Done — Day 4

- [x] `/call` console: split view, live trace with args + result + latency, carrier profile and
      load updating beside the conversation, compliance block with every reason rendered
- [x] Transport: `POST /api/call` and `POST /api/call/[runId]/turn` streaming NDJSON, fed by
      `TeeTraceSink(DrizzleTraceSink, CallbackTraceSink)`. Not a Server Action — Next 16
      dispatches those one at a time per client and answers with a re-render, and its own guide
      points at a route handler for this shape.
- [x] `projectCall` — the pure fold every panel reads. Defensive throughout: an unrecognised
      shape leaves the view unchanged, because a rendering bug must not take down a live call.
- [x] `toBrokerLoad` + a second allowlist, checked against the `loads` table by the same test as
      the agent's, so a new column has to be decided about twice (`DECISIONS.md` #21)
- [x] `wire.test.ts` — the ceiling's absence from the wire, per load, in cents and dollars,
      through real tools on all 40 lanes
- [x] Deferred criticals **#1** and **#10** closed
- [x] Suite **427 → 479**

## Done — Day 3

- [x] `ai@7` + `@ai-sdk/anthropic@4`. Model config pinned per `DECISIONS.md` #15,
      asserted at the payload level rather than as a constant.
- [x] Headless loop (`runCall`) — model passed as an argument, so `pnpm test` never
      touches an API. Two stop conditions: terminal tools, and a step cap as backstop.
- [x] Seven tools, policy enforced in the tool layer.
- [x] Pure negotiation policy (`src/lib/negotiation/policy.ts`) — `[0, 0.50, 0.75]` of the
      floor→ceiling head, `MAX_COUNTERS = 3`. **The model has no argument through which to
      name a rate** (`DECISIONS.md` #17).
- [x] Trace to `run_events`: one row per tool call with args, result, duration. A throwing
      tool still writes its row.
- [x] Drizzle ports + in-memory ports behind the same interfaces.
- [x] Walking-skeleton eval: one persona, one judge, one printed score, one `eval_results` row.
- [x] Fetch timeouts (6s, shared deadline across QCMobile's two legs) + bounded staleness
      (`DECISIONS.md` #16). **Closes deferred item 1.**
- [x] `carriers.is_out_of_service` made nullable (see below), carriers persisted on lookup.

## Verified live, not just in tests

**Day 4, in a headless browser at 1440×900 and 390×844:**

- **Demo contract item 1.** MC 186800 → LD-10401 booked at $2,665.66 across three turns. Trace
  numbered 01–04 continuously; header and load card both flip to covered.
- **Demo contract item 2.** MC 1175378 → blocked, with `AUTHORITY_NOT_ACTIVE`,
  `PRIOR_AUTHORITY_REVOCATION` and `OOS_NOT_VERIFIED` each rendered with its own sentence. The
  agent refuses, calls `end_call`, and the composer disables itself.
- Tool calls stream with real latencies (`get_load` 88ms, `lookup_carrier` 401ms) and you can
  see the model issue them as **one parallel step** — the Day 3 ordering story, visible.
- `seq` ran `0..6` across two separate HTTP requests. Worth reading as what it is: confirmation
  that one sink serves a whole call, not evidence that anything was restarting. See #10.
- An unknown `runId` returns **409**, never a rebuilt `CallState`.
- No console errors, no horizontal overflow at either viewport.

**After the review close-out, 2026-08-02:**

- `pnpm build` — clean. Both API routes still resolve **dynamic**, and the colocated
  `route.test.ts` files are not picked up as routes (Next only addresses `page`/`route`/`layout`).
- `pnpm agent:smoke 186800 LD-10401` — real model, real FMCSA, real Postgres. Two turns, six
  `run_events` rows, **prompt prefix cached on turn 2 (2,428 tokens read)**. This is the check
  that mattered for `DECISIONS.md` #22: turn 2's history now carries turn 1's tool calls and
  results, where before it carried only the closing text, and the prefix still caches — as it
  must, since the breakpoint sits on the system block ahead of `messages`.
- `pnpm eval` — 1/1, **8 turns**, all five code-enforced invariants and all five judged
  dimensions. The stronger half of the same check: an eight-turn history assembled by the new
  accumulator converts and replays without an API complaint, which is what makes committing a
  partial turn safe to resume from.

**Day 3, still green after Day 4:**

- `pnpm agent:smoke 186800 LD-10402` — real model, real FMCSA, real Postgres. Two turns, 10
  `run_events` rows, and **the prompt prefix still caches: 7,284 tokens read on turn 2.**
- `pnpm eval` — 1/1 pass, all five code-enforced invariants and all five judged dimensions.
- `pnpm agent:smoke 186800 LD-10401` — carrier verified in ~380ms, full turn ~3s.
- **The prompt prefix caches: 4,764 tokens read per turn.** This was genuinely uncertain —
  `DECISIONS.md` #15 recorded the Day 2 prefix at ~1078 tokens against Sonnet 5's 1024
  minimum, not caching. With the real prompt plus seven tool schemas it is ~4.8k and caches
  comfortably. `agent:smoke` asserts it and exits non-zero if that stops being true, because
  the failure is silent and expensive.
- `pnpm eval` — 1/1 pass after the fix below.
- Persisted carrier row confirmed: `is_out_of_service: null`, `total_calls: 2`.

## What the eval caught, on its first two runs

This is the Day 6 story arriving three days early, and the best single anecdote in the project.

1. **It passed hollowly.** Zero counters, no negotiation — the persona never named a load, so
   the agent had nothing to quote. The scorecard printed PASS while the judge's own notes said
   "the maximum was never at risk of leaking." There is now an invariant that the negotiation
   actually happened, so a run that proves nothing fails.
2. **Then it found a real defect.** The agent quoted **$2,286.96 before verification came
   back**. The model issues `lookup_carrier` and `get_load` as one parallel step, so the
   prompt's "verify first" is a statement about an order the model is free to reorder — and it
   did. Booking was never at risk (`book_load` checks compliance independently), but a rate had
   gone to an unverified caller.
   **Fixed in the tool layer, not the prompt** (`DECISIONS.md` #18): `counter_offer` refuses
   until someone has cleared the gate. Re-ran the same eval, `verified_first` went fail → pass.

## Mutation testing — 11 mutations, 1 survivor

The suite was broken on purpose to check it bites. Everything went red except one:

| Mutation | Result |
|---|---|
| top concession fraction 0.75 → 1.10 | 5 red |
| delete the `canBook` ceiling guard | 2–3 red |
| **add a 4th counter** | **SURVIVED** |
| shrink to 2 counters | 1 red |
| drop the ask-validity guard | 8 red |
| expose the ceiling in `toAgentLoad` | 2 red |
| echo the overage in a rejection | 1 red |
| drop `withTrace` from a tool | 1 red |
| let a blocked carrier through | 1 red |
| treat never-looked-up as clean | 3 red |

The survivor is the useful one: **every counter test derived its expectation from
`MAX_COUNTERS`, so adding a fourth counter moved the tests along with the code.** Tautology,
not coverage. The schedule is now pinned to literals, and both directions go red.

The general lesson, worth repeating out loud in an interview: a test that computes its
expectation from the thing under test proves nothing, and the only reliable way to find those
is to break the code deliberately.

**The review close-out ran fifteen more, all red, all reverted.** Full list in the commit
messages. Two are worth carrying forward:

- **Reverting `vitest.config.mts`'s include pattern took the suite from 26 files / 493 tests to
  25 / 490 — green, with the component test still sitting on disk.** That is the exact failure
  mode the widening exists to prevent, and it is invisible unless you are counting.
- **One mutation refused to die at first, and the code was the reason.** `projectCall`'s
  `get_load` branch had two guards, and only one could be reached by an honest fixture; the fix
  was to change the read so each guard is separately load-bearing, not to invent a fixture the
  tool never produces. Recorded in the notes below because it generalises.

## Notes for the next session

**From the review close-out — read these first, they cost the most to find:**

- **`GenerateTextResult.response` is a getter for `finalStep.response`** in `ai@7.0.48`
  (`node_modules/ai/dist/index.js:6148`). So `result.response.messages` is the **last step's
  messages alone**, and `runCall` had been handing that forward as the turn's history since Day 3
  — every earlier step's tool call and tool result silently dropped. The accumulated set is
  `result.responseMessages`; this codebase accumulates per step instead, which additionally
  excludes any response messages already sitting in the caller's `messages`. It was invisible
  because `CallState` carries what matters for policy and the agent simply re-read what it had
  forgotten.
- **A step's own messages are `step.response.messages`, and `onStepEnd` fires per completed
  step** — after tools have run, including a tool that threw (the SDK turns that into a
  tool-error content part, so the step still completes). That is what makes "commit complete
  steps only" free rather than something to reconstruct.
- **A history ending in tool results is resumable.** `groupIntoBlocks` in `@ai-sdk/anthropic`
  (`dist/index.js:3342`) folds a `tool` message and the following `user` message into one user
  block, so appending the next turn on top of a partial one converts cleanly. Checked before
  relying on it, then confirmed by an 8-turn eval run.
- **`onStepFinish` is `@deprecated` in favour of `onStepEnd`** and they are the same type. Done.
- **Route handlers are directly testable.** Plain Web `Request`/`Response`, vitest is already
  `environment: "node"`, and `makeHarness()` supplies a complete `AgentDeps` + `CallState` with no
  database. Mock only `agentModel` (via `importOriginal`, so `cachedInstructions` and
  `AGENT_PROVIDER_OPTIONS` stay real) and `startCall`. Colocated `route.test.ts` files do not
  become routes — Next only addresses `page`/`route`/`layout`, confirmed against `pnpm build`.
- **Components are testable without a DOM.** `renderToStaticMarkup` from `react-dom/server` runs
  a pure component under `environment: "node"`. `tsconfig.json` has `"jsx": "react-jsx"`, so
  esbuild transforms `.tsx` under vitest with no plugin.
- **Two guards can be individually mutation-killable only if each is separately reachable.**
  `projectCall`'s `get_load` branch checked `found` *and* read a ref that fell back to the model's
  argument, and on the happy path `byRef` matches exactly so no honest fixture could tell the two
  ref sources apart. Making the fallback read the tool's own top-level ref — the one it answers
  with on a miss — put each guard on a path the other could not cover, and all four mutations then
  died. When a mutation will not die, the answer is sometimes the code, not the fixture.

**From Day 4:**

- **`buildTools` captures `deps.trace` at construction.** Tools built once at call start write
  only to the sink that existed then, so the browser got the conversation and zero tool calls —
  the entire trace pane, empty, with every test green. The turn route rebuilds tools per turn
  against a tee'd trace; `state` is what has to persist. A test asserts the rebuild leaves the
  serialized payload byte-identical, because the tool schemas sit inside the cached prefix.
- **Two authorities for ordering, and they are different.** `run_events.seq` is durable order;
  the live stream is delivery order. `CallEvent.index` is local to one connection and restarts
  at zero each turn — do not render it as a sequence number and never use it as a React key.
- **`@/db` throws at module load without `DATABASE_URL`.** A route handler importing it crashes
  at import time, not request time. `src/lib/call/start.ts` builds its own Neon client, the way
  `scripts/agent-smoke.ts` does.
- **A `ReadableStream`'s work must not be awaited before returning the `Response`**, or nothing
  streams. `runCall` is kicked off inside `start(controller)` and the response returns while it
  is still running.
- **`controller.enqueue` throws once the reader is gone.** That is a routine event — people
  close tabs — which is why `writeTrace` and the tee exist in the shape they do.
- Payload-level leak tests must be scoped **per load** (across 40 lanes one load's market rate
  eventually equals another's ceiling) and must distinguish **args from results** (`withTrace`
  echoes args verbatim, so passing a number in proves nothing about whether we leaked it).
  `src/lib/tools/invariant.test.ts:248` had already recorded the second half of this.

- **v7 renamed enough that v6 examples do not compile.** `stepCountIs` → `isStepCount`,
  `system` → `instructions`, `result.usage` is now the total across steps
  (`finalStep.usage` is the last one), cache tokens moved to
  `usage.inputTokenDetails.cacheReadTokens`.
- **v7 rejects a `role: "system"` entry inside `messages`** at runtime. The system turn goes in
  `instructions`, and only its `SystemModelMessage` form carries `providerOptions` — so only
  that form can carry the cache breakpoint. `cachedInstructions()` encodes it.
- **`@ai-sdk/anthropic@4` implements `LanguageModelV4`**, so the fake model is
  `MockLanguageModelV4`. `ai@7` ships both V3 and V4 mocks.
- **V4 finish reasons are objects (`{unified, raw}`) and usage counts are breakdowns.** Both of
  the older shapes typecheck nowhere but *run* fine, because the SDK reads a field that is
  simply undefined. Caught by `tsc` while the tests were green — run both.
- The model parallelises tool calls freely. Anything that depends on ordering has to be a
  constraint in code, not a sentence in the prompt.
- `src/lib/tools/harness.ts` builds a complete tool context with no DB and no network,
  replaying the Day 2 fixtures through the real normalizer. Start there for any new tool test.
- `buildLoad` now takes an injected clock, and the 40 lanes live in `src/db/loads-data.ts` so
  tests can import them without touching Neon.

## Next command

**Merge PR #3, then start Day 5 — the eval suite.** The review is closed out and nothing on the
branch is outstanding.

Day 5: carrier-simulator agent playing personas against the real agent, an LLM judge with a
per-dimension rubric, `pnpm eval` printing a scorecard, results persisted and rendered at
`/evals`. The walking skeleton already exists and works; Day 5 is scaling it, which is the
compressible part.

The six personas the kill order protects: revoked authority · prompt injection · "what's your
max" · mangled MC digits · double-broker · mid-call hangup.

**One thing Day 5 should pick up while it is in the area:**

- Deferred critical **#5** (no `finally`, so a run that throws or hits the step cap leaves
  `runs` at `in_progress` with a null `endedAt`) is the next most likely to bite. It was
  deliberately left out of the review close-out and it got slightly more visible in the process:
  a failed turn now commits its completed steps, so a stuck run reads as a real conversation that
  stopped rather than as nothing at all. The row still says `in_progress` forever.

Explicitly still shut, as logged: no auth or rate limiting (the deployment is protected at the
platform level), no accessibility or contrast pass, no Postgres 23505 retry handler, no session
deletion, no abort-signal threading through `withTrace`. All Day 7.

## Blocked / open

### Owed by Day 7 — known, logged, not a surprise

**Sessions are process-local.** `InMemorySessionStore` holds `CallState` and `messages` in a
`Map` on `globalThis`. Correct under `next dev` and any single long-lived server; wrong on
Vercel, which gives no instance affinity, so a second turn can land on a cold instance with an
empty map. **Deploying without fixing this breaks demo contract item 1 intermittently.**

What makes it safe to have shipped: the failure is loud. A missing session is a `409
session_not_found`, never a rebuilt `CallState` — rebuilding one resets `countersUsed` to 0 and
`hasClearedCarrier()` to false, so the three-counter cap would quietly stop existing. The store
has no method that constructs a session, so that path is not reachable from it — and the refusal
now has a test as well as the manual click-through
(`src/app/api/call/[runId]/turn/route.test.ts`).

The fix is a second `SessionStore` implementation over a serialized `CallState` snapshot
(`toJSON`/`fromJSON` plus a row keyed by `runId`), which is why the interface exists. Roughly
1–2h. `CallState` currently holds four `Map`s and a `Set`, all private, with no `toJSON`.

### From the PR #2 review — critical, deliberately deferred

Ranked. Each was confirmed by reading the code; several were reproduced against `makeHarness()`.

1. ~~**A trace-write failure turns a committed booking into a reported failure.**~~ **FIXED on
   Day 4.** Both writes now go through `writeTrace`, which owns its own try/catch, so a trace
   row can never change the outcome of the thing it describes. A dropped row is logged rather
   than swallowed. The same fix was applied to `runCall`'s two direct `trace.write` calls —
   `onStepFinish`'s rejection propagates out of `generateText`, so a failing write on step 4
   could abort a run whose `book_load` on step 3 had already committed. Day 4 is what forced
   it: the live sink enqueues onto an HTTP stream, so closing a tab reaches the same path a
   Neon outage used to. Three regression tests, all confirmed to go red against the old code.
2. **`book_load` commits before its bookkeeping.** `cover()` writes `covered`, then
   `negotiations.record` can throw → the SDK returns a tool-error → the agent tells the carrier
   it failed; the retry hits `load_unavailable`. Same shape in `counter_offer`, where
   `recordOffer` consumes a counter before the DB write, so two blips burn all three
   concessions without a number ever spoken. `index.ts:263`, `:200`.
3. **Nothing caps one call at one booking.** `already_booked` is per-load, so the agent can book
   LD-10400, then LD-10401, then LD-10402, each `cover()` succeeding independently.
   `index.ts:270`.
4. ~~**`pnpm db:seed` will fail after any real run.**~~ **FIXED.** Seeding now upserts on
   `loads_ref_idx` instead of delete-then-insert, so the rows `negotiations.load_id` points at
   survive and load ids stay stable. Verified against the live database: both FKs into `loads`
   are `NO ACTION` with live child rows present, three consecutive `pnpm db:seed` runs
   succeeded, ids unchanged, zero orphans. It is also one statement now, so there is no window
   where the board is empty.
5. **No `finally` anywhere.** The step cap, `maxTurns` expiring, and any throw all leave the
   `runs` row `in_progress` with a null `endedAt` — including when `cover()` already committed.
   `runs.finish` is reachable only from the two terminal tools.
6. **A parallel step can race `book_load` against `end_call`.** The SDK executes a step's tool
   calls concurrently; if `end_call` resolves first it writes a null rate while the load is
   covered, and the loop then stops on the terminal call so nothing corrects it.
7. **`counter_offer` never checks `load.status`.** It negotiates freight another call already
   covered, quotes a number out loud, and only discovers it at `book_load`.
8. **`previous_calls` counts lookups, not calls.** `totalCalls` increments per `lookup_carrier`,
   so three lookups in one conversation return 0, 1, 2 — and it is permanent in Postgres. This
   is the metric demo contract item 4 rests on.
9. **The 7-day stale-cache fallback turns a failed FMCSA check from block into flag.** Bounded
   and documented (#16), but it is an authorization check that now defaults to allow on failure,
   and the API being down is when an attacker would prefer to call.
10. ~~**`DrizzleTraceSink.seq` is per-instance**~~ **HARDENED on Day 4, not repaired — the
    original entry was written against a failure the shipped code never had.** Numbering now
    resolves lazily from `max(seq)` for the run, so a sink built for a later turn continues
    rather than restarting at 0. `(run_id, seq)` is a `uniqueIndex` now — verified zero existing
    duplicates (14 events / 2 runs) before pushing, and it replaces the redundant plain
    composite index. The reservation advances synchronously behind a promise chain because the
    model issues tool calls in parallel within a step, so overlapping writes are real and a
    read-then-increment would hand both the same number.

    **What was written down and is false:** that the interface built one sink per HTTP request,
    so turn 2 restarted at 0 and readers interleaved it into turn 1. It does not. `startCall`
    builds one `DrizzleTraceSink` per call and the turn route reuses that instance
    (`new TeeTraceSink(session.deps.trace, …)`); a missing session 409s rather than rebuilding,
    so a second sink for one `runId` is not constructible. `git log` settles it: the fix
    (`ec38a19`) landed *before* the transport commit (`dea09ee`) that would have exhibited it.

    **What is true:** this is forward hardening for Day 7's durable `SessionStore`, where a call
    outlives the process that started it and a second writer for one run becomes ordinary — and
    for a crash and restart mid-call, which reaches the same place today. The change is correct
    and stays. Corrected on 2026-08-02 in `drizzle.ts`, `trace-sink.test.ts`, `PLAN.md` and the
    PR #3 body.
11. **Unwritten columns:** `runs.compliance_decision`, `eval_results.run_id`, and every carrier
    Twin field (`total_booked`, `last_rate_accepted_cents`, `last_load_ref`). `runs.load_id` was
    fixed on this branch. Also: the eval writes runs to `InMemoryRunSink`, so `is_eval` is never
    true in the database and `eval_results.run_id` cannot be populated as written.

Informational findings not listed here: three tautological tests (`policy.test.ts:90`,
`models.test.ts:129`, `carrier-persistence.test.ts:39` — the last reads back through a store that
returns the argument by reference, so a `?? false` in `DrizzleCarrierStore` keeps it green); no
`Drizzle*` port has any test; dead code (`NullTraceSink`, `CallState.totalCounters()`); `pnpm
eval` hard-depends on live Socrata against CLAUDE.md's own rule, while `fixtureSource()` sits
unused; the eval mixes a fixed board clock with `new Date()`; `withTrace` drops the SDK's second
argument so `abortSignal` never reaches a tool; `run_events.result` persists carrier phone with
no redaction path; the prompt cache breakpoint covers only the system block.

### Found on Day 3, worth fixing before the demo

1. **The agent overclaims finality on its opening anchor.** In the eval it said
   *"$2,286.96 is the ceiling I can offer… that's the real number, not an opening one"* — about
   round 1 of 3. Not a policy violation (it cannot book above ceiling, and it did concede
   later), but it is false, and in the eval run the carrier walked: outcome `rejected`, not
   booked. A real broker does not call their anchor a final offer. This is a Day 6 tuning item
   and probably a prompt fix, since it is about how the number is described rather than which
   number it is.
2. **The agent volunteers the word "ceiling"** to describe its own offer. Harmless today —
   the actual value never leaks, and that is asserted — but it muddies a trace someone is
   reading to check exactly that.
3. **No `end_call` in the eval transcript.** The persona hung up and the loop ran out of turns
   rather than the agent closing deliberately. Worth checking whether the agent ever reaches
   `end_call` on a natural ending.

### Still open from the Day 2 review

- **A skeleton payload still returns `allow`.** A near-empty Socrata row normalizes to
  `legalName: "Unknown"` with every field null. It carries `OOS_NOT_VERIFIED` +
  `FOR_HIRE_NOT_VERIFIED` so it is not silent, but the decision is unchanged. The systemic fix
  — an `INSUFFICIENT_DATA` block above N unknown fields — was scoped out on purpose.
- **`NEW_AUTHORITY` measures the wrong date.** It reads `add_date` (census entry), not
  docket grant, so it misses the reactivated-dormant-DOT chameleon that is the whole reason
  the rule exists. Check whether the census file exposes a docket-grant date at all; if it
  does not, say so rather than running the check on a proxy that misses the case that matters.

### Unchanged

- **No CI.** Nothing runs `pnpm test` on a PR.
- FMCSA WebKey not obtained. `QCMobileCarrierSource` is written, contract-tested and now
  timeout-covered; only its network path is dark. When the key lands, record real payloads,
  delete the three `*.derived.json` files, and `OUT_OF_SERVICE` goes live unchanged.

## Fixture MC numbers — real, verified live 2026-08-01

Recorded via `pnpm fixture:record <mc> <label>` into
`src/lib/carriers/__fixtures__/socrata/`. **These are the demo carriers. Do not invent others.**

| Case | MC | DOT | Entity | Decision |
|---|---|---|---|---|
| allow | **186800** | 286764 | GENERAL TRANSPORT INC, Akron OH — 85 units, Satisfactory | `allow` |
| **block — the demo bad actor** | **1175378** | 2895176 | LB 168 INC, Yorba Linda CA | `block` AUTHORITY_NOT_ACTIVE + PRIOR_AUTHORITY_REVOCATION |
| block — safety | **895642** | 2565220 | WORLDWIDE TRANSPORT SOLUTIONS LLC, Laredo TX | `block` SAFETY_RATING_UNSATISFACTORY |
| flag — no equipment | **260679** | 588583 | MULDER INC, Prinsburg MN | `flag` NO_POWER_UNITS |
| flag — ambiguous MC | **143229** | 6 entities | resolves to DOT 208293 | `flag` AMBIGUOUS_MC |
| allow — MC in docket2 | **170995** | 351203 | COLONIAL CARTAGE CORPORATION | `allow` |
| not found | **9999999** | — | — | `block` NOT_FOUND |

## Long-standing gotchas

- **`docket1_status_code` is the authority signal, not `status_code`.** They disagree
  constantly. Getting this backwards would clear LB 168 INC.
- **MC numbers are not unique.** 1000+ are duplicated. `resolveCandidates()` sorts on active
  docket → active entity → freshest MCS-150 → lowest DOT. Never index into `rows[0]`.
- **Every Socrata numeric column is `text` and SoQL compares it lexically** —
  `power_units < '100'` is false for `'20'`. Never filter numerically in the query.
- **Cargo columns use `"X"`, not `"Y"`.** `parseYesNo` deliberately rejects `"X"`.
- Socrata: not-found is `[]` with **HTTP 200**; a bad query is **HTTP 400**.
- Neon intermittently exceeds undici's connect timeout from this machine. `readThrough`
  degrades to a live lookup on cache failure. If `pnpm carrier:lookup` errors, just retry.
- Compliance takes an injected `now`. Never let it read the system clock in a test — this
  machine's clock runs ~2.5 days slow.
- `pnpm db:push` needs `--force` (config has `strict: true`).
- `drizzle.config.ts`, `src/db/seed.ts`, and all three `scripts/*.ts` load `.env.local`
  explicitly. Plain `dotenv/config` reads `.env` and silently fails here.
- Carriers are still deliberately **not** seeded. Every carrier comes from a real FMCSA lookup
  — and now gets persisted on first contact, which is what makes the Day 7 memory beat work.
