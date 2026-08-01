# State

**Read this second, every session.** Rewritten at the end of each session.

---

## Where we are

Branch: `main` · **Day 1 of 7 COMPLETE** · typecheck clean · `/loads` verified rendering

## Done — Day 1

- [x] Next.js 16.2.12 + React 19 + TS + Tailwind 4, pnpm
- [x] Deps: drizzle-orm 0.45, @neondatabase/serverless, zod 4, drizzle-kit, tsx, dotenv
- [x] Context system (`CLAUDE.md`, `docs/PLAN.md`, `DECISIONS.md`, `docs/pitch/`, this file)
- [x] Company-neutral — `src/` names no employer; pitch lives in `docs/pitch/<company>.md`
- [x] Drizzle schema — 7 tables in `src/db/schema.ts`
- [x] Neon connected (`carrier-desk` project), schema pushed, all indexes + FKs applied
- [x] Seeded 40 real lanes. Verified: Laredo→Chicago $2,659 @ $1.93/mi;
      Memphis→Dallas $1,053 @ $2.24/mi; board total $38,552
- [x] `/loads` renders from the DB, 200 in ~230ms, `/` redirects to it

## Next command

**Start Day 2 — carrier data + compliance gate.** Build in this order:

1. `src/lib/carriers/types.ts` — the `CarrierDataSource` interface plus a normalized
   `CarrierRecord` shape (mcNumber, dotNumber, legalName, dbaName, phone,
   authorityStatus, isOutOfService, safetyRating, powerUnits). Both sources must
   normalize into this; compliance logic never sees a raw provider payload.
2. `src/lib/carriers/socrata.ts` — keyless. Socrata dataset `az4n-8mr2` on
   `data.transportation.gov`. No auth needed; `SOCRATA_APP_TOKEN` only raises rate limits.
3. `src/lib/carriers/cache.ts` — read-through cache into `carrier_lookup_cache`
   (unique on `mc_number` + `source`). **The demo must never depend on a live gov API.**
4. `src/lib/carriers/compliance.ts` — `evaluateCompliance(record): { decision, reasons[] }`
   where decision is `allow | flag | block`. Pure function, no I/O, trivially unit-testable.
5. Fixture set: a known-good active carrier, a revoked-authority carrier, an
   out-of-service carrier, and a nonexistent MC. Pull these from **real** lookups and
   record the MC numbers here in STATE so the demo is reproducible.

`QCMobileCarrierSource` slots in behind the same interface once the FMCSA WebKey lands —
it adds `/authority`, `/oos`, and `/basics`, which is a richer gate. Not blocking.

## Blocked / open

- Nothing blocking Day 2.
- `ANTHROPIC_API_KEY` is still empty in `.env.local` — needed for **Day 3**, not Day 2.
- FMCSA WebKey not yet obtained (Login.gov, ~5 min). Upgrade, not a dependency.

## Notes for the next session

- Two amendments logged in `PLAN.md`. **The eval skeleton is Day 3, not Day 5.**
- Rate direction: we are the broker *buying* capacity. `booked <= ceiling` is the hard
  invariant; floor is only the opening anchor. See `DECISIONS.md` #8.
- Carriers are deliberately **not** seeded — every carrier in this system comes from a real
  FMCSA lookup. Don't invent carrier identities; it defeats the entire thesis.
- `drizzle.config.ts` and `src/db/seed.ts` both load `.env.local` explicitly.
  Plain `dotenv/config` reads `.env` and will silently fail here.
- `pnpm db:push` needs `--force` (config has `strict: true`), i.e. `pnpm exec drizzle-kit push --force`.
- `pnpm` warns it skipped the esbuild build script. Benign — drizzle-kit 0.31.10 runs fine.
- Next 16 bundled docs live in `node_modules/next/dist/docs/`. Server Component +
  ORM-direct data fetching is confirmed correct for this version.
- Machine clock runs ~2.5 days slow, so seeded pickup dates are relative to that. Harmless
  and self-consistent; don't "fix" it.
