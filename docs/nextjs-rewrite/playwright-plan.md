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
- [ ] 1.7 Suite merged into `nextjs-rewrite` (branches `ws-e2e-1` and `ws-e2e-2` pushed, integration-8 verifying)

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
- [ ] 3.4 Membership: subscribe, see it in the library, cancel
- [x] 3.5 Seller edits a product price and the product page follows (`product-price-edit.spec.ts`)
- [ ] 3.6 Seller refunds a sale (needs Stripe test keys or a free-sale equivalent)
- [ ] 3.7 Customers page lists a new sale and its CSV export downloads
- [ ] 3.8 Bundle created, published and bought
- [ ] 3.9 Buyer downloads a file from the content page
- [ ] 3.10 Analytics and dashboard pages render with the seeded data
- [ ] 3.11 Payouts and payment settings pages render (render only, no live Stripe)
- [ ] 3.12 Mobile viewport project runs the main buyer flow
- [ ] 3.13 Dark mode: screenshots of discover, product and checkout

## Phase 4: traffic bot and replay

- [x] 4.1 Seeded bot with `BOT_SEED`, `BOT_SESSIONS`, `BOT_STEPS` (`e2e/bot/`)
- [x] 4.2 Recorder writes request and response pairs as JSONL under `e2e/.out/`
- [ ] 4.3 Determinism check: the same seed gives the same request sequence twice
- [ ] 4.4 Replay tool sends a recording to a Rails server
- [ ] 4.5 Replay tool sends the same recording to the Node server
- [ ] 4.6 Diff report between the two replays, with known differences masked

## Phase 5: running it for real

- [ ] 5.1 Sidekiq in the e2e environment so emails, receipts and reindexing happen without manual steps
- [ ] 5.2 Suite runs green against the Node server, not only Rails
- [ ] 5.3 CI job runs the suite on pull requests
- [ ] 5.4 Flaky-test policy: retries, trace on failure, a list of quarantined specs
- [ ] 5.5 Seed reset between runs so a second run does not depend on the first

## Last measured result

`bin/e2e-run` on lane 3: 53 passed (19 guard, 34 chromium), 1 skipped (the Stripe spec), 0 failed.
