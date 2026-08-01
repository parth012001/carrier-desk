# State

**Read this second, every session.** Rewritten at the end of each session.

---

## Where we are

Branch: `main` · Day 1 of 7 · typecheck clean · **blocked on `DATABASE_URL`**

## Done

- [x] Next.js 16.2.12 + React 19 + TS + Tailwind 4, pnpm
- [x] Deps: drizzle-orm 0.45, @neondatabase/serverless, zod 4, drizzle-kit, tsx, dotenv
- [x] Context system (`CLAUDE.md`, `docs/PLAN.md`, `DECISIONS.md`, `INTERVIEW.md`, this file)
- [x] Drizzle schema — 7 tables in `src/db/schema.ts`
- [x] `src/db/index.ts` (neon-http client), `drizzle.config.ts`, `.env.example`
- [x] Seed script — 40 real lanes in `src/db/seed.ts`
- [x] `/loads` board at `src/app/loads/page.tsx`, `/` redirects to it
- [ ] Neon connected + schema pushed + seed run  ← **BLOCKED, see below**

## Next command

1. Put a Neon connection string in `.env.local` as `DATABASE_URL`
2. `pnpm db:push` — expect 7 tables created
3. `pnpm db:seed` — expect "Seeded 40 loads." plus cheapest/priciest lines
4. `pnpm dev` → open `/loads`, confirm 40 rows render with sane $/mi
   (dry van long-haul should land near $1.90–2.20/mi; short hauls higher)

Then Day 1 is closed and **Day 2 is the `CarrierDataSource` interface** — start with
`SocrataCarrierSource` (no key needed) against dataset `az4n-8mr2` on
data.transportation.gov. `QCMobileCarrierSource` swaps in behind the same interface
whenever the FMCSA WebKey arrives.

## Blocked / open

- **`DATABASE_URL` not set.** Everything else in Day 1 is written and typechecks; only
  `db:push` and `db:seed` need it. Neon project not yet provisioned.
- FMCSA WebKey not yet obtained (Login.gov, ~5 min). Not blocking anything — Day 2 runs on
  the keyless Socrata source by design (`DECISIONS.md` #5).

## Notes for the next session

- Two amendments already logged in `PLAN.md`. **The eval skeleton is on Day 3, not Day 5.**
- Rate direction was corrected mid-session — we are the broker *buying* capacity, so the
  hard invariant is `booked <= ceiling`, never "above floor." See `DECISIONS.md` #8.
- Carriers are deliberately **not** seeded. They get created from real FMCSA lookups on
  Day 2 — no invented carrier identities anywhere in this project.
- `pnpm` reports skipping the esbuild build script. It is benign; `drizzle-kit` v0.31.10
  runs fine. Don't spend time on it.
- Next 16 differs from older App Router conventions. Bundled docs are in
  `node_modules/next/dist/docs/` — `AGENTS.md` points there. Data fetching in a Server
  Component with the ORM directly is confirmed correct for this version.
