# State

**Read this second, every session.** Rewritten at the end of each session.

---

## Where we are

Branch: `main` · **Day 2 of 7 COMPLETE** · `pnpm test` 171 green, offline · typecheck + lint clean

Day 2 went through a full pre-landing review (PR #1). Eight defects found and fixed,
including two wrong-allows — see `DECISIONS.md` #13 and #14 for the general rules that
came out of it. Three items were deliberately deferred; they are listed under
**Blocked / open** and the first one matters before the demo.

## Done — Day 2

- [x] Vitest 4.1.10 wired. `pnpm test` / `pnpm test:watch`. Config is `vitest.config.mts`
      (`.ts` triggers a Vite forward-compat warning).
- [x] `src/test/setup.ts` replaces global `fetch` with one that throws — "no network in
      tests" is now mechanical, not a convention.
- [x] `CarrierDataSource` + normalized `CarrierRecord` (`src/lib/carriers/types.ts`)
- [x] `SocrataCarrierSource` — keyless, live, deterministic multi-row resolution
- [x] `evaluateCompliance()` — pure, 11 rules, `allow | flag | block`
- [x] Read-through cache + `DrizzleCacheStore` into `carrier_lookup_cache`
- [x] `QCMobileCarrierSource` behind the same interface, fixture-driven until the WebKey lands
- [x] Cross-source contract test: any field the two sources disagree on must be explained
      by a declared capability
- [x] Live verified end to end via `pnpm carrier:lookup <MC>`; 7 rows in `carrier_lookup_cache`

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

**LB 168 INC is the demo carrier for contract beat #2.** Entity still Active, 55 trucks,
authority Inactive, prior revocation on file — a company that looks alive and cannot legally
take the load.

## Next command

**Start Day 3 — agent core + eval skeleton.** Per `PLAN.md`:

1. Headless tool-calling loop (Vercel AI SDK + Anthropic). `ANTHROPIC_API_KEY` is still empty
   in `.env.local` — **this is now blocking.**
2. Tools: `lookup_carrier`, `get_load`, `check_compliance`, `counter_offer`, `book_load`,
   `escalate_to_human`, `end_call`.
   - `lookup_carrier` wraps `readThrough(mc, source, store)` and `evaluateLookup(result)` —
     both already built and tested. It should also cross-check the DOT the caller *claims*
     against `record.dotNumber`; an MC↔DOT mismatch is a known fraud technique and the
     record already carries what's needed.
3. Negotiation policy in the tool layer — floor/ceiling/max-counters in code, never the prompt.
4. Full trace to `run_events`.
5. Walking-skeleton eval: one persona, one judge call, one printed score. Ugly is fine.

## Blocked / open

- **`ANTHROPIC_API_KEY` is empty in `.env.local` — blocks Day 3.**

### Deferred from the Day 2 review — do these before the demo

1. **No timeout on any outbound fetch.** `socrata.ts` and `qcmobile.ts` both call
   `fetch` with no `AbortSignal`. Node's undici defaults are ~300s, so a hung
   government API stalls a live carrier call for five minutes with a driver on the
   phone. QCMobile is worse — two sequential calls, so double that. Flagged
   independently by three reviewers. Needs a deliberate budget (5–8s) **and** a
   policy decision: on timeout, prefer a stale cache entry over blocking?
2. **A skeleton payload still returns `allow`.** A near-empty Socrata row normalizes
   to `legalName: "Unknown"` with every field null. It now carries
   `OOS_NOT_VERIFIED` + `FOR_HIRE_NOT_VERIFIED` so it is no longer silent, but the
   decision is unchanged. The systemic fix — an `INSUFFICIENT_DATA` block above N
   unknown fields — was scoped out on purpose.
3. **`NEW_AUTHORITY` measures the wrong date.** It reads `add_date` (when the entity
   entered the census), not when the docket was granted. It therefore misses the
   reactivated-dormant-DOT chameleon, which is the adversarial case the rule exists
   to catch. Check whether the census file exposes a docket-grant date at all; if it
   does not, say so rather than running the check on a proxy that misses the case
   that matters.

Also open: **no CI.** There is no workflow, so nothing runs `pnpm test` on a PR.
- FMCSA WebKey not obtained (Login.gov, ~5 min). Not blocking: `QCMobileCarrierSource` is
  written and contract-tested, only its network path is dark. When the key lands, record real
  payloads, delete the three `*.derived.json` files, and `OUT_OF_SERVICE` goes live unchanged.
- Not yet wired: looked-up carriers are not written into the `carriers` table. That belongs
  to Day 3, when a `run` exists to attach them to.

## Notes for the next session

- **`docket1_status_code` is the authority signal, not `status_code`.** They disagree
  constantly. Getting this backwards would clear LB 168 INC.
- **MC numbers are not unique.** 1000+ are duplicated. `resolveCandidates()` sorts on active
  docket → active entity → freshest MCS-150 → lowest DOT. Never index into `rows[0]`.
- **Every Socrata numeric column is `text` and SoQL compares it lexically** —
  `power_units < '100'` is false for `'20'`. Never filter numerically in the query.
- **Cargo columns use `"X"`, not `"Y"`.** `parseYesNo` deliberately rejects `"X"`.
- Socrata: not-found is `[]` with **HTTP 200**; a bad query is **HTTP 400**. Different
  outcomes, different handling — see `LookupResult`.
- Neon intermittently exceeds undici's connect timeout from this machine. `readThrough`
  now degrades to a live lookup on cache failure rather than crashing; regression tests cover
  both read and write failure. If `pnpm carrier:lookup` errors, just retry.
- Compliance takes an injected `now`. Never let it read the system clock in a test — this
  machine's clock runs ~2.5 days slow.
- `pnpm db:push` needs `--force` (config has `strict: true`).
- `drizzle.config.ts`, `src/db/seed.ts`, and both `scripts/*.ts` load `.env.local` explicitly.
  Plain `dotenv/config` reads `.env` and silently fails here.
- Carriers are still deliberately **not** seeded. Every carrier comes from a real FMCSA lookup.
