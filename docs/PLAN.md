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

## Day 3 — Agent core + eval skeleton
- [ ] Headless tool-calling loop (Vercel AI SDK + Anthropic)
- [ ] Tools: `lookup_carrier`, `get_load`, `check_compliance`, `counter_offer`,
      `book_load`, `escalate_to_human`, `end_call`
- [ ] Negotiation policy enforced in the tool layer — floor/ceiling/max-counters in code
- [ ] Full trace written to `run_events`
- [ ] **Regression suite stays green and grows.** Every tool that enforces policy gets
      table-driven tests the same way `evaluateCompliance` did — enumerate the boundary,
      don't sample it. Minimum bar:
      - `book_load` invariant proven exhaustively: **no input produces
        `booked_rate_cents > rate_ceiling_cents`**, including at/around the boundary,
        with counters exhausted, and with a hostile model argument in the args.
      - Max-counter-count enforced in code, tested at N-1 / N / N+1.
      - The model never receives `rate_ceiling_cents` — assert on the serialized tool
        schema and on every prompt/message payload, not just on intent.
      - Tool-layer tests use a **fake model** (scripted tool calls). No live API in
        `pnpm test`; the network guard in `src/test/setup.ts` must stay green.
      - Trace completeness: a run writes one `run_events` row per tool call with args,
        result, and duration.
- [ ] **Walking-skeleton eval: one persona, one judge call, one printed score, end to end.**
      Ugly is fine. This exists so Day 5 is scaling, not building.

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
| 2026-08-01 | Day 2 dropped the "revoked" fixture in favour of "authority-inactive" | Socrata's docket status is only ever A/I/P — there is **no** "R". A revoked authority and a voluntarily surrendered one are indistinguishable in this dataset; both are `I` and neither may haul freight. Calling the case "revoked" would have been a claim the data cannot support. | None — the demo beat is unchanged and LB 168 INC is a stronger bad actor than the original pick |
