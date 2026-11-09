# Workstreams

Each workstream is sized for one worktree and one owner (person or agent). Read
[README.md](README.md) first: the parity rules there apply to every stream.

## Picking one up

```bash
git fetch origin
git worktree add ../gumroad-ws-12 -b nextjs/ws-12-products origin/nextjs-rewrite
cd ../gumroad-ws-12/nextjs && npm install && cp .env.example .env
```

Then:

1. Check the stream's **Depends on**. Do not start until those are merged into `nextjs-rewrite`.
2. Port Ruby file by file, keeping a mapping comment at the top of each TypeScript file
   (`// Port of app/services/foo/bar.rb`). Reviewers diff the two side by side.
3. Prove parity with the WS-01 tools. A port without a parity check is not done.
4. Open the PR against `nextjs-rewrite`, not `main`, and tick the stream in the README status list.
5. Keep PRs near 100 lines of logic where possible (CONTRIBUTING.md); a stream is many PRs.

**Shared contracts:** `nextjs/src/server/auth/context.ts`, `server/jobs/enqueue.ts` and
`server/infra/config.ts` are committed as typed stubs. Their owners (WS-03, WS-05, WS-06) implement them
without changing the signatures; everyone else imports them as if they already work.

**Collision rule:** a stream owns the directories listed under **Owns**. Anything outside them that
needs to change (a shared model service, the navigation compat module) goes in its own small PR to
`nextjs-rewrite` first, so two streams never edit the same file in parallel.

## Execution log: branches against planned streams

After phase 0, the work ran in waves of agent worktrees numbered by wave (`nextjs/ws-30b` … `nextjs/ws-85`).
Those numbers are batch ids, not the stream ids below: `nextjs/ws-40-html-helpers-mailers` has nothing to do
with WS-40 Removal, and `nextjs/ws-83-discover` is part of WS-14. New branches use the planned stream id with
a letter suffix (`nextjs/ws-12d-bundle-edit`). This table maps every merged branch to its stream.

| Planned stream | Merged branches (`nextjs/ws-…`) | State |
| --- | --- | --- |
| WS-00 … WS-06 Foundation | 01, 02, 03, 04, 05, 06, 38 (query cache), 43 (page envelope), 50 (signed-in shared props), 55 (page spec options), 00c (lint baseline) | Done ESLint profile for `nextjs/` and per-rule violation counts in `lint-baseline.json` that may not grow (`npm run lint:baseline`). |
| WS-10 Settings and account | 10a, 10b (OAuth integrations), 53, 54 (auth pages), 56, 62 (payments, profile), 10c (billing; login, logout, two-factor, password reset, confirmations and review-reminder links), 10d (team members, AI promo dismissal) | Most pages; billing, third-party analytics, advanced, team member role/remove/restore and the AI promo dismissal write in Node. Profile, main settings, password and team invitations stay in Rails (avatar and sections, reconfirmation, bcrypt and sessions, mail parsing and throttling) |
| WS-11 Help center, pages, blog, profiles | 11, 55, 64, 68, 84 (profile products), 11b (wishlist follower and product writes, unsubscribe link, UTM link writes and `/u/:permalink`, post views), 11c (seller reputation summary) | Profiles with featured products or wishlists hand back |
| WS-12 Products and bundles | 12a, 12b (reviews, offers, affiliates), 12c (editor JSON endpoints, duplicates, build history), 39 (link writes), 69, 71, 77, 80, 12f, 12g, 12h, 12j (bundle editors) | Product page partly rendered; editor for plain digital products only, now including tags, other-product refund policies and plain versions with their categories, SKU-enabled products, and recoverable hidden version pages via a port of `RichContent#has_editor_content?` (membership tiers and recurrence prices, integrations on versions, files still hand back); `GET /bundles/:id` redirect ported (301 to the product editor); bundle editors Product and Share for plain bundles (Content still in Rails), `create_from_email` and bundle writes still in Rails Bundle Product and Share editors (`nextjs_bundle_editor`) for plain bundles of unversioned products; anything else hands back, and `Bundles::ContentController#edit` stays in Rails. No Rails parity fixture yet. |
| WS-13 Audience, emails, workflows | 51, 57, 59, 63, 67, 74, 82; mailers 31, 35, 40, 60, 73, 76, 85, 13d, 13e (post and workflow email files) | Pages and their mutations; receipt mailer for common shapes, plus rentals with a plain url_redirect (proven against the Ruby golden). Rental redirects, gift sender, free trial and subscription receipts, and preorders still hand back Posts and workflow emails with attached files are served; files with thumbnails, and subtitles missing from S3, still throw `NotPortedError`. |
| WS-14 Discover and search | 34, 37, 65, 83, 14c, 14d | Discover page; deferred-only requests, autocomplete, `recommended_wishlists` (signed out) and `recently_viewed` (flag fully on) run in Node. Signed-in `recommended_wishlists`, `recently_viewed` mid-ramp, the root page's random `recommended_products`, curated products and the Black Friday page hand back |
| WS-15 Analytics and exports | 58, 70, 79, 84, 15c, 15d | Dashboards, customers, analytics; exports: CSV builders, CSV-safe writer and enqueue calls ported (ws-15b), job bodies and DB reads stay with WS-30/WS-45; customers page: filters on `/customers/paged`, refunds, sent gifts and non-USD prices in Node, while members, preorders, physical products, Skus, tiers, UTM links, commissions and collaborator sales that also credit a direct affiliate hand back; gift receivers, bundle purchases, cached offer code discounts, affiliate sales, upsell names and options of a plain product run in Node |
| WS-16 Library and content delivery | 61, 81, 16b (download page, URL redirect deliveries and mutations), 16c (delivery routes), 16d (library handbacks) | Library and unavailable pages; `/d/:id` gate, redirects and visit writes in Node, rendering only for a content page that lists nothing (files, rich content, variants, posts, integrations, licenses, polls hand back); `/r`, `/s`, `/zip`, `/read`, `/d/:id/play`, HLS, smil and caption routes and mobile stream/hls_playlist/download run the access gate in Node. Past the gate, `/r/:id`, `/r/:id/product_files`, `/zip/:id`, smil, HLS playlist, subtitle downloads and `/media_urls` issue signed S3 redirects and write consumption events and use counts in Node (16b; signed-URL bytes unproven against Rails); `stream`, `read`, `play` and `captions.vtt` still hand back past the gate. `send_to_kindle` is native only for signed-out requests. Library serves memberships that still grant access, installment plans and bundle member rows; the subscriptions tab, refunded subscription rows and bundle filters with a download page hand back. The two new parity cases have no recorded fixtures. |
| WS-17 Public API and mobile API | 17a (products), 17b (sales, licenses), 17c (users, content, MCP), 17d (`Api::Internal`), 17f (mobile), 17g (v2 sales reads and subscribers), 17h (mobile purchases and sales), 17i (mobile serializers), 17k (mobile products, subscriptions, preorders, installments), 17l (v2 route audit) | v2 routes served through the shared dispatcher; `Api::Internal` GETs go through one handler. Mobile sales index serializes USD sales natively; purchases index/search/show, sales show and all writes still hand back; mobile products index and the subscription attributes read (USD, seller with no posts) are native, while preorder and installment payloads, products destroy, subscription cancel, sessions and commissions stay in Rails (`UrlRedirect#product_json_data`, `Preorder#mobile_json_data`, subscriptions and non-USD are not ported). 17e is counted under WS-18. `docs/nextjs-rewrite/api-coverage.md` is generated by `scripts/api-coverage.ts` and a test fails on drift; `GET /mobile/agent/meta` is served (`nextjs_mobile_agent_meta`). |
| WS-18 Admin | 17e (internal admin API, `Admin::BaseController` entry points) | Done in code; admin web UI was already deleted. Sidekiq and Flipper UI mounts stay in Rails until WS-40. The `impersonates a suspended seller` case in `spec/requests/admin/impersonate_spec.rb` has no recorded fixture yet. |
| WS-19 AI, MCP and moderation | 75 (agent page), 19a (content moderation logic), 19b (MCP protocol), 19c (AI service helpers), 19d (moderation extractor) | Agent page; MCP JSON-RPC envelope, revision negotiation, `tools/list` and tool argument checks. Tool bodies, OAuth client registration and `ProductFileIngest` hand back to Rails; moderation decisions in `server/content-moderation` with injected OpenAI, DB and enqueue seams, not wired to any route (content extractor HTML/CSS/SVG parsing and Rails golden vectors still to do); AI: store-agent formatter, scopes, HTML undo and prompts only, no LLM client or agent loop `ContentExtractor` page parity: `extractFromPost`, `extractFromProduct` and `extractFromPage`; ActiveStorage lookups and page sanitizers are still injected by the caller. |
| WS-20 Checkout and orders | 48 (offer-code pricing), 72 (subscription access), 78, 20a (checkout reads) | Empty-cart checkout only; no purchase path `GET /offer_codes/compute_discount` (`nextjs_checkout_offer_codes`) with hand-backs for existing-customer, tiered, once-per-cart, option-limited and cross-sell carts; surcharge arithmetic in `server/tax/customer-surcharge.ts` is not routed yet. |
| WS-21 Payment processors | 33 (Stripe client), 49 (refunds, disputes), 66 | Job guards; processor calls hand back |
| WS-22 Sales tax and VAT | 22 (pure calculation) | Receipt tax lines (85); US zip to state, tax country lists, offline regional VAT id shape checks and tax-cents rounding in `server/tax/`. TaxJar, `ZipTaxRate` selection, GeoIP and vendor VAT validators (VIES, Vatstack, IRAS, Revenu Quebec) hand back. |
| WS-23 Balances and payouts | 72 (payouts page), 74 (balance stats), 23b (chargeback reserve) | Read side; no payout execution. The chargeback-rate reserve is computed in Node; daily frequency, US sellers with a completed payout (Stripe instant eligibility), cached stats for large sellers, PayPal Connect and non-USD still hand back |
| WS-30 Jobs and cron | 30b, 30c, 32, 36, 41, 42, 44, 45, 46, 47, 49, 52, 59, 63, 66, 74, 76 | Many jobs in Node, most with early hand-backs; `CreateMissingPurchaseEventsWorker` now runs fully in Node. Mail, Stripe/PayPal and money-ledger jobs hand back by design |
| WS-40 Removal | — | Not started |

No route is flipped in production yet and no shadow traffic has run, so no stream has met its done
criteria; "state" above is what is ported and proven by replay or golden.

### Open items

Known gaps a branch left on purpose. Each still hands back to Rails (or throws `NotPortedError`) until closed.

- **Product file thumbnails** (`ProductFile#as_json`, `thumbnail`): needs the ActiveStorage `signed_id` (check the verifier name and purpose
  `server/auth/message-verifier.ts` would need) and the URL: `cdn_url_for(thumbnail.url)` for a browser-renderable image, the cached
  `thumbnail_variant.url` (`Rails.cache`) for a video. Images do not need the variant, so they can go first. Only provable against a Ruby golden.
- **Subtitle whose S3 object is missing**: Ruby retries the key under another Unicode normalization (`S3KeyUnicodeNormalization`) before it
  gives up and drops the subtitle. `signedDownloadUrlForS3KeyAndFilename` has no retry, so the case hands back.
- **`POST /customer_surcharge`** (WS-20a): only the arithmetic is in `tax/customer-surcharge.ts`. The endpoint also needs `BuyerCurrencyQuote`
  (Stripe FX quotes), `DirectListedAmountToken`, `PaymentMethodListToken` and GeoIP currency detection. A first cut could serve the cart with no
  buyer-local-currency seller and hand back the rest.

## Dependency graph

```
WS-00 ─┬─ WS-01 parity harness ──────────┐
       ├─ WS-02 model layer ─────────────┤   all six run in parallel; they meet
       ├─ WS-03 Auth.js + Rails bridge ──┤   at the stubs in nextjs/src/server
       ├─ WS-04 App Router shell + proxy ┤   (auth/context.ts, jobs/enqueue.ts,
       ├─ WS-05 BullMQ + Sidekiq bridge ─┤    infra/config.ts)
       └─ WS-06 infra ───────────────────┘
                         │
          Phase 1: WS-10 … WS-19 (parallel) ─► Phase 2: WS-20 … WS-23
                         │                              │
                         └──────────► WS-30 jobs ──► WS-40 removal
```

---

## Phase 0: foundation

### WS-00 Scaffold (done)

`nextjs/` app, generated `prisma/schema.prisma`, `src/lib/obfuscate-ids.ts`, `src/lib/flags.ts`.
Remaining: add `npm run prisma:check-drift` to CI so a Rails migration without a regenerated Prisma
schema fails the build.

### WS-01 Parity harness

- **Depends on:** WS-00
- **Owns:** `nextjs/parity/`, `spec/support/parity/`
- **Build:**
  - A golden-vector helper: `bin/golden <ruby-file> <inputs.json>` that runs a pure Ruby method and writes JSON fixtures (generalise `obfuscate-ids.golden.json`).
  - An RSpec recorder (opt-in metadata `parity: true`) that captures request, response, DB row diff per table, Sidekiq jobs pushed, mails delivered and WebMock/VCR calls into `nextjs/parity/fixtures/<spec>.json`.
  - A Vitest runner that loads the same DB state, sends the request to Next.js and diffs every captured channel, with a normaliser for timestamps and auto-increment IDs.
  - A shadow-diff mode for the proxy (WS-04) that logs mismatches to Honeybadger Insights.
- **Done when:** one existing request spec (suggest `spec/requests/health_check_spec.rb` or similar) records and replays green against a Next.js route.

### WS-02 Model layer

- **Depends on:** WS-00
- **Owns:** `nextjs/src/server/models/`, `nextjs/prisma/relations/`, `nextjs/scripts/`
- **Build:**
  - Relations: a Rails runner script that dumps every `reflect_on_all_associations` (including polymorphic, `through`, scopes and `foreign_key` overrides) to JSON, and a generator that turns it into Prisma relation fields. The schema generator merges them.
  - Model-name corrections where the singularised table name differs from the Ruby class (e.g. `prices`, `user_compliance_info`, `signup_events`).
  - Ports of the cross-cutting concerns, each with golden vectors: soft delete (`Deletable`, `deleted_at` scopes), `paper_trail` (31 models write `versions` rows), YAML/JSON `serialize` columns (8; YAML must round-trip byte-identical), `strongbox` encrypted columns, `state_machines` (22 models), `money` formatting, `friendly_id` slugs, `ancestry`/`closure_tree`, `active_hash` constants, ActiveStorage attachment reads.
  - The model-service convention: `server/models/<model>.ts` exporting `create`, `update`, `destroy` that run validations and callbacks in Rails order (286 callbacks across models; `after_commit` runs after the transaction).
  - Golden SQL tests for `flags.ts` against `Model.<flag>_condition` and `set_flag_sql`.
- **Done when:** `User`, `Link`, `Purchase` and `Subscription` have model services whose writes match Rails' DB diff under WS-01 replay.

### WS-03 Auth.js and the Rails session bridge

- **Depends on:** WS-00 (codes against the generated `User` model; WS-02 services replace direct Prisma calls later)
- **Owns:** `nextjs/src/server/auth/`, `nextjs/src/server/policies/`, `nextjs/src/app/api/auth/`
- **Build:**
  - Auth.js (v5) over the existing `users` table: a credentials provider that checks Devise's bcrypt `encrypted_password` (same pepper and stretches, so no password resets), lockout and confirmable rules, `devise-pwned_password`; OAuth providers Google, Apple, Twitter and Stripe Connect mapped onto the existing identity columns.
  - The Rails bridge: decrypt the Rails cookie-store session (`config/initializers/session_store.rb`: AES-256-GCM from `secret_key_base`, plus the SHA1 rotation in `cookie_rotator.rb`), and mint an Auth.js session for its Warden user, so someone logged in on Rails is logged in on Next.js. Logout in Next.js clears both cookies. Login stays on Rails until WS-10 moves it.
  - `getRequestContext()` in `server/auth/context.ts` (stub committed): logged-in user, current seller (team switching), impersonation.
  - Two-factor (`active_model_otp`), WebAuthn, Doorkeeper-compatible OAuth bearer tokens for the public API, and Pundit policies (70 files) as plain functions.
- **Done when:** a user logged in via Rails is recognised by Next.js without logging in again, and logging out of Next.js logs them out of Rails.

### WS-04 App Router shell, navigation compat and routing proxy

- **Depends on:** WS-00 (uses the `getRequestContext()` stub until WS-03 lands)
- **Owns:** `nextjs/src/app/(app)/layout.tsx`, `nextjs/src/lib/navigation/`, `nextjs/src/server/page-props/`, `nextjs/routes.json`, `nextjs/src/middleware.ts`
- **Build:**
  - The conversion pattern for the 143 Inertia pages: `page.tsx` is a server component that loads data through ported presenters and renders the page component with the same props. Converted pages are copied into `nextjs/src/app/**` (Rails still serves the original until the route flips); shared components are imported from `app/javascript/components` through the `$app` alias.
  - `@/lib/navigation`: drop-in replacements for the Inertia APIs the pages use (`usePage` 121 imports, `useForm` 43, `router` 54, `Link` 49, `Head`, `Deferred`) built on `next/navigation`, `next/link` and server actions, so converting a page is a mechanical import swap first and an idiomatic refactor second.
  - Shared layout data now provided by `ApplicationController`/`inertia_share` (current user, seller, flash, feature flags, CSRF meta) as a server-side loader.
  - The routing proxy (middleware): `routes.json` lists converted routes, each gated by a Flipper flag; everything else is rewritten to Rails. Port the `js-routes` helpers, subdomain and seller custom-domain routing, and the `constraints` blocks in `config/routes.rb`.
  - Check that `app/javascript/components` builds under React 19 and Next's compiler (the Rails app is on React 18); list incompatibilities rather than fixing them in shared files.
- **Done when:** one real page (suggest a settings page or the help center) is served natively by Next.js behind a flag with the same rendered output and props as Rails.

### WS-05 Jobs: BullMQ plus a Sidekiq bridge

- **Depends on:** WS-00
- **Owns:** `nextjs/src/server/jobs/`, `nextjs/src/worker/`
- **Build:**
  - `enqueue()` in `server/jobs/enqueue.ts` (stub committed) routes by a registry generated from `app/sidekiq`: jobs already ported run on BullMQ; jobs still in Ruby are pushed to Redis in Sidekiq's wire format (`class`, `args`, `queue`, `retry`, `at`, `jid`) honouring `sidekiq-unique-jobs` digests so Ruby and Node agree on uniqueness.
  - The BullMQ worker process, queues mirroring `critical`/`default`/`low` (and `exports`, `long`), retry and dedupe semantics matching the Sidekiq options of each job, and repeatable jobs for `sidekiq-cron` entries.
  - The reverse direction: how Rails enqueues a job that now lives in Node (a small Ruby client that writes BullMQ jobs, or an internal endpoint). Pick one and document why.
- **Done when:** Node enqueues a Ruby job that Sidekiq runs (deduplicated against the same job from Ruby), and one trivial job (pick a `low` one) runs on BullMQ end to end.

### WS-06 Infrastructure adapters

- **Depends on:** WS-00
- **Owns:** `nextjs/src/server/infra/`
- **Build:** typed clients matching current Ruby configuration for `GlobalConfig`/env, Redis (with the same namespaces), Elasticsearch (same indices, mappings and query DSL builders), S3 and CloudFront signed URLs, mail delivery (Resend, SendGrid, SES) with `premailer` inlining parity, Flipper reads, Sentry/Honeybadger, rack-attack equivalent rate limits, `secure_headers` CSP, `http_accept_language`, MaxMind GeoIP, `ssrf_filter`.
- **Done when:** each adapter has a smoke test against the dev stack (`docker/`) and a parity test where Ruby builds a request (ES query, signed URL, CSP header).

---

## Phase 1: low-risk slices (parallel)

Every slice ports its controllers, presenters, services, policies, mailers and jobs **enqueue calls**
(not job bodies; those are WS-30), and flips routes behind flags. Each slice's done criteria: WS-01
replay green for every request spec in the listed spec directories, system specs green against the proxy,
and a week of shadow traffic with no unexplained diffs.

| Stream | Scope (Ruby) | Specs that define it | Notes |
| --- | --- | --- | --- |
| **WS-10 Settings and account** | `controllers/settings` (2.1k), `users_controller`, `user/`, two-factor, logins | `spec/requests/settings`, `spec/controllers/settings` | Good first slice: many pages, little money. |
| **WS-11 Help center, pages, blog, public profiles** | `help_center/`, `pages_controller`, `users/`, `GumroadBlog`, `Public` pages | matching request/system specs | Mostly reads; exercises custom-domain routing. |
| **WS-12 Products and bundles** | `links_controller` (2.4k), `products/`, `bundles/`, `services/product` (2.6k), presenters | `spec/controllers/links_controller_*_spec.rb`, `spec/requests/products` | Largest single controller; split by action into several PRs. |
| **WS-13 Audience, emails, workflows** | followers, installments, workflows, audience filters, `customer_mailer` | audience/workflow specs | Heavy on jobs; depends on WS-05. |
| **WS-14 Discover and search** | `discover_controller`, search services, ES models | discover specs | Depends on WS-06 ES adapter; queries must match byte for byte. |
| **WS-15 Analytics and exports** | `creator_analytics` (1.7k), `exports` (1.5k), reports | analytics specs | Read-only; good shadow-traffic candidate. |
| **WS-16 Library and content delivery** | `url_redirects_controller`, library, streaming, PDF/EPUB stamping, `cdn_deletable` | url_redirect specs | Signed URLs and file stamping need golden vectors. |
| **WS-17 Public API and mobile API** | `controllers/api` (12.2k), Doorkeeper scopes, `v2`, `mobile` | `spec/requests/api` | Response shapes are a public contract; record from production-like fixtures. |
| **WS-18 Admin** | `config/routes/admin.rb`, admin controllers and pages | admin specs | Internal users only; can flip earliest in production. |
| **WS-19 AI, MCP and moderation** | `services/ai` (4.4k), `mcp` (2.0k), `content_moderation` (2.1k) | matching specs | Depends on WS-06; LLM calls recorded via VCR. |

## Phase 2: money (parallel, after phase 1 proves the harness)

These move real money. Each requires the full shadow period plus a written rollback plan in its PR.

| Stream | Scope (Ruby) | Notes |
| --- | --- | --- |
| **WS-20 Checkout and orders** | `checkout/`, `orders_controller`, `purchases_controller`, `services/{checkout,order,purchase}` (9.4k), `customer_surcharge_controller` | Offer codes, upsells, tips, PPP. Depends on WS-21. |
| **WS-21 Payment processors** | `app/business/payments` (16k): Stripe, Braintree, PayPal chargeables, SCA, disputes, refunds | Keep processor API calls identical; VCR cassettes are the parity fixtures. |
| **WS-22 Sales tax and VAT** | `app/business/sales_tax`, TaxJar, `valvat`, tax center | Golden vectors for every country rule. |
| **WS-23 Balances and payouts** | balances, balance transactions, payouts, bank accounts (per-country `ach_account` etc.), Stripe Connect | Highest blast radius; flip last. |

## Phase 3 and 4

### WS-30 Jobs and cron

Port the 303 job bodies into the Node worker designed in WS-05, queue by queue starting with `low`.
A job moves when its enqueuers are already in Node or still enqueue the same wire format (they do, by
design). `critical` (receipts) moves last.

### WS-40 Removal

When `routes.json` covers every route and no job is left in Ruby: switch Prisma Migrate on with a
baseline migration taken from the current schema, delete Rails, Ruby specs whose parity fixtures are
captured, and the Gemfile.
