# State

**Read this second, every session.** Rewritten at the end of each session.

---

## Where we are

Branch: `day-3-agent-core` · **Day 3 of 7 COMPLETE** · `pnpm test` **398 green**, offline ·
typecheck + lint clean

The thing is an agent now. It verifies a carrier against live FMCSA data, presents a load,
negotiates inside a policy it cannot see, books, and writes a full trace — and there is an
adversarial eval that has already caught a real defect and confirmed the fix.

Day 3 also closed the highest-priority Day 2 deferral (fetch timeouts) and fixed a schema bug
found while planning the carrier write path.

**Not yet merged.** Seven commits on `day-3-agent-core`, unpushed. Day 2 went through a
pre-landing review as PR #1 and found eight defects; Day 3 is larger and should get the same
treatment.

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

- `pnpm agent:smoke 186800 LD-10401` — real model, real FMCSA, real Postgres. Carrier
  verified in ~380ms, full turn ~3s, 7 `run_events` rows with args/result/duration.
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

## Notes for the next session

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

**Start Day 4 — the interface.** Split view: conversation left, live tool trace right, load
board and carrier profile updating beside the call, compliance block rendering with its
reasons. Everything it needs already exists and is headless; Day 4 is a transport, not a
rewrite.

Before that, consider a pre-landing review of `day-3-agent-core` — Day 2's found eight defects
including two wrong-allows, and this branch is bigger.

## Blocked / open

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
