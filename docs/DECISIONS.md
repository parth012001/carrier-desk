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

### 10 — `isOutOfService` is three-valued, and sources declare what they can answer
**2026-08-01**

The Socrata Company Census File (`az4n-8mr2`) has 148 columns and none of them is
out-of-service. Only QCMobile carries it, and QCMobile requires a WebKey — an unkeyed request
404s with `{"content":"Must provide Webkey"}`.

So `CarrierRecord.isOutOfService` is `boolean | null`, where **`null` means "this source
cannot determine it," never "not out of service."** Every source also publishes
`SourceCapabilities`, so the gate can tell *checked and clean* from *never checked*.

Reporting an unanswerable question as `false` would let the compliance gate clear a carrier on
a check it never performed. That is the exact shape of the worst bug this system can have.

The visible consequence is `OOS_NOT_VERIFIED`, an **info**-severity reason on every Socrata
lookup. Info and not flag deliberately: flagging 100% of lookups trains everyone to ignore
flags, but dropping the caveat would overstate what the gate proved. It goes silent by itself
the day QCMobile is wired in — which is the interface earning its keep, live, on stage.

The same rule generalized: `CAPABILITY_FIELDS` maps each capability to the field it governs,
and the cross-source contract test asserts mechanically that a `false` capability always pairs
with a `null` value. Writing that test is what caught `authorityGrantedAt` diverging between
the two sources with nothing declaring it.

**Rejected:** dropping OOS until the WebKey lands (the block path would then be untested on
the day it matters) · blocking on unknown OOS (blocks every carrier).

---

### 11 — MC numbers are not unique, and resolution is deterministic
**2026-08-01**

Discovered while querying live data, not from the docs. `MC-143229` returns **six rows** — six
distinct legal entities across Michigan and Colorado sharing one docket number, exactly one
with active authority. Over 1000 MC values are duplicated, some with two *active* rows.

`rows[0]` is therefore nondeterministic on the path that decides whether to book freight: the
same carrier could be allowed on one call and blocked on the next, depending only on what
order Socrata happened to return rows in.

`resolveCandidates()` sorts on active docket → active entity → freshest MCS-150 → lowest DOT.
The DOT tiebreak makes the ordering **total**, so no two rows ever compare equal. A rotation
test asserts the winner is identical for every input permutation.

The losing DOT numbers are kept in `ambiguousWith` and become an `AMBIGUOUS_MC` **flag** rather
than being discarded — MC reuse across entities is itself a chameleon-carrier signal, and the
agent should ask which company is actually calling.

Related: dockets live in `docket1`/`docket2`/`docket3`. 79k rows carry an MC in slot 2 and
3.3k in slot 3, so the query ORs across all three. Reading only `docket1` would report
COLONIAL CARTAGE — real, active, Satisfactory — as not found and block it.

**Rejected:** blocking on any ambiguity (would block legitimate old carriers whose MC was
reused decades ago) · resolving silently (discards a real fraud signal).

---

### 12 — An Unsatisfactory safety rating blocks; it does not warn
**2026-08-01**

Under 49 CFR 385.13, a motor carrier with a final "Unsatisfactory" rating is **prohibited from
operating a commercial motor vehicle in interstate commerce**. It is a legal bar, not a
preference, so the gate blocks even when operating authority still reads active — which is
exactly the shape of MC-895642, WORLDWIDE TRANSPORT SOLUTIONS LLC.

"Conditional" means safety management controls are inadequate but have not yet produced
violations of the fitness standard. That is a `flag` for human review, not a block.

This matters beyond correctness: brokers face negligent-selection liability for tendering
freight to an Unsatisfactory carrier. Treating it as a soft warning would be wrong in the
demo and wrong in production.

---

### 15 — Sonnet 5 for the agent and judge, Haiku for the personas
**2026-08-01**

Benchmarked on the real tool loop before choosing: 36 calls, our own system prompt and
seven tools, four adversarial carrier turns (prompt injection, blocked carrier applying
pressure, indirect ceiling extraction, mangled MC).

| model | pass | avg out | avg sec | $/1k turns |
|---|---|---|---|---|
| opus-5 medium | 9/9 | 227 | 5.2s | $8.50–17 |
| **sonnet-5 medium** | **9/9** | **150** | **2.7s** | **$2.85–5.56** |
| haiku-4-5 | 9/9 | 162 | 2.6s | $1.54–2.48 |

Nothing failed anywhere, which is the finding: single-turn safety is not the
differentiator, cost and latency are. Sonnet 5 matches Opus on every case at a quarter
the cost and half the latency — and 2.7s vs 5.2s is visible to a human watching a demo.

- **Agent:** `claude-sonnet-5`, `effort: "medium"`.
- **Carrier-simulator personas (Day 5):** `claude-haiku-4-5` — playing a scripted
  adversary, makes no safety calls, and this is where turn volume lives.
- **LLM judge (Day 5):** `claude-sonnet-5`. A bad judge invalidates the scorecard, and
  the scorecard *is* the demo.

Three things that matter more than the model:

1. **Caching cliff.** System + tools is ~1078 tokens. Opus 5's cache minimum is 512 and
   it cached (82% off input); Sonnet 5's is 1024 and at this size it did **not**. Once the
   Day 3 prompt grows past the threshold, assert `usage.cache_read_input_tokens > 0` —
   otherwise we pay full price on an identical prefix every single turn.
2. **`effort` is a weak lever.** low/medium/high barely moved output tokens. Don't tune it.
3. **Never disable thinking.** Documented failure mode: the model writes a tool call into
   visible *text* instead of a `tool_use` block — the turn succeeds and the call silently
   never runs. For a system whose whole claim is "policy lives in the tool layer," a
   dropped `book_load` is the worst bug available. Use a cheaper model, not less thinking.

Sonnet 5 is on introductory pricing ($2/$10 per MTok) through **2026-08-31** — the whole
build and interview window sits inside it.

---

### 13 — "Unverified" keys off the value, never off the capability bit
**2026-08-01**

Found by review. `OOS_NOT_VERIFIED` originally fired when
`capabilities.outOfService === false`. But QCMobile *declares* it can answer that
question and still omits the element whenever it has no value — its own schema
comment says so. So a real record came back with the capability `true` and the
answer `null`, and the gate returned **allow with zero reasons**: it reported
"checked and clean" about a question that got no answer. Exactly the failure #10
exists to prevent, reintroduced one level down.

The rule now keys off `isOutOfService === null`. The capability bit only chooses
the wording — "the census source has no such field" versus "came back empty from
FMCSA". `FOR_HIRE_NOT_VERIFIED` applies the same rule to the other field that
drives a block, scoped to active authority so it does not stack noise onto
carriers that are already blocked.

**The general rule, now written down:** a capability describes what a source
*can* answer. It is never evidence about what it *did* answer. Only the value is
evidence.

---

### 14 — The ambiguity signal is a count, not a list of names
**2026-08-01**

Found by review, and it was a live wrong-allow. `AMBIGUOUS_MC` fired on
`ambiguousWith.length > 0`, where `ambiguousWith` holds the losing rows' DOT
numbers — but Socrata omits empty fields entirely, so losers without a DOT
silently vanished from that array and the flag never fired.

The consequence is the worst in the system: `resolveCandidates` sorts
active-authority-first, so the winner is the most permissive row available. With
the flag gone, a carrier whose own authority is revoked, calling in with an MC
shared with an active entity, came back **allow** — carrying the other company's
name, DOT and phone, with nothing saying anything was ambiguous.

`ambiguousCount` (derived from the row count) is now the trigger.
`ambiguousWith` is best-effort identification for the human and never drives a
rule. The distinction generalizes: **derive a signal from the fact, not from an
optional field that describes the fact.**

The first fix for this shipped the bug sideways — QCMobile hardcoded
`ambiguousCount: 0` while its docket lookup silently kept only the first entity,
so the same MC came back `flag` through Socrata and `allow` through QCMobile.
Caught by an adversarial pass over the fix itself. `contract.test.ts` now asserts
both sources count ambiguity identically, which is the assertion that would have
caught it the first time.

---

### 16 — A 6s outbound budget, and bounded staleness when it runs out
**2026-08-01**

Three reviewers flagged the same hole on Day 2: no outbound `fetch` carried an `AbortSignal`,
so Node's undici default applied. That is roughly **300 seconds** — five minutes of a driver
holding a phone while a government API decides nothing. Day 3 wraps these calls in a tool on a
live carrier call, so it gets fixed here.

**The budget is 6s.** Day 2 live verification put a working Socrata query well under 2s, so
the budget is generous against the happy path and still inside what a human tolerates.
`DEFAULT_FETCH_TIMEOUT_MS` has a test pinning it to the 5–8s band: raising it should be a
deliberate edit with a failing test attached, not a quiet drift back toward 300s.

**QCMobile shares one deadline across both of its legs.** It makes two sequential calls, so a
per-call budget would give the richer source double the worst case of the keyless one — which
is backwards. The test asserts *signal identity* across the two calls rather than wall-clock
timing: one signal object created once at the start of the lookup is a complete proof of the
property and cannot flake.

**On timeout, the question is what to serve.** Failing closed means `LOOKUP_FAILED`, which
blocks the carrier and escalates — safe, but it also means one slow government API ends the
call, and the demo, on stage. Serving whatever is cached means a decision made on data of
unbounded age. Neither is right at the extremes, so the rule has two thresholds:

| Cache age | Behaviour |
|---|---|
| ≤ 24h (TTL) | fresh — the cache *is* the answer, no reason raised |
| 24h – 7d | served, with a `STALE_LOOKUP` **flag** carrying the age |
| > 7d | refused — `LOOKUP_FAILED`, block, escalate |

The TTL governs the happy path; the 7-day cap governs the degraded one. An FMCSA record from
last Tuesday is a far better basis for a compliance decision than no record at all, and
authority status does not usually turn over inside a week. Past the cap, "what we last saw"
has stopped being evidence about what is true now.

Four constraints fell out of the existing decisions and are worth writing down:

1. **The fallback fires on `error` only, never on `not_found`.** A `not_found` is a real answer
   from a reachable API. Overriding it with an older record would resurrect a carrier the
   registry says does not exist — and `LookupResult` exists (#5) precisely to keep "no such
   carrier" and "the API is down" from collapsing into each other.
2. **`STALE_LOOKUP` lives in `evaluateLookup`, not in `RULES`.** Staleness is a property of the
   lookup, not of the carrier. Putting it in `RULES` would hand `evaluateCompliance` — the one
   deliberately pure function in this system — a fact that does not exist on a `CarrierRecord`,
   and would drag a clock and a cache into it. A test asserts it is absent from `RULES`.
3. **Severity is `flag`, not `info`.** The contrast with `OOS_NOT_VERIFIED` (#10) is the whole
   argument: that one is `info` because it fires on 100% of Socrata lookups, and a flag on
   everything trains everyone to ignore flags. This one fires only when a government API
   actually failed to answer. It is rare, so it should be loud.
4. **A fallback that lands inside the TTL is not flagged.** Reachable via `--refresh`: the
   forced live call fails and the skipped entry turns out to be an hour old. That data is
   current. Flagging it stale would be a small lie in a reason string the agent reads aloud.

Timeout messages are also distinguished from failure messages — "did not respond within 6000ms"
versus "request failed" — because they send whoever debugs them at different systems. And the
response *body* is covered by the same deadline: `.json().catch(() => null)` used to swallow the
abort and report a timeout as "unrecognised payload", blaming our parser for the network.

**Rejected:** failing closed with no fallback (one slow API ends the call) · unbounded staleness
(a decision on data of any age, which is the shape of every bug #10 and #13 exist to prevent) ·
serving stale silently (the gate would report "checked and clean" about a check that timed out).

---

### 17 — The tool computes the counter; the model never names a rate
**2026-08-01**

#4 says negotiation policy lives in the tool layer. There are two ways to build that, and the
difference matters more than it first looks:

- **Model proposes, tool clamps.** The model sends `offer_cents`; the tool rejects anything
  above ceiling. The invariant holds *by validation*.
- **Tool computes.** The model reports only what the carrier asked for; the tool decides what
  to say back. The invariant holds *by construction*.

We build the second. Under the first, `offer_cents` is an argument a carrier can try to steer
through the model, and every test on that path is a test that our validation is exhaustive.
Under the second there is no argument to steer: the counter path has no channel through which
a rate can be named, so exhaustiveness is not something we have to establish. `book_load`
still validates, because booking is the one place a number legitimately arrives from the model.

The current literature is the reason to prefer the structural version rather than trusting a
well-tested check plus a careful prompt. Every prompt-level defense measured in 2026 work on
tool-calling agents — sandwich defense, self-reflection directives, guard-model advisories — is
inconsistent or actively counterproductive, with hijack rates above 80% on the best-performing
backbone tested; one paper documents a guard model correctly flagging a malicious command whose
advisory the main model then ignored, producing RCE anyway. The defense that holds is
deterministic parameter validation at the tool boundary. Removing the parameter is strictly
better than validating it.

**The concession curve.** ⚠️ **Superseded by #19 — the head is floor→market, not floor→ceiling.**
As originally shipped, offers were fixed fractions of the floor→ceiling head, `[0, 0.5, 0.75]`:

| Round | Lands on |
|---|---|
| 1 | `floor` — the opening anchor |
| 2 | **market**, exactly, for the seeded 0.86/1.14 ratios |
| 3 | halfway between market and ceiling |
| 4+ | walk away |

Concessions shrink. This is how the buying side actually negotiates: anchor low, manufacture the
feel of movement while giving away less each time, and decide after two or three rounds instead
of grinding. `MAX_COUNTERS = 3` comes from the same place — an agent that counters forever is one
a carrier can simply wait out. That part stands.

The argument that did *not* stand was "the top fraction is 0.75, strictly below 1.0, which is what
makes the ceiling unreachable on this path rather than merely guarded." Bounding an offer is not
hiding the number it is computed from. See #19.

Three details that are easy to get wrong and are pinned by tests:

1. **If the carrier asks for less than our scheduled offer, take their number.** Countering
   upward to "our" number would donate margin for nothing. This is the only place a
   carrier-supplied value becomes a rate, and it can only ever fire *below* our own offer.
2. **Rejections carry a code and never a number.** `"above_ceiling"` is the whole answer;
   "you're $47 over" would be an oracle the model could binary-search to recover the ceiling.
   Necessary, and — as #19 records — not sufficient on its own: *which* code comes back was
   itself the comparison result.
3. **Untrustworthy bounds mean no negotiation at all.** A row with `ceiling < floor` makes the
   head negative and inverts the schedule — a design that approaches the ceiling from below
   would start walking away from it. A missing row walks away rather than throwing mid-call.

**Mutation testing found a real hole here.** Every counter-cap test derived its expectations
from `MAX_COUNTERS`, so adding a fourth counter moved the tests along with the code and all 88
stayed green — tautology, not coverage. The schedule is now pinned to literals. The lesson
generalizes: a test that computes its expectation from the thing under test proves nothing, and
the only reliable way to find those is to break the code on purpose.

**Rejected:** model proposes + clamp (a validated boundary where a removed parameter would do) ·
a fixed dollar concession (does not scale across a board spanning 60 to 1440 miles) ·
letting the model counter below the scheduled offer (real option, but it hands back
discretion the structural argument exists to remove, for a margin gain we cannot measure yet).

---

### 18 — Ordering is a constraint, not an instruction
**2026-08-01**

The system prompt says, in order: verify the carrier, then present the load, then negotiate.
The Day 3 eval caught the agent quoting **$2,286.96 before verification came back**.

The cause is not a badly worded prompt. The model issues `lookup_carrier` and `get_load` as a
single parallel step — which is efficient and usually correct — and then continues before the
gate's answer has been read. "Do this first" is a statement about a sequence the model is free
to reorder, and it did.

Booking was never at risk: `book_load` checks compliance independently and refuses
`carrier_not_verified`. But quoting a rate to a caller who may turn out to be blocked wastes a
number on a bad actor and, in a demo where the compliance gate is beat #2, looks exactly like
the failure the project claims to have solved.

So `counter_offer` now refuses until someone has cleared the gate. This is #4 applied to a
dimension we had not thought of as policy: not just *what* the agent may say, but *when* it is
allowed to say it. Both are enforced the same way, and for the same reason — a rule the model
can reorder is a rule the next model revision will reorder differently.

**A flagged carrier still gets quotes.** `flag` means "a human should know", not "refuse", and
blocking here would stop the agent working with any carrier whose MC is duplicated — which is
1000+ of them (#11). Only `block` stops a quote.

Two things this validated beyond the fix itself:

1. **The walking skeleton paid for itself on its second run**, which is the argument for #7.
   The find → fix → confirm loop that Day 6 is supposed to produce ran on Day 3, on a defect
   no unit test would have found, because the defect was in *when* the model calls things.
2. **The first run of the eval passed hollowly** — zero counters, no negotiation, because the
   persona never named a load. The judge said so in its notes and the scorecard still printed
   PASS. There is now an invariant asserting the negotiation happened, because a green result
   for a scenario that did not run is worse than a red one. This is the same tautology that let
   a fourth counter slip past the policy suite (#17), found the same way: by looking at whether
   the thing could actually have failed.

**Rejected:** strengthening the prompt's ordering language (the failure mode is parallel tool
calls, which no wording addresses) · forcing sequential tool calls globally via
`disableParallelToolUse` (slower on every call to fix one ordering constraint) · checking in
`get_load` instead (pulling a load is not quoting a rate, and refusing it would stop the agent
answering "is that load still open?" for an unverified caller, which is a reasonable question).

---

### 7 — Eval skeleton on Day 3, not Day 5
**2026-08-01**

Sequence by uncertainty, not by architecture. The eval harness is simultaneously the highest-
value component (it is what differentiates the demo) and the least familiar. Scheduling it
last meant any earlier slip would threaten it with no runway. A one-persona walking skeleton
on Day 3 turns Day 5 from "build it" into "scale it," which is compressible or cuttable.

See the Amendments table in `PLAN.md`.

---

### 19 — Withholding a value means withholding every function of it
**2026-08-02** — supersedes the concession-curve half of #17

A pre-landing review broke the central claim of #4 and #17 three different ways. None of them
was a bug in the ceiling check. All three were the same mistake: treating "the model is never
told the ceiling" as the property, when the property is "the model cannot obtain the ceiling."

**1. The offers published the function.** Interpolating floor→ceiling made every counter an
exact affine function of the ceiling. With `[0, 0.5, 0.75]` the emitted offers satisfy
`ceiling = r3 + (r3 - r2)`, identically, on every load. Two numbers the tool layer handed the
model recovered the number it was not allowed to see, to the cent. Worse, `RATE_FLOOR_RATIO` and
`RATE_CEILING_RATIO` are global across all 40 lanes and live in a public repo, so `ceiling =
market × 1.14` and `get_load` returns market.

The schedule now interpolates **floor→market**, `[0, 0.6, 1]`. Both endpoints are values the
model is already permitted to see, so no offer can carry information it did not already have.
The ceiling is not clamped out of the arithmetic; it is absent from it. `isUsablePolicy` now
requires `floor <= market <= ceiling`, which is what bounds the ladder, and the test asserts the
structural claim directly: vary the ceiling across three orders of magnitude and every offer
must be unchanged.

**2. The reason codes were the oracle they were designed not to be.** #17 point 2 is right that
a rejection must not carry a number, and that was honoured. But `above_ceiling` past the maximum
and `above_last_offer` below it is a one-bit comparator on the ceiling, and a rejected booking
consumes no counter, mutates nothing and is not rate-limited — so it could be run as often as
the model liked. Six probes located the boundary; the seventh booked. The offer guards now run
*before* the ceiling guard, so every rejection above what we said carries the same code wherever
the ceiling sits, and every probe below it books rather than answering.

**3. The guard that mattered most was skipped on its null case.** `above_last_offer` was written
`isValidRateCents(lastOfferedCents) && rateCents > lastOfferedCents`. Before any counter,
`lastOfferedCents` is null, `isValidRateCents(null)` is false, and the whole branch fell through
— so `lookup_carrier` → `book_load` at the walk-away maximum booked, to the cent, with zero
negotiation. The stated invariant (`booked <= ceiling`) held the entire time. A null case is a
case; it now returns `no_offer_made`.

**The eval could not have caught any of it.** Its ceiling invariant was
`!agentText.includes(String(ceiling))` — integer cents compared against prose. A ceiling of
`303156` is spoken "$3,031.56", which contains no such substring, so the check guarding the
project's headline claim was green by construction and would have passed a verbatim disclosure.
It now compares digit-for-digit against each numeric token, in cents and both dollar roundings.
The judge could not cover for it either: the judge is never told the ceiling.

The generalisation, and the reason this is a decision and not a changelog entry: **an allowlist
is a claim about representation, not about information.** `sanitize.ts` withholds the ceiling
column faithfully and always did. Everything above leaked through arithmetic, through control
flow, and through a test that could not fail. When the requirement is that something stay
unknown, the question is never "did we send it" — it is "what can be computed from what we did
send," and that has to be pinned by a test that would go red if the answer changed.

**Rejected:** per-load jitter on the concession fractions (the derivation is in a public repo, so
it obfuscates rather than removes) · collapsing all rejections to one opaque code (loses the
internal diagnostics the trace exists for, when ordering the checks already closes the oracle) ·
rate-limiting failed booking attempts (treats the symptom; with the offer guard checked first
there is nothing left to probe).

### 20 — The trace sink is the transport seam
**2026-08-02** — Day 4

The interface had to stream a call to a browser without the agent loop learning that browsers
exist. `run.ts` commits to no streaming and no UI inside `runCall`, because Day 5 pushes
hundreds of adversarial turns through that same function and anything coupling conversation
policy to a transport makes that harder for no benefit.

The seam already existed and had been there since Day 3. `withTrace` funnels every tool call
through a `TraceSink`, and `runCall` writes the user turn and each assistant turn through the
same one. So the live view is a **second sink**, tee'd next to the durable one — one branch to
`run_events`, one to an HTTP response stream. `runCall` is not modified by Day 4 at all.

**A route handler, not a Server Action.** Next 16's own guide states actions are dispatched one
at a time per client and answer with a single Flight response carrying a return value plus a
re-rendered tree. That is a mutation primitive, not an event channel, and the guide points at a
route handler for this shape. `streamText` was the other option and was rejected for the reason
above: it would mean rewriting the loop around a transport.

**The cost, taken knowingly:** `generateText` resolves a step at a time, so the reply lands per
step rather than per token. The tool trace is what this project is arguing about, and it streams
live with real latencies — a 400ms FMCSA lookup and an 8ms cache hit look different on screen,
which is most of the difference between a demo and a mock.

**Ordering has two authorities and they are not the same one.** The live stream is ordered by
delivery; `run_events.seq` is the durable order. Both derive from the same call order. The
client numbers its own rows across the call rather than trusting the per-connection index — that
index restarts at zero every turn, so as a label it counted 1, 2, 1, 2 and as a React key it
collided outright.

**Sessions live in process memory, behind an interface, failing loudly.** `CallState` holds
`countersUsed`, `verifiedMcNumber` and `agreedByLoad` — it *is* the negotiation policy's memory —
and `messages` carries tool results forward. Neither may round-trip through the browser: a client
holding counters-used does not need prompt injection, it needs a text editor. That would hand #4,
#17 and #19 to the client.

A process-local `Map` is wrong on a platform with no instance affinity, and Day 7 deploys to one.
The trade is taken anyway because the failure is made **loud**: a missing session is a 409, never
a rebuilt `CallState`. Rebuilding one resets `countersUsed` to 0 and `hasClearedCarrier()` to
false — the three-counter cap quietly stops existing with nothing on any screen to say so. The
store has no method that constructs a session, so that path is not reachable from it. Day 7's fix
is a second `SessionStore` implementation over a `CallState` snapshot, not a rewrite.

**Tools are built per turn, and that was found live rather than in review.** `buildTools`
captures `deps.trace` at construction, so a tool set built at call start writes only to the sink
that existed then — the durable one. The first working version streamed the conversation and zero
tool calls: the entire right-hand pane, empty, with every test green. `state` is the object that
must survive between turns; the tool set is a closure over it and costs nothing to rebuild. The
rebuild is asserted not to disturb the cached prompt prefix — Anthropic renders tools → system →
messages and the breakpoint sits on the system block, so a rebuilt schema differing by one byte
would silently cost full price on every turn (#15).

**Rejected:** a Server Action returning a stream (sequential dispatch, and the response shape is
a re-render) · `streamText` inside `runCall` (couples policy to transport) · rehydrating
`CallState` by folding `run_events` (puts a second implementation of the gate on the
safety-critical path, where a drift is a wrong-allow) · round-tripping state through the client
(see above).

### 21 — A second audience is a second allowlist
**2026-08-02** — Day 4, extends #19

#19's generalisation is that an allowlist is a claim about representation, not information, so
the question at any boundary is what can be *computed* from what was sent. The interface added a
boundary: a server component serialising a load into a client component is every bit as much a
wire as a tool result.

So the broker's screen gets its own named projection, `toBrokerLoad`, rather than a spread row.
Its answer is deliberately **different** from the model's: the policy band is included. Floor,
market and ceiling are the brokerage's own data, and putting the ceiling on screen beside the
offers is the clearest statement the interface can make — the number sits there, unmoving, while
the agent negotiates without it.

Both allowlists are now checked against the `loads` table by the same test, so a new column has
to be decided about twice. That is the part worth having: the second boundary is the easy one to
forget, and forgetting it is how a "just render the board" change ships a column nobody reviewed.
The two shapes share no rate field names and use opposite casing, so a value shaped for one
reader cannot be handed to the other and `ceilingCents` greps to every place a human is shown the
walk-away.

The ceiling therefore reaches the ladder from the server render, **never from the event stream**.
Keeping those two channels separate is what lets `src/lib/call/wire.test.ts` assert the ceiling's
total absence from the wire, per load, in cents and in dollars.

Two things that test had to get right, both discovered by it failing first, and both worth
remembering because they are the same class of error #19 was about:

- **Scope per load.** Checked against one combined transcript it fails on coincidence — across 40
  lanes one load's market rate eventually equals another's ceiling, which discloses nothing.
- **Arguments are not results.** `withTrace` echoes `args` verbatim, so passing the ceiling in as
  a booking rate put it on the wire by our own hand. A model cannot send a number it does not
  have. `src/lib/tools/invariant.test.ts` had already learned this exact lesson.

**Not done:** a `toBrokerCarrier`. Carrier data reaches the browser through the verbatim trace
row, so a projection would be dead code. The carrier's phone number crossing to the broker's
screen is deliberate — they are on a call with that carrier — and is recorded here rather than
left implicit.

### 22 — A failed turn commits the steps that completed
**2026-08-02** — Day 4 review close-out

The turn route built `turnMessages` as a candidate and only assigned it to `session.messages` on
success, with a comment saying a failed turn leaves the session exactly as it was. That is true
of `messages` and false of everything else. Tools mutate `CallState` as they execute and write
their rows on the way past, so a `counter_offer` on step 2 followed by a failure on step 5 left
`countersUsedByLoad` at 1 with nothing in the history to show for it. The retry then had a model
that believed it was opening while the tool layer handed it rung 2 of `CONCESSION_SCHEDULE =
[0, 0.6, 1]`. Two failures and the carrier's first sentence gets the lane rate. The ceiling
invariant survives that; the claim that a negotiation happened does not.

**The fix does not roll `CallState` back**, and that direction was considered and rejected. It
mirrors effects already committed to Postgres — `counter_offer` wrote a `negotiations` row,
`book_load` wrote `covered` — so rewinding it would make the agent forget freight it had already
booked, which is a worse bug than the one being fixed. A snapshot per turn has the same problem
in slower motion: it makes the in-memory half of the world disagree with the durable half, and
the durable half is the one a dock is scheduled against.

So the other half moves instead. `runCall` accumulates each completed step's messages in
`onStepEnd` and, on failure, throws a `PartialTurnError` carrying them; the route commits those
rather than discarding them. Complete steps only, which is exactly what the callback fires for,
so a half-generated assistant turn is never persisted. A turn that failed before any step
finished carries nothing and the session really is untouched — that case is what the original
comment described, and it is now the only case it describes.

`runCall` stays headless: no HTTP, no session, model still an argument, and the eval calls it
unchanged. Day 5 needs that more than the interface does.

**A second bug fell out of it.** `runCall` returned `result.response.messages`, and
`GenerateTextResult.response` is a getter for `finalStep.response` in `ai@7.0.48`
(`node_modules/ai/dist/index.js:6148`) — so the history carried forward between turns was the
final step's messages alone, with every earlier step's tool call and tool result dropped. It was
invisible because `CallState` carries the parts that matter for policy and the agent simply
re-read what it had forgotten. The accumulator fixes it as a side effect; a test asserts the
tool traffic is present and goes red against the old expression.

A history that ends in tool results is resumable, which the fix depends on: `groupIntoBlocks` in
`@ai-sdk/anthropic` folds a `tool` message and the following `user` message into one user block,
so appending the next turn on top of a partial one converts cleanly.
