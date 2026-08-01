# Decisions

Append-only. Each entry has the *why*, so a later session doesn't reopen a settled question.

---

### 1 — Build the carrier sales workflow, not a generic voice agent

The interesting problem in freight automation is orchestration and evaluation, not speech
synthesis. Real brokerages run exactly this workflow — present load, negotiate, fraud-check,
book — and building it end to end beats building a better-sounding phone bot. A mediocre
voice demo also competes directly with mature proprietary stacks on their strongest axis,
which is not a fight worth picking in a seven-day build.

**Rejected:** generic voice assistant · a workflow-builder clone (huge scope, shallow result).

Per-employer framing lives in `docs/pitch/<company>.md`, which is deliberately untracked —
see #9.

---

### 2 — Text-first, voice only if the week allows
**2026-08-01**

Voice eats days and fails live on a bad connection. The conversation logic is the substance;
the transport is not. Text-first also makes the eval suite trivial to run headlessly.

---

### 3 — All TypeScript
**2026-08-01**

One language ships fastest in a 7-day window, and Next.js + Vercel is a one-command deploy.
The FDE role also asks for Python, which gets covered in conversation rather than by
splitting the stack and paying integration tax for a demo.

---

### 4 — Negotiation policy lives in the tool layer, not the prompt
**2026-08-01**

Rate floor, ceiling, and max counter count are enforced in code. The model never sees the
ceiling and physically cannot return a booking below floor.

This is the central engineering claim of the project. "What stops a carrier from prompt-
injecting a better rate?" has one good answer, and it is structural, not a better prompt.
A prompt-based guardrail is a suggestion; a tool-layer guardrail is an invariant.

---

### 5 — Carrier lookup sits behind a `CarrierDataSource` interface
**2026-08-01**

Two implementations: `SocrataCarrierSource` (data.transportation.gov census, no API key) and
`QCMobileCarrierSource` (FMCSA QCMobile, richer — has `/authority`, `/oos`, `/basics` — but
needs a Login.gov WebKey).

Started as risk management so Day 2 wouldn't block on a government signup, but it is the
right design regardless: a real deployment might be on Highway, Carrier Assure, or raw FMCSA,
and the compliance logic should not care which.

---

### 6 — Money is integer cents everywhere
**2026-08-01**

Float rounding in a rate negotiation is the kind of bug that shows up on stage. All monetary
columns are `*_cents` integers.

---

### 9 — The product is company-neutral; the pitch is swappable
**2026-08-01**

This is a portfolio piece that will be shown to multiple employers, not a demo for one.
Nothing under `src/` names a company. Per-company framing lives in `docs/pitch/<company>.md`.

The freight domain stays fixed — specificity is what makes it credible, and "I built a real
carrier sales desk" travels better than a generic agent demo. What changes per employer is
the framing: which of the design decisions to lead with, which of their metrics to cite,
what to ask them.

The two portable claims, which work for any applied-AI-agent role: **policy enforced in the
tool layer rather than the prompt**, and **an adversarial eval harness with a real before/after
delta**. Everything else is supporting detail.

---

### 8 — Rate policy runs broker-side: the ceiling is the hard constraint
**2026-08-01**

Caught while writing the seed. We are the **broker buying capacity from a carrier**, so the
financial exposure is paying *too much*, not too little. The three numbers are:

- `rate_floor_cents` — opening anchor, where the agent starts
- `rate_market_cents` — expected fair rate for the lane
- `rate_ceiling_cents` — hard walk-away max, protects broker margin

**Invariant: `booked_rate_cents <= rate_ceiling_cents`.** `book_load` rejects anything above
ceiling regardless of what the model asks for, and the model never sees ceiling at all.

An earlier draft of `CLAUDE.md` had this inverted ("cannot book below floor"), which is the
shipper-side framing. Worth stating plainly here because getting the direction wrong in the
interview would undercut every domain claim in the demo.

---

### 7 — Eval skeleton on Day 3, not Day 5
**2026-08-01**

Sequence by uncertainty, not by architecture. The eval harness is simultaneously the highest-
value component (it is what differentiates the demo) and the least familiar. Scheduling it
last meant any earlier slip would threaten it with no runway. A one-persona walking skeleton
on Day 3 turns Day 5 from "build it" into "scale it," which is compressible or cuttable.

See the Amendments table in `PLAN.md`.
