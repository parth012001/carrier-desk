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

## Day 4 — Interface
- [ ] Split view: conversation left, live tool trace right (args, result, latency)
- [ ] Load board + carrier profile update in real time beside the call
- [ ] Compliance block renders with its reasons visible

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
| 2026-08-01 | Day 2 dropped the "revoked" fixture in favour of "authority-inactive" | Socrata's docket status is only ever A/I/P — there is **no** "R". A revoked authority and a voluntarily surrendered one are indistinguishable in this dataset; both are `I` and neither may haul freight. Calling the case "revoked" would have been a claim the data cannot support. | None — the demo beat is unchanged and LB 168 INC is a stronger bad actor than the original pick |
