# Rewriting Gumroad in TypeScript, Prisma and Next.js

## What we are rewriting

Measured on `main` at `3240685d4`:

| Area | Files | Lines |
| --- | ---: | ---: |
| Models (`app/models`) | 431 | 52.7k |
| Controllers (`app/controllers`, 12.2k of it in `api/`) | 333 | 36.5k |
| Services (`app/services`) | 378 | 56.6k |
| Payments and sales tax (`app/business`) | 105 | 17.0k |
| Sidekiq jobs (`app/sidekiq`) | 303 | 20.2k |
| Presenters, mailers, views, helpers, policies, modules, lib | 768 | 48.4k |
| Specs (`spec`) | 2,559 | 585k |
| Database | 227 tables | 3.6k lines of `db/schema.rb` |
| Frontend (`app/javascript`, already TypeScript + React via Inertia) | 1,074 | 190k |

That is roughly 240k lines of Ruby to port, plus the behaviour its 585k lines of specs pin down. The
frontend is already TypeScript and React, so it is reused, not rewritten.

## What "1:1 identical" means here

A ported endpoint is identical when, for the same request and the same database state, it produces:

- the same status, redirect target, cookies and response body (JSON or Inertia page props),
- the same database writes, including `updated_at`, `flags` bits, `versions` rows (paper_trail) and soft-delete columns,
- the same jobs enqueued (class, args, queue, delay), emails sent and third-party calls made,
- the same external IDs, URLs and error messages.

It is explicitly **not** required to match: response timing, stack traces, framework-internal headers
(`X-Runtime`, `X-Request-Id` format), and log lines.

"Identical" is a claim we prove, not one we assert. See [Parity](#parity-how-we-prove-identical).

## Strategy: strangle, don't big-bang

A cut-over of 240k lines at once cannot be verified, so Next.js grows beside Rails and takes traffic
route by route:

```
                 ┌──────────── routing proxy (WS-04) ────────────┐
 request ──────► │ path in nextjs/routes.json && Flipper flag on? │
                 └───────┬─────────────────────────────┬─────────┘
                         │ yes                         │ no
                   Next.js app                    Rails app
                         │                             │
                         └─────── same MySQL, Redis, Elasticsearch, S3 ───────┘
```

1. **One database, Rails owns the schema.** Migrations stay in `db/migrate` until the last Rails
   route is gone. `nextjs/prisma/schema.prisma` is generated from `db/schema.rb` and CI fails on drift.
2. **Bridged session.** Next.js uses Auth.js, and accepts a Rails session by minting its own, so a user
   moves between the two apps mid-session without logging in again (WS-03).
3. **Bridged jobs.** Ported jobs run on BullMQ; jobs still in Ruby are enqueued from Node in Sidekiq's
   format, so job bodies are ported independently of the code that enqueues them (WS-05).
4. **Native pages.** Each Inertia page becomes an App Router page that loads its props on the server.
   A compatibility module for the Inertia hooks keeps the first conversion mechanical (WS-04).
5. **Flip per route, behind a flag.** Each route moves only after its parity checks pass, and flips back
   instantly by turning the flag off.
6. **Delete Rails last.** When no route, job or cron entry is left, Rails, Ruby and `db/migrate` go and
   Prisma Migrate takes over the schema.

## Architecture decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Location | `nextjs/` in this repo | The ported code must sit next to the Ruby it mirrors and the specs that define it; one PR can touch both. |
| Router | App Router: server components load page props; route handlers for JSON/API; server actions for form posts | Native Next.js, chosen over an Inertia adapter. The props each page receives must still match Rails'. |
| Field naming | Prisma fields stay `snake_case` | Props, API payloads and SQL are snake_case today; renaming would make every port a translation and every diff noisier. |
| Model names | Singular PascalCase of the table (`links` → `Link`) | Matches the ActiveRecord class names almost everywhere. |
| Relations | `relationMode = "prisma"`, no foreign keys | Matches the no-foreign-keys rule in CONTRIBUTING.md. |
| Callbacks and validations | Explicit model services (`server/models/<model>.ts`) called by every write | Prisma has no callbacks; hiding them in Prisma extensions makes bulk writes silently skip them. |
| Jobs | BullMQ for ported jobs; Sidekiq wire format for jobs still in Ruby | Typical Node stack, while `sidekiq-unique-jobs` locks keep working during coexistence. |
| Auth | Auth.js over the existing `users` table, with a Rails-session bridge | Devise bcrypt hashes verify as-is, so no password resets or forced logouts. |
| Database | MySQL, unchanged | Shared with Rails until removal; a database move would be its own project. |
| Integers | `BigInt` for `bigint` columns; never coerce money through floats | Cents columns and `flags` exceed 2^53 in places. |

## Parity: how we prove identical

Every workstream uses the same three tools (built in WS-01):

1. **Golden vectors for pure code.** Run the Ruby implementation on fixed inputs, commit its JSON output,
   test the TypeScript port against it. `nextjs/src/lib/obfuscate-ids.test.ts` is the reference example.
2. **Record/replay for endpoints.** Run a request spec against Rails with a recorder that captures the
   request, the DB diff, enqueued jobs and the response. Replay the same fixture state against Next.js and
   diff. The existing 585k lines of specs become the parity suite instead of being ported line by line.
3. **Shadow traffic before flipping.** In staging, mirror read-only (GET) traffic to Next.js and diff the
   responses; for writes, compare in a transaction that is rolled back.

Capybara system specs drive a real browser, so they run unchanged against the proxy host once a page is
ported. That makes them the cheapest end-to-end parity check we have.

## Phases

| Phase | Workstreams | Exit criteria |
| --- | --- | --- |
| 0. Foundation | WS-00 to WS-06 | Next.js can authenticate a Rails session, render an Inertia page, read and write any table through model services, and enqueue a Sidekiq job. |
| 1. Low-risk slices | WS-10 to WS-16 | Read-heavy routes flipped in production behind flags. |
| 2. Money | WS-20 to WS-23 | Checkout, charges, refunds, payouts flipped after a full shadow period. |
| 3. Jobs and cron | WS-30 | No Sidekiq job class left in Ruby. |
| 4. Removal | WS-40 | Rails deleted; Prisma Migrate owns the schema. |
| 5. Drop Inertia | WS-41 | No Inertia protocol, compat router or `app/javascript` left; pages are plain App Router React. |

Phase 0 runs mostly in sequence; phase 1 and 2 workstreams run in parallel worktrees. See
[workstreams.md](workstreams.md) for the briefs.

## After Rails: dropping Inertia

While both apps serve traffic, the Next.js pages speak Inertia on purpose. The page components in
`app/javascript` run unchanged in both apps (`@inertiajs/react` is aliased to `nextjs/src/lib/navigation`,
and `Routes.*` to `src/lib/navigation/routes.ts`). The `data-page` props are what the parity replays compare
byte for byte against Rails. A visit can also move between a Next page and a Rails page without the
client noticing. Removing Inertia earlier would break all three.

Phase 5 starts only once every route is served by Next and Rails is gone (phase 4):

- Pages become Server Components that receive their props directly. `InertiaShell`, `data-page`, the
  `/gr-inertia` endpoint and the X-Inertia headers go away.
- `router.visit`/`reload` and partial reloads become `next/navigation` (`useRouter`, `router.refresh()`).
- `useForm` and Inertia mutations become Server Actions or plain `fetch`, and validation errors are returned
  directly instead of through the session.
- Deferred, scroll and merge props (`lazy-props.ts`) become Suspense boundaries and streamed data.
- `routes.ts` (Rails' js-routes helpers) is replaced by Next's typed routes.
- The components move from `app/javascript` into `nextjs/src`, and the compat layer, the routes
  auto-import loader and the `sharedPackages` aliases are deleted.

Parity stops being the guide for this phase. Each page is covered by end-to-end tests of what a user sees
and can do, written before its Inertia plumbing is removed.

## Out of scope

- `app/services/onetime` (6.3k lines): one-off backfills that already ran. Port one only if it must run again.
- Shared frontend components, beyond what React 19 or Next.js requires.
- Redesigns, refactors or bug fixes. A port that changes behaviour is a bug in the port; file real bugs separately and fix them in Rails first so both apps stay identical.

## Status

- [x] WS-00 Scaffold: `nextjs/` app, Prisma schema generated for all 227 tables and validated.
- [x] External IDs (`ObfuscateIds`) ported, with Ruby golden vectors (43 passing tests).
- [x] `flag_shih_tzu` flags ported (`nextjs/src/lib/flags.ts`); needs golden SQL tests in WS-02.
- [x] Phase 0 (WS-00 to WS-06).
- [ ] Phases 1 to 3 are in progress at once: pages from every phase-1 stream except WS-18, API routes from
  WS-17 (merged, not flipped), the
  read side of WS-20 and WS-23, and job bodies for WS-30. Nothing is flipped in production. Per-stream
  state: [workstreams.md](workstreams.md#execution-log-branches-against-planned-streams).
