# End-to-end suite and traffic bot

Playwright (chromium only) drives a **locally running** Gumroad app. It has two jobs:

1. a regression suite (`e2e/specs/`) for the main seller and buyer flows;
2. a seeded traffic generator (`e2e/bot/`) that browses, buys and creates content while recording every
   request/response pair, so the same traffic can later be replayed against Rails and the Node port and the
   responses compared.

## One command: lane 3 in a container

`bin/e2e-up` builds everything below for **dev lane 3 only** (`http://localhost:3003`) and leaves it running;
`bin/e2e-run` runs the suite against it; `bin/e2e-down` removes it again.

```shell
bin/e2e-up        # idempotent; first run takes several minutes (npm ci, Vite build, seeds, reindex)
bin/e2e-run       # npm run e2e inside the container; extra args go to `playwright test`, e.g. bin/e2e-run e2e/specs/discover.spec.ts
bin/e2e-down      # idempotent; removes only what e2e-up created
```

What `bin/e2e-up` does, in order:

1. Verifies the shared `gumroad-db-1`, `gumroad-redis-1`, `gumroad-elasticsearch-1` and `gr-dynamo` containers
   (starts one only if it is stopped, never recreates them).
2. Creates one container, `gr-e2e-lane3` (image `gr-ruby-img25`, else `ruby:3.4.12-bookworm`), on the
   `gumroad_default` network with `127.0.0.1:3003` published and the shared `gr_bundle` gem volume. The checkout's
   tracked files are copied to `/work`; Node (from `.node-version`) and `npm ci` live inside the container, so the
   host `node_modules` (darwin bindings) is never used and dies with the container.
3. Loads the schema into `gumroad_development_lane3`, creates the `lane3_` DynamoDB table, creates the `*_lane3`
   Elasticsearch indices, runs `rails db:seed`, then reindexes (no Sidekiq runs, so seeds are only searchable after
   the reindex; the seeds are not re-runnable, so they run once per database and a second `bin/e2e-up` only reindexes; to reseed run `bin/e2e-down` first). Seeding needs ffmpeg and a `localhost:9000` forward to the shared MinIO, both set up in the container. `SKIP_TEST_DATABASE=true` keeps the shared `gumroad_test` database untouched.
4. Applies the local tweaks from the preconditions below (free-purchase limit 100000, `PlatformBlock.delete_all`)
   and exports `SECURE_EXTERNAL_ID__*` from `.env.test` into the container's environment file.
5. Builds the frontend once (`npm run setup` then `NODE_ENV=development VITE_RUBY_MODE=test npx vite build`; rebuilt when
   `app/javascript` or the lockfile changes, or with `E2E_REBUILD=1`), starts `rails s` on 3003 and waits for
   `/discover` and `/l/demo` to answer 200.

Only lane 3 resources are touched: database `gumroad_development_lane3`, Redis dbs 8 and 9, indices `*_lane3`, table
`lane3_*`, container `gr-e2e-lane3`. `bin/e2e-common.sh` aborts if `bin/dev-lane 3` stops resolving to exactly
those. Not started: Sidekiq, AnyCable, `bin/vite dev`. Rails logs: `docker exec gr-e2e-lane3 tail -f /work/log/e2e-rails.log`.
`bin/e2e-run` installs Chromium and its system libraries inside the container on first use.

## Precondition: a running, seeded local app

The sections below describe the same setup done by hand.

The suite never creates its own data for the catalogue; it relies on `bin/rails db:seed`.

1. Boot a dev lane ([parallel lanes](../docs/local-dev-parallel-lanes.md)):

   | Lane | `BASE_URL` | Command |
   | --- | --- | --- |
   | 1 (default) | `http://localhost:3001` | `bin/dev-lane 1` |
   | 2 | `http://localhost:3002` | `bin/dev-lane 2` |
   | 3 | `http://localhost:3003` | `bin/dev-lane 3` |

2. Seed it, with that lane's environment (see "First-time setup" in the lanes doc):
   `bin/rails db:create db:migrate db:seed` plus the Elasticsearch reindex and the DynamoDB table. Seeding before
   the reindex fails on the audience index.
3. Raise the free-purchase velocity limit for the lane's Redis database, or repeated free purchases from
   `127.0.0.1` get blocked (`product_temporarily_blocked`, 24 h) after three:

   ```ruby
   $redis.set(RedisKey.max_allowed_free_purchases_of_same_product, 100_000)
   PlatformBlock.delete_all # clears a block already armed in this lane
   ```

4. Development has no `SECURE_EXTERNAL_ID__*` keys, so the receipt page answers 500. Export the test values for the
   lane's Rails process (`SECURE_EXTERNAL_ID__PRIMARY_KEY_VERSION=1`, `SECURE_EXTERNAL_ID__KEYS__1=...`, both in
   `.env.test`).
5. Install the browser once: `npx playwright install chromium` (Linux hosts also need
   `npx playwright install-deps chromium`).

The `preflight` project runs before every spec and bot run. It fails with these instructions when the app is
unreachable or `/l/demo` / `/discover` show no seeded products.

Known noise: `GET /braintree/client_token` answers 500 on checkout without Braintree credentials; the bot records it.

Seeded data used (from `db/seeds/020_development_staging`, `030_development`):

- seller `seller@gumroad.com` / `password` (two-factor is enabled; development accepts the prefilled `000000`),
  username `seller`, free product `demo` ("Beautiful widget"), membership `membershipdemo`;
- the `gumbo_*@gumroad.com` creators with one $5 product each (discover, search, affiliate targets).

Override the seller with `E2E_SELLER_EMAIL` / `E2E_SELLER_PASSWORD`.

## Running

```shell
BASE_URL=http://localhost:3003 npm run e2e          # guard + specs
BASE_URL=http://localhost:3003 npm run e2e:bot      # traffic bot
BASE_URL=http://localhost:3003 npx playwright test --project=chromium e2e/specs/discover.spec.ts
```

`BASE_URL` defaults to `http://localhost:3001` (dev lane 1). `playwright.config.ts` refuses to start unless the
host is `localhost`, `127.0.0.1`, `*.localhost` or `example.<tld>` / `*.example.<tld>`
(`e2e/support/base-url.ts`, tested by `base-url-guard.spec.ts`). Product pages live on seller subdomains
(`seller.localhost:3003`), which Chromium resolves to loopback without any hosts-file change.

### Assets

The pages need a Vite build that matches the checkout. Either run `bin/vite dev` (the lane's normal setup), or
build once and serve it with the dev Rails server:
`NODE_ENV=development VITE_RUBY_MODE=test npx vite build` and boot Rails with
`VITE_RUBY_PUBLIC_OUTPUT_DIR=vite-test VITE_RUBY_AUTO_BUILD=false VITE_RUBY_MODE=test`. `NODE_ENV=development`
matters: the checkout skips reCAPTCHA only when the JS bundle is not a production build.

### No third parties

Every browser context aborts any request whose host is not local (`blockExternalRequests`), so Stripe.js,
analytics, reCAPTCHA and fonts are never fetched. Free checkout works without them.

### Paid card checkout (`@stripe`)

`paid-checkout.stripe.spec.ts` is skipped unless `STRIPE_PUBLISHABLE_KEY=pk_test_...` and
`STRIPE_SECRET_KEY=sk_test_...` are in the environment (the app must be booted with the same test keys). Only
then are `*.stripe.com` requests let through. The suite never reads or writes credentials itself.

## Specs

| File | Flows |
| --- | --- |
| `auth.spec.ts` | sign up, log out, log in, wrong password, seeded seller with two-factor |
| `seller-products.spec.ts` | create free and paid products, publish, view as a logged-out buyer, product list |
| `buy-free-product.spec.ts` | guest and signed-in free purchase, content page, receipt, library |
| `discover.spec.ts` | discover landing, category, search, empty search |
| `profile.spec.ts` | seller profile on its subdomain, product page |
| `settings.spec.ts` | settings pages render, a setting persists |
| `posts-and-workflows.spec.ts` | create a post (draft), create a workflow |
| `discount-and-affiliate.spec.ts` | create a discount code, add an affiliate |
| `paid-checkout.stripe.spec.ts` | `@stripe` card checkout (skipped without test keys) |

Page helpers are in `e2e/support/` (`auth.ts`, `seller.ts`, `buyer.ts`).

## The bot

```shell
BOT_SEED=42 BOT_SESSIONS=3 BOT_STEPS=20 BASE_URL=http://localhost:3003 npm run e2e:bot
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `BOT_SEED` | `1` | Seeds the RNG (per session: `<seed>:<session>`). Same seed + same data = same action sequence |
| `BOT_SESSIONS` | `2` | Sessions per run |
| `BOT_STEPS` | `15` | Weighted random actions per session |
| `BOT_HAR` | off | `1` also writes `e2e/.out/har/<session>-<actor>.har` |
| `BOT_OUT` | `e2e/.out/bot-<seed>-<time>.jsonl` | JSONL output path |
| `BOT_SEARCH_TERMS` | `widget,music,film,design,book,course` | Search vocabulary |
| `E2E_RECORD_ASSETS` | off | `1` also records images, scripts, styles and fonts |

Each session has two actors: a freshly signed-up `buyer` and the seeded `seller`. Actions (weights in
`e2e/bot/actions.ts`): browse, search, view product, add to cart, buy the free product, library, settings and
dashboard visits, create post, create workflow. A failing step is logged and the session continues.

### Output format

One JSON object per request/response pair (`RecordedExchange` in `e2e/support/recorder.ts`): `session`, `step`,
`actor`, `action`, `method`, `host`, `path` (with query), `status`, selected request/response headers
(`content-type`, `location`, `x-inertia`, `cache-control`, ...), the names of cookies set, and SHA-256 plus byte
length of the request and response bodies. `.out/` is git-ignored.

## Next step: replaying against a second server (not built yet)

The JSONL is the input for differential testing. A replay tool should:

1. Read exchanges in order, grouped by `session` and `actor` (each actor is one cookie jar).
2. For each, send `method` + `path` to the target (`REPLAY_BASE_URL`: Rails, then the Node port), keeping a cookie
   jar per actor, and mapping the `host` subdomain (`seller.localhost`, ...) onto the target's host.
3. Compare `status`, `location` (after normalizing ids), `content-type`, `x-inertia`, and `responseBodyHash`.
   Bodies will rarely hash equal as-is: they embed CSRF tokens, timestamps and generated ids. Compare normalized
   bodies (or the Inertia `props` JSON) and treat the hash as a fast path.
4. Request bodies are hashed, not stored, because they carry per-session CSRF tokens and passwords. To replay
   writes, extend the recorder to store sanitized bodies (or capture a HAR with `BOT_HAR=1`, which keeps them in
   the git-ignored `.out/har/`), then substitute the target's own tokens.
5. Ids and permalinks created during the run (products, posts, workflows, purchases) differ per server; map them
   by creation order within a session.

Replay each target from a database restored to the same seed snapshot, otherwise counters, ids and
"already purchased" states diverge.
