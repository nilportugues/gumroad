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

## Done on 2026-11-10

- A (missing fixtures): none left; `node scripts/parity-debt.ts` reports 0 without a fixture.
- B (aged replays): `analytics-data`, `discover`, `api-v2-ws17b`, `ws17e-admin-api`, `content-delivery-mutations`, `url-redirects`,
  `settings-payments-profile`, `ws75-pages`, `checkout-payouts`, `mobile-analytics`, `dashboard-pages` fixed with pinned clocks or
  `parity/src/date-drift.ts`. Two real Node bugs came out of it (discover autocomplete SQL under `ONLY_FULL_GROUP_BY`, empty `_inertia_meta`).
- C (hand-backs ported): thumbnails and `blob.signed_id`, the subtitle Unicode retry, `POST /customer_surcharge` (first cut), and on the
  customers page physical products and Skus, UTM links, commissions without files, review videos without thumbnails, Braintree sales,
  several options, direct-affiliate credit, gift recipients' licences and the Indian-mandate status.

## E. What is left

Each is one worktree (see "Lane isolation"). Tasks that need a Rails recording: write the spec, then record from the main checkout.

| Task | Work | Needs |
| --- | --- | --- |
| E1 | Done 2026-11-10: `active-storage.golden.json` re-recorded from Rails; `blob.signed_id` and the 1280x720 digests are asserted against it | none |
| E2 | Customers page: parity examples for the cases ported without a recording (gift with a licensed recipient, sale of several options, collaborator sale with a direct affiliate, Indian-mandate member, Braintree sale, file custom field without attachment), then re-record and replay | specs + recording |
| E3 | Done 2026-11-10: commission files, review video thumbnails (processed preview and original), shipping price recurrence (monthly and once) and the price's recurrence of a purchase with no subscription are recorded (lane 15) and replay; several shipments and the `URI.parse` tracking URL cases were recorded earlier. Left: an in-progress commission completion that holds a processor reference, and a thumbnail variant record with no stored image, still hand back | none |
| E4 | Done 2026-11-10: a member on an Indian mandate whose next charge is free under a limited-cycle discount (and the same without a cycle limit, which stays alive) and a gift licence with option content (no license-key block, a block, no pages) are recorded (lane 15) and replay | none |
| E5 | `POST /customer_surcharge`: GeoIP buyer currency (the countries table as a golden), VAT id, TaxJar states, Singapore, Spanish rates, physical lines (`ShippingDestination`), the 400/503 answers; the first cut hands back whenever GeoIP finds a country, which is most production buyers | Node code + goldens |
| E6 | Open, narrowed 2026-11-10. Not a CPU spin: the first request to any taxonomy path builds `DiscoverTaxonomyConstraint.valid_taxonomy_paths` (memoised per process), which costs about 4 minutes on the seeded taxonomy, and it is paid by whichever example runs first (the whole file pays it once). The `FIELD(id, )` guess was wrong for this seed: `Wishlist` already recomputes `recommendable` in `WishlistProduct#after_create`, so calling `update_recommendable` in the spec changes nothing. What is still unexplained is that this example (and only this one) gets `ActionController::RoutingError` for `/3d/3d-modeling` with the `recommended_wishlists` partial header, while `:165` (`recommended_products`) on the same path answers 200. Measured: right before the request `DiscoverTaxonomyConstraint.valid_taxonomy_paths` is already memoised and empty (size 0), and clearing the memo and rebuilding it still leaves the example at 404, so the taxonomy rows are not visible to the constraint's query in this example (check what the `:wishlist` and `:wishlist_product` factories or `make_taxonomy_stats` do to `taxonomies`/`taxonomy_hierarchies`). Rails files and ids live in the `gr-ruby` container, so read `/tmp` results with `docker exec gr-ruby cat`. Every run of this example costs 5 to 13 minutes. Until then `wishlists-for-a-category` stays in `HANDED_BACK` in `discover.replay` |
| E7 | Closed, no change: the two `subscription_end_date` examples ignore `free_trial_ends_on` and `timestamp` on purpose. Their `<now-7296h>` seed needs a seed instant on 2026-11-10 UTC while `<now+168h>` needs one on 2026-11-09, so one instant cannot keep both fields; fixing it would need a per-token seed override or edited fixtures | none |
| E8 | Lint debt: many files that these branches touched have prettier and `import/order` errors; `npm run lint:baseline` after any cleanup. Do not `eslint --fix` whole directories (it broke `parity/src` once) | none |
| E9 | `api-coverage.test.ts` and `lint:baseline` in CI for every branch | CI |

## D. Housekeeping

- D1 Refresh `parity-debt.md` and "Open items" to match this file once A and B are closed.
- D2 `npm run lint:baseline` after any lint-touching change. Do not run `eslint --fix` over `parity/src`: it rewrote 13 files
  and turned a `function` reviver into an invalid arrow.

## Last full run

2026-11-10, alone on its lane after every branch above was merged: 59 files passed, 2,756 tests passed, 12 skipped, 0 failed.
Unit tests (`npx vitest run src`): the only failure in this sandbox is `src/worker/jobs/workflow-jobs.test.ts` "reschedule: one recipient",
which needs Redis on 127.0.0.1:6379. The stack is the one in [parity-local-stack.md](parity-local-stack.md); the command is in its
"Replay environment" section without a file argument. Two replays cannot share a checkout: both start `next dev` in `.next/dev`, so run one at a time.
