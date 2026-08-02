# Plan

7 days. Each day is one checkpoint: it ends green, committed, with `STATE.md` updated.

Sequenced by **uncertainty, not architecture** — the things most likely to invalidate the
plan go early. That is why FMCSA lands on Day 2 and a working eval skeleton lands on Day 3.

---

## Day 1 — Foundation ✅
- [x] Scaffold Next.js 16 + TS + Tailwind 4
- [x] Install Drizzle, Neon, Zod, tsx
- [x] Context system (`CLAUDE.md` + `docs/`)
- [x] Drizzle schema: `loads`, `carriers`, `runs`, `run_events`, `negotiations`, `eval_results`
- [x] Seed 40 realistic loads on real lanes, each with floor / ceiling / market rate
- [x] Neon connected, schema pushed, seed verified
- [x] `/loads` board renders from the DB

## Day 2 — Carrier data + compliance gate ✅
- [x] Vitest set up, `pnpm test` wired
- [x] `CarrierDataSource` interface + normalized `CarrierRecord`
- [x] `SocrataCarrierSource` — no API key, works immediately
- [x] Response caching in Postgres (the demo cannot depend on a live gov API)
- [x] `evaluateCompliance()` → `{ decision: allow | flag | block, reasons[] }` — pure, no I/O
- [x] Real payloads recorded as offline fixtures: active · authority-inactive ·
      unsatisfactory · no-equipment · ambiguous-MC · docket2 · nonexistent MC.
      MC numbers recorded in `STATE.md`.
- [x] **Regression suite green:** 156 tests, offline. 1620-case compliance product,
      normalization against recorded payloads, cache read-through, cross-source contract
- [x] `QCMobileCarrierSource` — written and contract-tested; only its network path waits
      on the WebKey

## Day 3 — Agent core + eval skeleton ✅
- [x] Headless tool-calling loop (Vercel AI SDK 7 + Anthropic)
- [x] Tools: `lookup_carrier`, `get_load`, `check_compliance`, `counter_offer`,
      `book_load`, `escalate_to_human`, `end_call`
- [x] Negotiation policy enforced in the tool layer — and one step stronger than planned:
      the model has no argument through which to name a rate at all (`DECISIONS.md` #17)
- [x] Full trace written to `run_events`
- [x] **Regression suite green and grown: 171 → 398.**
      - `book_load` invariant enumerated: 11,200 attempts (40 loads × 7 rates ×
        5 counter counts × 4 compliance states × 2 load statuses), plus hostile args
        passed directly to `execute`, bypassing zod
      - Max-counter-count tested at N-1 / N / N+1, with the schedule pinned to literals
      - Ceiling absence asserted at the **payload** level — every serialized prompt and
        tool schema, across all 40 loads
      - Fake model (`MockLanguageModelV4`) throughout; the network guard stayed green
      - Trace completeness: one row per tool call with args, result, duration
      - **Suite mutation-tested.** 11 mutations run; 10 went red immediately, 1 survived
        and produced a real fix
- [x] **Walking-skeleton eval**, which found a real defect on its second run and confirmed
      the fix on its third (`DECISIONS.md` #18)
- [x] Closed deferred Day 2 item 1 (fetch timeouts + bounded staleness, `DECISIONS.md` #16)
- [x] Fixed a schema bug found while planning the write path: `carriers.is_out_of_service`
      was `NOT NULL DEFAULT false` against a three-valued field

## Day 4 — Interface ✅
- [x] Split view: conversation left, live tool trace right (args, result, latency)
- [x] Load board + carrier profile update in real time beside the call
- [x] Compliance block renders with its reasons visible
- [x] Transport is a route handler streaming NDJSON off a **tee'd `TraceSink`** — the
      conversation loop is untouched by the interface, so Day 5 still runs headless
      (`DECISIONS.md` #20). Two edits did land inside `run.ts`, both listed in `STATE.md`;
      "unmodified" was the wrong word and is gone.
- [x] Second-audience allowlist `toBrokerLoad`, and the wire asserted free of the
      ceiling per load, in cents and dollars (`DECISIONS.md` #21)
- [x] Closed deferred criticals **#1** (a trace write could unbook freight) and
      **#10** (per-instance `seq` restarting each turn) — both promoted from latent
      to load-bearing by this day's work
- [x] **Regression suite green and grown: 427 → 479.** Every fix mutation-tested

## Day 5 — Eval suite
- [ ] Carrier-simulator agent that plays a persona against the real agent
- [ ] Personas: revoked authority · prompt injection · "what's your max" · mangled MC digits
      · double-broker · mid-call hangup · lowball×5 · off-topic (+ more if time)
- [ ] LLM judge with a per-dimension rubric
- [ ] `pnpm eval` → scorecard, results persisted, rendered at `/evals`

## Day 6 — Hardening + the delta
- [ ] Run the suite, record the baseline score
- [ ] Fix every real failure it surfaces
- [ ] Re-run, record the new score
- [ ] **Write the before/after story into `INTERVIEW.md` while it is fresh**

## Day 7 — Ship
- [ ] Deploy to Vercel
- [ ] Carrier memory demo verified: call #2 recalls call #1
- [ ] 5-minute demo script rehearsed
- [ ] 3-minute Loom recorded as backup for a bad connection

---

## Kill order

Pre-committed while calm. When a day slips, execute this top-down without renegotiating.

1. **Browser voice** — already deprioritized, first to go
2. **Run-trace UI polish** — degrade to a plain HTML table
3. **Persona count** — 20 → 6, keeping: revoked authority, prompt injection,
   "what's your max", mangled MC digits, double-broker, mid-call hangup

**Never cut:** real FMCSA integration · the eval before/after delta · the call-#2 memory moment.
Those three *are* the demo contract.

---

## Amendments

Plans change. Silent changes are the problem, not changes. One row, twenty seconds.

| Date | Change | Why | Cost |
|---|---|---|---|
| 2026-08-01 | Eval skeleton moved Day 5 → Day 3 | Highest-value and least-familiar component was scheduled last, so any earlier slip threatened it with no runway. Walking skeleton early turns Day 5 into scaling work, which is compressible. | None — Day 3 absorbs it |
| 2026-08-01 | Added `SocrataCarrierSource` alongside QCMobile | FMCSA WebKey needs a Login.gov account. Rather than block Day 2 on it, the keyless Socrata census API works immediately and QCMobile becomes an upgrade behind the same interface. | ~1h, buys full independence from the key |
| 2026-08-01 | Out-of-service fixtures are **derived**, not recorded | No keyless FMCSA source reports OOS — the census file has no such column among its 148, and QCMobile 404s without a WebKey. Rather than leave the `OUT_OF_SERVICE` block path untested until the key lands, the QCMobile fixtures are hand-built from a real census record, named `*.derived.json`, and carry a `_derivation` key naming every mutated field. A test enforces the naming. See `DECISIONS.md` #10. | None — real recordings replace them when the key arrives, and the rule and its tests are already written |
| 2026-08-01 | Day 3: `counter_offer` computes the rate instead of clamping a model-supplied one | The clamp version makes the invariant a validation problem, and every test on that path is a test that our validation is exhaustive. Removing the argument removes the class. | None — simpler tool, stronger claim |
| 2026-08-01 | Day 3 also took deferred item 1 (fetch timeouts) | Day 3 wraps the lookup in a tool on a live carrier call, so a 300s undici default stopped being theoretical. Cheaper to fix where it is used than to schedule separately. | ~1h, closes the highest-priority Day 2 deferral |
| 2026-08-01 | Day 3 added a verification gate to `counter_offer` | The eval caught the agent quoting before the FMCSA lookup returned — the model parallelises tool calls, so prompt-stated ordering is not ordering. See `DECISIONS.md` #18. | ~20m, and it is the demo's best single anecdote |
| 2026-08-02 | Day 4 took deferred criticals #1 and #10 before writing any UI | Both live on the trace path, and Day 4 turns the trace from a debug aid into a rendered feature. #1 needed a database outage to reach; a live sink enqueueing onto an HTTP stream makes closing a tab enough, on the path that commits freight. #10 is forward hardening rather than a repair — one sink serves a whole call today, and the second writer arrives with Day 7's durable `SessionStore`. **Row corrected 2026-08-02:** it previously claimed one sink per HTTP request made turn 2 restart at seq 0, which the shipped wiring cannot do. See `STATE.md` #10. | ~1.5h, closes two of the eleven deferred criticals |
| 2026-08-02 | Sessions are process-local, not snapshotted | Cheapest thing that is correct in `next dev`, and the failure is made loud — a missing session is a 409, never a rebuilt `CallState`. **Day 7 owes a `SessionStore` backed by a `CallState` snapshot**, or a second turn landing on a cold Vercel instance silently resets the counter cap. Tracked as a Day 7 item, not a surprise. | ~0 now, ~1–2h on Day 7 |
| 2026-08-02 | Day 5 opened by closing out the `day-4-interface` review rather than starting the eval suite | The review found a turn that rolls back half of itself — `messages` discarded on failure while `CallState` and the rows tools wrote were not, so a retry gets rung 2 of the concession schedule while the model believes it is opening. That is a defect in the demo's headline claim, and it lives on the path Day 5 is about to run hundreds of times. Three test holes and five wrong docstrings came with it, and a second pass over the close-out found two more it had missed. See `DECISIONS.md` #22. | ~3.5h, suite 479 → 506, PR #3 merged as `0bbc80a` |
| 2026-08-02 | Day 4 added a second allowlist rather than reusing the agent's | The interface serialises a load into a client component, which is a wire. #19's rule is that the question has to be asked per audience, and the human's answer differs — the broker sees the band. | ~30m, and the ladder is the demo's best visual |
| 2026-08-01 | Day 2 dropped the "revoked" fixture in favour of "authority-inactive" | Socrata's docket status is only ever A/I/P — there is **no** "R". A revoked authority and a voluntarily surrendered one are indistinguishable in this dataset; both are `I` and neither may haul freight. Calling the case "revoked" would have been a claim the data cannot support. | None — the demo beat is unchanged and LB 168 INC is a stronger bad actor than the original pick |
