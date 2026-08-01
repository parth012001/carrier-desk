# Plan

7 days. Each day is one checkpoint: it ends green, committed, with `STATE.md` updated.

Sequenced by **uncertainty, not architecture** — the things most likely to invalidate the
plan go early. That is why FMCSA lands on Day 2 and a working eval skeleton lands on Day 3.

---

## Day 1 — Foundation
- [x] Scaffold Next.js 16 + TS + Tailwind 4
- [x] Install Drizzle, Neon, Zod, tsx
- [x] Context system (`CLAUDE.md` + `docs/`)
- [ ] Drizzle schema: `loads`, `carriers`, `runs`, `run_events`, `negotiations`, `eval_results`
- [ ] Seed 40 realistic loads on real lanes, each with floor / ceiling / market rate
- [ ] Neon connected, schema pushed, seed verified
- [ ] `/loads` board renders from the DB

## Day 2 — Carrier data + compliance gate
- [ ] `CarrierDataSource` interface
- [ ] `SocrataCarrierSource` — no API key, works immediately
- [ ] `QCMobileCarrierSource` — swaps in when the FMCSA WebKey lands
- [ ] Response caching in Postgres (the demo cannot depend on a live gov API)
- [ ] `evaluateCompliance()` → `{ decision: allow | flag | block, reasons[] }`
- [ ] Fixture set: known-good carrier, revoked authority, out-of-service, nonexistent MC

## Day 3 — Agent core + eval skeleton
- [ ] Headless tool-calling loop (Vercel AI SDK + Anthropic)
- [ ] Tools: `lookup_carrier`, `get_load`, `check_compliance`, `counter_offer`,
      `book_load`, `escalate_to_human`, `end_call`
- [ ] Negotiation policy enforced in the tool layer — floor/ceiling/max-counters in code
- [ ] Full trace written to `run_events`
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
