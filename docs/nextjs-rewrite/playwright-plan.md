# Playwright plan: task by task

The end-to-end suite has two jobs: catch regressions in the main seller and buyer flows, and give the Rails to
Node port a shared traffic recording to replay against both servers. Progress is the share of ticked boxes below.

```shell
scripts/e2e-progress.sh      # prints done/total per phase and overall, from this file
```

Tick a box (`- [x]`) only when the task is merged to `nextjs-rewrite` and, for specs, passes in `bin/e2e-run`.
A task with a spec file names it. One task is one point, so the percentage is a plain count.

## Phase 1: foundation

- [x] 1.1 `playwright.config.ts` with projects guard, preflight, chromium and bot
- [x] 1.2 `BASE_URL` guard: only localhost, 127.0.0.1, `*.localhost`, `example.*`; non-local requests aborted (`base-url-guard.spec.ts`)
- [x] 1.3 Preflight check that the app is up and seeded (`preflight.setup.ts`)
- [x] 1.4 Support helpers: auth, buyer, seller, fixtures, recorder (`e2e/support/`)
- [x] 1.5 One-command local environment: `bin/e2e-up`, `bin/e2e-run`, `bin/e2e-down` on lane 3
- [x] 1.6 `e2e/README.md` with setup and preconditions
- [x] 1.7 Suite merged into `nextjs-rewrite` (ws-e2e-1 and ws-e2e-2 landed via integration-8; e2e-3 to e2e-5 via integration-12 and integration-16)

## Phase 2: regression specs that exist

- [x] 2.1 Authentication: sign up, log out, log in, wrong password, two-factor (`auth.spec.ts`)
- [x] 2.2 Buy the seeded free product as guest and signed in, receipt, library (`buy-free-product.spec.ts`)
- [x] 2.3 Discover: landing, category, search, empty search (`discover.spec.ts`)
- [x] 2.4 Seller profile and product page back-link (`profile.spec.ts`)
- [x] 2.5 Seller creates and publishes free and paid products (`seller-products.spec.ts`)
- [x] 2.6 Settings pages render and a change persists (`settings.spec.ts`)
- [x] 2.7 Posts as drafts and workflow creation (`posts-and-workflows.spec.ts`)
- [x] 2.8 Discount code and affiliate creation (`discount-and-affiliate.spec.ts`)

## Phase 3: coverage still missing

- [ ] 3.1 Paid card checkout with a Stripe test card; needs test keys, currently skipped (`paid-checkout.stripe.spec.ts`)
- [x] 3.2 Discount code applied at checkout changes the total (`checkout-discount.spec.ts`)
- [x] 3.3 Buying through an affiliate link records the affiliate (`affiliate-purchase.spec.ts`)
- [x] 3.4 Membership: a free membership is created and published, a buyer subscribes, sees it under Library > Subscriptions and cancels it (`membership.spec.ts`; the buyer is the confirmed seeded `gumbo_audio` account because the seller's own purchases are test purchases and never reach the library); a paid recurring charge needs Stripe test keys and stays with 3.1
- [x] 3.5 Seller edits a product price and the product page follows (`product-price-edit.spec.ts`)
- [ ] 3.6 Seller refunds a sale (needs Stripe test keys or a free-sale equivalent)
- [x] 3.7 Customers page renders and its CSV export downloads with the sales columns (`customers.spec.ts`); listing a sale made during the run needs Sidekiq indexing, see 5.1
- [x] 3.8 Bundle created, published and bought (`bundle.spec.ts`; free bundle of the seeded free product, the buyer lands on the library filtered to the bundle); bundle product purchases are created by Sidekiq and are not asserted
- [x] 3.9 Buyer downloads a file from the content page (`download-file.spec.ts`)
- [x] 3.10 Analytics and dashboard pages render with the seeded data (`dashboard-analytics.spec.ts`)
- [x] 3.11 Payouts and payment settings pages render (render only, no live Stripe) (`payouts.spec.ts`)
- [x] 3.12 Mobile viewport project runs the main buyer flow (`mobile-buyer.spec.ts`, `mobile` project)
- [x] 3.13 Dark mode: screenshots of discover, product and checkout (`dark-mode.spec.ts`; product and checkout are seller-themed and stay light, discover follows the scheme)

## Phase 4: traffic bot and replay

- [x] 4.1 Seeded bot with `BOT_SEED`, `BOT_SESSIONS`, `BOT_STEPS` (`e2e/bot/`)
- [x] 4.2 Recorder writes request and response pairs as JSONL under `e2e/.out/`
- [x] 4.3 Determinism check: the same seed gives the same request sequence twice (`e2e/bot/determinism.bot.ts`, `npm run e2e:determinism`)
- [x] 4.4 Replay tool sends a recording to a Rails server (`e2e/replay/`; run on a real bot recording, seed 1, 2 sessions x 15 steps, 136 exchanges, against a seeded Rails on lane 1 (lane 3 belonged to another run): 103 GETs replayed, 33 requests with bodies skipped; statuses 200 x65, 302 x17, 301 x11, 500 x5, 404 x4, 303 x1)
- [x] 4.5 Replay tool sends the same recording to the Node server (same 103 GETs against `next dev` with every `routes.json` flag on, proxying to the same Rails and database; no seed snapshot restore: both replays share one database, Rails first)
- [ ] 4.6 Diff report between the two replays, with known differences masked (`e2e/replay/compare-cli.ts` writes `report.md`; a real diff was produced, see "Rails vs Node replay" below; stays open because the 52 body differences were not traced to volatile fields or real content, so the mask is not checked against real data)

## Phase 5: running it for real

- [ ] 5.1 Sidekiq in the e2e environment so emails, receipts and reindexing happen without manual steps
- [ ] 5.2 Suite runs green against the Node server, not only Rails
- [ ] 5.3 CI job runs the suite on pull requests (`.github/workflows/e2e.yml` written, YAML parses, `bin/e2e-up` accepts `E2E_BUNDLE_INSTALL=1`; remaining: a real run on GitHub Actions, never executed)
- [x] 5.4 Flaky-test policy: retries, trace on first retry, a list of quarantined specs (`e2e/README.md`, `e2e/quarantine.json`; checked with a throwaway spec that failed once: reported flaky and wrote `trace.zip`; quarantine moves a spec from `chromium` to `quarantine` in `--list`)
- [ ] 5.5 Seed reset between runs so a second run does not depend on the first (`bin/e2e-up --reseed` written and `bash -n` clean; remaining: run it against lane 3 and show a second suite run passes)

## Last measured result

`bin/e2e-run` on lane 3: 73 passed (19 guard, 49 chromium, 4 mobile plus preflight runs per project), 1 skipped (the Stripe spec), 0 failed.
`npm run e2e:determinism` (bot project, not part of `bin/e2e-run`): 3 passed in each of 3 consecutive runs; with the RNG seed perturbed by `Math.random` the same-seed test fails.

Unit tests of the replay, diff and quarantine code (`npx vitest run e2e`, no app): 20 passed, 0 failed. Mutation-checked (break, a test fails, revert): both host guards, the cookie jar, the body-skip rule, the csrf-meta, timestamp, id-key and numeric-path mask rules, each compared field, the skip handling, the quarantine anchor and reason check. The csrf-form-field and token-keys rules are covered by an assertion but were not mutated.

## Rails vs Node replay (4.4 to 4.6, one run)

Recording: bot seed 1, 2 sessions x 15 steps, made against Rails on lane 1. Compared with `compare-cli.ts`: 103 GETs paired, 33 skipped
(request bodies are not recorded), 0 only on one side, 287 field differences. All 103 statuses agree (the Node server redirects and renders
what Rails does for these requests). Two setup findings first, then the differences.

Node dev server findings (environment, not a ported-route bug unless stated):
- `/discover` and `/l/*` answered 500 on Node until `ELASTICSEARCH_HOST` (and `ES_INDEX_SUFFIX`) were set: `getElasticsearch` throws `key not found: "ELASTICSEARCH_HOST"` (`src/server/infra/elasticsearch.ts:22`, from `search/transport.ts`). Config gap.
- Every route answered 500 before `SECRET_KEY_BASE` and `RACK_ATTACK_REDIS_HOST` were set. Config gap.
- `GET /settings` with no session answered 500: `NotPortedError("authenticate_user! for a signed-out visitor")` at `src/server/page-props/seller-pages.ts:101`, where `connections-mutations.ts:27` and `seller-json-guard.ts:18` throw `HandBackToRails` for the same case. With the env route gate it reaches Node; production's `railsRouteGate` is expected to send a signed-out request to Rails, which was not run here. With `NEXTJS_ASSUME_SIGNED_OUT=1` it is a 302 like Rails. Possible real bug on that path: report, not fixed.
- Node swallows the cause of a 500 in development (`notifyError`, Sentry off) and serves Rails' public 500 page.

Differences, by request (counts are exchanges in this recording; R is Rails, N is Node):
- Every pair (103): `vary` differs (Rails `X-Inertia, Origin`-style, Node `Origin, Accept-Encoding`).
- 73 pairs: Rails sets the `__profilin` cookie (mini-profiler, development only); Node does not.
- `/discover` x18, `/l/demo` x8, `/l/h` x2, `/l/b` x1: `cache-control` R `no-store, must-revalidate, private, max-age=0`, N `no-store`; `body` differs.
- `/checkout` x13: `body` differs; `cache-control` x9 R `no-store, must-revalidate, private, max-age=0`, N `no-store`.
- `/cart_items_count` x13 and `/checkout/upsells/products` x4: `cache-control` R `no-store, must-revalidate, private, max-age=0`, N `max-age=0, private, must-revalidate`.
- `/login` x2 and `/signup` x2: `body`; `cache-control` R `max-age=0, private, must-revalidate`, N `no-store`; Node also sets `_gumroad_guid`.
- `GET /` x1: `body`.
- `/braintree/client_token` x5: `body` (both 500 with different pages; Braintree is not configured here).
- Cookie-name differences only (`__profilin`): `/d/:id`, `/dashboard`, `/emails/...`, `/internal/:id/recipient_count`, `/library`, `/two-factor`, `/workflows/...`.
- Not compared: the 33 requests with bodies (logins, sign-ups, buys, post and workflow creation), so no write path and no signed-in page was replayed.
