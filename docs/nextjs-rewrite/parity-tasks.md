# Parity tasks for parallel worktrees

Setup: [parity-local-stack.md](parity-local-stack.md). One task per worktree (`git worktree add ../gr-<task> -b parity/<task> nextjs-rewrite`).

## Lane isolation (read before starting two tasks at once)

The recording stack is shared. Two lanes must not share any of these:

| Resource | Lane N |
| --- | --- |
| Recording database | `gumroad_test_<N>` (`mysqldump --no-data gumroad_test`) — recording seeds rows and fails on taken usernames |
| Replay database | `gumroad_replay_<N>` |
| Replay Redis | a db outside `14`-`21`, e.g. `40 + N` |
| Elasticsearch | `PARITY_ES_INDEX_SUFFIX` unique per lane (replays) |
| Ports | `next dev` picks a free one; keep the `9010`/`8012` forwarders shared (read-only) |

Only one lane records at a time unless it has its own recording DB **and** its own Redis lease range.

## Definition of done for every task

1. The replay file named in the task passes (`npx vitest run --config parity/vitest.config.ts parity/__tests__/<file>`).
2. New fixtures are committed; re-recorded fixtures that did not change meaning are `git checkout`-ed.
3. `workstreams.md` "Open items" and `parity-debt.md` lose the line you closed.
4. Commit, rebase on `nextjs-rewrite`, push.

## A. Record the missing fixtures (21 examples, `node scripts/parity-debt.ts`)

Record with `PARITY_RECORD=1` (`=all` for controller specs). Purchase factories charge Stripe: build plain rows
(`build(:purchase, ..., purchase_state: "successful").save!(validate: false)`, `update_attribute` afterwards).

| Task | Spec | Missing | Replay file |
| --- | --- | --- | --- |
| A1 | `spec/requests/api/mobile/mobile_api_parity_spec.rb` :300 :309 :316 :326 :334 | stream/hls/download refusals | `mobile-api.replay` |
| A2 | `spec/requests/buyer_pages_parity_spec.rb` :355 :370 | library memberships and bundle | buyer pages replay |
| A3 | `spec/requests/customers_signed_in_spec.rb` :254 :266 :280 :292 | refunds, gift, non-USD | `customers.replay` |
| A4 | `spec/requests/discover_parity_spec.rb` :271 :283 | recorded 2026-11-10; replay failures are task B2 | `discover.replay` |
| A5 | `spec/requests/offer_codes_compute_discount_parity_spec.rb` (8) | done: recorded, `offer-codes-compute-discount.replay` passes 9/9 | |

## B. Replays that still fail (full run 2026-11-10: 2,551 passed, 40 failed, 12 skipped)

Most are fixtures that age: they seed rows "N hours/days ago" and print dates, so they pass on the recording day only.
Pin the clock (below) before reading any diff by hand.

| Task | Replay | Failing | Cause / first step |
| --- | --- | --- | --- |
| B1 | `analytics-data` | 17 (`analytics_data_signed_in_spec`, `large_seller_dashboards_signed_in_spec`) | day series: pin the clock to the recording day, as `dashboard-pages` does |
| B2 | `discover` | 7 (signed-out autocomplete, deferred recently viewed, recommended products/wishlists) | not looked at since the re-record; start with the diff |
| B3 | `api-v2-ws17b` | 5 (`sales_controller_spec` web csv parity fields, dispute information) | date fields; plus the 2 midnight-flaky `subscription_end_date` examples |
| B4 | `content-delivery-mutations` | 3 (`library_mutations`: archive, unarchive, remove) | re-recorded this session; compare archived/deleted timestamps |
| B5 | `settings-payments-profile` | 2 (Australian seller with backtaxes, legal guardian of a US minor) | date of birth / backtax dates the drift cannot reach |
| B6 | `ws75-pages` | 1 (piracy report history and restoration window) | dates in a history list |
| B7 | `checkout-payouts` | 1 (instant payout fee and arrival date) | arrival date |
| B8 | `dashboard-home` | 1 (three best-selling products and activity) | "N days ago" activity |
| B9 | `mobile-analytics` | 1 (by_referral older than a year) | range clamp depends on today |
| B10 | `url-redirects` | 1 (post consumption analytics takes the purchase from the params) | not looked at |
| B11 | `ws17e-admin-api` | 1 (comments cursor #2) | `<now-180m>` comments age out: pin the clock |
| B12 | `settings-mutations` AI promo dismissals, `internal-api` Redis-job example | 0 in this run | check they still pass; remove from Open items if so |

Pinning a clock: `dashboard-pages.replay.test.ts` is the model (`NODE_OPTIONS=--require parity/src/fixed-clock-preload.cjs`,
`PARITY_CLOCK_OFFSET_MS`, `vi.useFakeTimers({ toFake: ["Date"] })`, and `driftDates: false` so recorded dates are not
shifted twice). Choose the hour of the recording, not midnight: seeded "N hours ago" rows land on other days otherwise.

## C. Ported behaviour that still hands back to Rails

From "Open items" in [workstreams.md](workstreams.md). Each needs Node code plus a fixture.

- C1 Product file thumbnails and `blob.signed_id` (record a golden token first).
- C2 Subtitle whose S3 object is missing (`S3KeyUnicodeNormalization` retry).
- C3 `POST /customer_surcharge` beyond the plain cart (the plain cart is ported; record `spec/requests/customer_surcharge_parity_spec.rb`, then widen).
- C4 Customers page: physical products and Skus, UTM links, commissions, review videos, custom field files, Braintree sales,
  gifts to licence holders, multi-option sales, collaborator sales, India mandate members. Split by item.

## D. Housekeeping

- D1 Refresh `parity-debt.md` and "Open items" to match this file once A and B are closed.
- D2 `npm run lint:baseline` after any lint-touching change. Do not run `eslint --fix` over `parity/src`: it rewrote 13 files
  and turned a `function` reviver into an invalid arrow.

## Last full run

2026-11-10, after the date-drift and dashboard clock commits: 56 files, 45 passed, 11 failed; 2,603 tests, 40 failed.
The stack is the one in [parity-local-stack.md](parity-local-stack.md); the log is regenerated by the command in its "Replay environment" section without a file argument.
