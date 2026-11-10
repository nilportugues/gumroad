# Parity debt

> **Status 2026-11-10.** The sections below were written when no environment could run Rails or the replays, and are kept as the
> history of what was unproven. They have since been closed against a real stack (setup in [parity-local-stack.md](parity-local-stack.md)):
> every tagged example has a fixture (`node scripts/parity-debt.ts` reports 0 without one) and all 59 replay files pass (2,718 tests).
> What is open now is in [parity-tasks.md](parity-tasks.md) and the "Open items" of [workstreams.md](workstreams.md). The counts
> table is current; sections 1 to 4 describe the state at `b8fbe3067` unless a line says otherwise.

## Counts

| | Count |
| --- | ---: |
| Spec files containing `parity: true` | 102 |
| Examples tagged `parity: true` | 1,930 |
| Of those, with a fixture | 1,930 |
| Of those, without a fixture | 0 |
| Fixture files (incl. `PARITY_RECORD=all` controller specs) | 2,744 |
| Replay test files | 51 (59 test files in the parity run) |
| Replay result | 59 files, 2,718 tests passed, 12 skipped, 0 failed |

## Tooling

```bash
cd nextjs
node scripts/parity-debt.ts                 # tagged examples without a fixture, per spec file
node scripts/parity-debt.ts --spec url_redirect   # one spec (substring of the path)
node scripts/parity-debt.ts --json          # same, machine-readable
```

`scripts/parity-debt.ts` parses the specs without Ruby (describe/context nesting from indentation) and matches
each example's full description against the `example` field of the recorded fixtures of the same spec. It
reports `unresolved` for descriptions it cannot resolve (interpolation with no matching fixture, or examples
inside `shared_examples`); the run at `b8fbe3067` has 0 unresolved. It should print `0 without a fixture` when
section 1 is done. Interpolated descriptions (`#{role}`, `#{path}`) are matched as patterns, so a loop that
records only some of its iterations would not be flagged: could not determine whether any does.

## 1. Tagged examples without a fixture

Record each spec file with `PARITY_RECORD=1 bin/rspec <spec>` from the repo root (needs MySQL, Redis and, for
Discover, Elasticsearch, per `bin/rspec`'s usual setup). The examples have never run, so expect some spec
failures: fix the spec or the factory setup, never the fixture. Then replay with the command in the last column
from `nextjs/`, with `PARITY_DATABASE_URL` set. Replay file shorthand: `R = npx vitest run --config parity/vitest.config.ts parity/__tests__/`.

### 1.1 By workstream

| WS | Spec (`spec/requests/...`) | Missing | Flags it gates | Replay |
| --- | --- | ---: | --- | --- |
| WS-10c | `review_reminders_parity_spec.rb` (whole file, :16-:65) | 7 of 7 | `nextjs_review_reminders` | `R auth-mutations.replay.test.ts` |
| WS-10c/10d | `settings_mutations_signed_in_spec.rb`: billing details :255-:277 (3); AI promo dismissal :305-:334 (4); team members :348-:401 (6) | 13 of 33 | `nextjs_settings_billing_writes`, `nextjs_settings_dismiss_ai_promo_writes`, `nextjs_settings_team_members_writes` | `R settings-mutations.replay.test.ts` |
| WS-11 | `storefront_profile_products_parity_spec.rb` :174, :185 | 2 of 16 | `nextjs_storefront_profile` | `R storefront-profile-products.replay.test.ts` |
| WS-12h | `seller_products_edit_signed_in_spec.rb` :157-:231 (tags/refund policies, versions, SKUs, hidden version pages) | 6 of 20 | `nextjs_products_edit` | `R seller-products.replay.test.ts` |
| WS-14c/d | `discover_parity_spec.rb` :177-:283 (autocomplete x5, recommended wishlists, recently viewed x2) | 8 of 30 | `nextjs_discover` | `R discover.replay.test.ts` |
| WS-15 | `customers_paged_signed_in_spec.rb` :120-:161 (filters) | 6 of 17 | `nextjs_customers_paged` | `R customers-paged.replay.test.ts` |
| WS-16b/16c | `url_redirect_delivery_gate_spec.rb` (whole file, :26-:176) | 18 of 18 | `nextjs_url_redirect_delivery`, `_show`, `_stream`, `_hls_playlist`, `_smil`, `_play`, `_read`, `_expired`, `_rental_expired`, `_membership_inactive`, `_subtitle_files` | `R url-redirect-pages.replay.test.ts` |
| WS-16b | `url_redirect_download_page_spec.rb` (whole file, :24-:106) | 10 of 10 | `nextjs_url_redirect_download_page` | `R url-redirect-pages.replay.test.ts` |
| WS-16b | `url_redirects_parity_spec.rb` :666-:716 (`send_to_kindle`) | 8 of 75 | `nextjs_url_redirect_writes` | `R url-redirects.replay.test.ts` |
| WS-17f | `api/mobile/mobile_api_parity_spec.rb` :300-:334 (stream/hls_playlist/download refusals) | 5 of 37 | `nextjs_mobile_url_redirect_delivery` | `R mobile-api.replay.test.ts` |
| WS-17h | `api/mobile/mobile_purchases_sales_parity_spec.rb` (whole file) | 16 of 16 | `nextjs_mobile_purchases`, `nextjs_mobile_sales` | `R mobile-api.replay.test.ts` |
| WS-17k | `api/mobile/mobile_products_subscriptions_parity_spec.rb` (whole file) | 16 of 16 | `nextjs_mobile_products`, `_subscriptions`, `_preorders`, `_installments` | `R mobile-api.replay.test.ts` |
| WS-23b | `payouts_signed_in_spec.rb` :251-:283 (chargeback-rate reserve) | 4 of 28 | `nextjs_payouts` | `R checkout-payouts.replay.test.ts` |

Total: 119. Exact example names: `node scripts/parity-debt.ts`.

### 1.2 Known gaps outside the tagged specs

- `spec/requests/admin/impersonate_spec.rb:48` "impersonates a suspended seller": the execution log says it has
  no fixture. It is not tagged and `admin_impersonate_parity_spec.rb` (13 fixtures) has no equivalent. Add the
  example to the parity spec, record it, and extend `ws17e-admin-api.replay.test.ts` (flag `nextjs_admin_impersonate`).
- `nextjs_mobile_url_redirects` (`/mobile/url_redirects/fetch_placeholder_products`) has only
  `spec/controllers/api/mobile/url_redirects_controller_spec.rb` and no replay naming it. Tag an example in
  `mobile_api_parity_spec.rb`, record it, and add the flag to `ROUTE_FLAGS` in `mobile-api.replay.test.ts`.

## 2. Golden generators

All 115 golden and generated JSON files exist. For each generator that writes a golden I compared the
output names it writes with the files on disk, then compared the string keys the Vitest tests look up
against the JSON. Findings:

| Golden | Lacks | Why it matters |
| --- | --- | --- |
| `nextjs/src/server/mail/__fixtures__/receipt-mailer.golden.json` | `receipt_rental_no_video`, `receipt_rental_watch` | Defined in `generate-receipt-mailer-golden.rb` (:418, :422), absent from the file. Gate for `RENTAL_REDIRECT_PROVEN` (section 4.5) |
| same file | `receipt_gift_sender` | Defined in the generator, absent from the file. Gate for `unproven.giftSender` in `receipt-presenter.ts`: set it to `false` after regenerating and replaying, and check the `gifts` read lands where Rails sends it (`loadReceiptData`, `receipt-mailer.ts`) |

Goldens built on `scripts/golden/support/rails_cases.rb` (e.g. `payment-processor-jobs.rb`) accept a scratch database named `_ws<N>` or `_<N>`
(a lane's `gumroad_test_<N>`); `payment-processor-jobs.golden.json` was regenerated that way on lane 16 with three new threshold cases.
No debt line was open for the sales-threshold hand-back, so none was closed.

`delete-wishlist-products-job.golden.json` was recorded on lane 15 (`gumroad_test_15`, Redis 56-59). The one remaining hand-back of
`DeleteWishlistProductsJob` is `WishlistProduct#mark_deleted!` (its save re-runs `Wishlist#update_recommendable`); no debt line was open for it.

`schedule-affiliate-workflows.golden.json` was regenerated on lane 15 (`gumroad_test_15`, Redis 56-58, `PARITY_ES_INDEX_SUFFIX=-c15`) with seven token cases (Integer, 2**70, negative, true, false); the 40 existing cases are unchanged. `ScheduleAffiliateWorkflowJobsJob` still hands back a Float, Array or Hash token (Rails casts an Array to an IN list). No debt line was open for it.

`delete-product-files-archives-worker.golden.json` was recorded on lane 15 (`gumroad_test_15`, Redis 56-59, `PARITY_ES_INDEX_SUFFIX=-c15`). The one remaining
hand-back of `DeleteProductFilesArchivesWorker` is `ProductFilesArchive#mark_deleted!` (PaperTrail, CdnDeletable); a deleted SKU (Rails fails on a
Mysql2 unknown-column error) and non-Integer ids hand back too. A variant without a category, a missing category row (NoMethodError) and a category without a product
(RecordNotFound `Couldn't find Link without an ID`) now fail in Node like Ruby: six new golden cases on lane 15, the 28 existing ones unchanged. No debt line was open for it.

`remove-suspended-account-follows-worker.golden.json` was recorded on lane 15 (`gumroad_test_15`, Redis 56-58, `PARITY_ES_INDEX_SUFFIX=-c15`). The one remaining
hand-back of `RemoveSuspendedAccountFollowsWorker` is `Follower#mark_deleted!` (confirmed_at reset and Follower callbacks) for a live follow; a non-Integer user id hands back too. No debt line was open for it.

`PUT|PATCH /mobile/licenses/:id` no longer hands back an `enabled` that is an array or hash: Rails' boolean cast turns it into true (lane 16, Redis 60-64; example
"enables a disabled license when enabled is an array" recorded and replayed in `mobile-api.replay.test.ts`). No debt line was open for it.

Regenerate (the generator's own header has the DB setup: scratch database `gumroad_ws76` loaded from `db/schema.rb`,
Redis db 10):

```bash
USE_DB_WORKER_REPLICAS=true bundle exec ruby nextjs/src/server/mail/__fixtures__/generate-receipt-mailer-golden.rb
cd nextjs && npx vitest run src/server/mail
```

A regeneration redraws Message-IDs and MIME boundaries (the commit history shows earlier goldens were spliced
rather than regenerated for that reason); review the diff and keep only the two new cases if the rest churns.

No other golden gap was found by the checks above. The checks are heuristic (string literals in test lookups; helper calls
with literal names in generators), so they cannot see a case the generator should have but never defines, or a
`toBeGreaterThanOrEqual(n)` that has silently become loose.

Golden generators, for reference, and the command that rebuilds them (all run from the repo root):

- `nextjs/scripts/golden/*.rb` (51): `bundle exec rails runner nextjs/scripts/golden/<name>.rb` (or `bundle exec ruby ...` for `flags`, `geo-ip`, `paper-trail`, `public-suffix`, `serialize`, `countries`, `money-format`, `query-cache`, `ruby-uri`); each file's header lists its env (`REDIS_DB`, `RACK_ATTACK_REDIS_HOST`, `GOLDEN_DATABASE`).
- `nextjs/src/**/__fixtures__/generate-*.rb` and `nextjs/src/server/infra/__fixtures__/generators/*.rb`: mail, html, search (Elasticsearch through `es_recording_proxy.rb`), jobs, stripe, healthcheck, safe redirect, rails cookies; header of each file.
- `spec/presenters/product_presenter_golden_spec.rb`, `spec/services/product/editor_revision_golden_spec.rb`: `PARITY_GOLDEN=1 bin/rspec <spec>`.
- `nextjs/scripts/dump-*.rb` (10): `RAILS_ENV=test bin/rails runner nextjs/scripts/dump-<name>.rb`; they write `*.generated.json` constants, regenerate after any Rails change to the lists they read.
- `bin/golden <ruby-file> <spec.json>` for `nextjs/parity/golden/*.json`.

After a regeneration, `git diff` must be empty (except the two rental cases above). A diff means either Rails
changed since the file was written or the committed file was hand-edited: could not determine which for any
file; the diff will tell.

## 3. Feature flags

`routes.json` gates 188 flags. The proxy reads them from Flipper (`src/proxy.ts`; `NEXTJS_ROUTE_FLAGS=a,b` is
the local override the replays use). Server code reads no `nextjs_*` flag besides those in `routes.json` (the
only other literal, `nextjs_help`, appears in `proxy-gate.test.ts`). Other Flipper features the server reads
(`resend`, `force_resend_for_post_emails`, `buyer_local_currency`, `paypal_payout_fee`, `merchant_migration`,
`high_volume_seller_fee`, ...) are Rails' own features, not rewrite flags.

A flag is ready to enable when (a) the spec(s) in the second column have no missing fixtures, (b) the replay
in the third column is green with `PARITY_DATABASE_URL`, and (c) for flags marked $, the section 4 item for that
area is closed. Flags not listed under a replay are covered by the replay file in the group's row.

| Replay file (`parity/__tests__/...replay.test.ts`) | Spec fixtures it replays | Flags |
| --- | --- | --- |
| `healthcheck` (+ `healthcheck-purchases.test.ts`) | `controllers/healthcheck_controller_spec` | `nextjs_healthcheck`; `/api/health` is ungated |
| `help-center`, `help-center-signed-in`, `help-center-signed-in-gaps` | `controllers/help_center/*`, `help_center_signed_in_*` | `nextjs_help_center_articles`, `_category` |
| `settings-pages`, `settings-payments-profile` | `settings_*` page specs | `nextjs_settings_main`, `_team`, `_password`, `_social_connections`, `_third_party_analytics`, `_advanced`, `_billing`, `_authorized_applications`, `_payments`, `_profile`, `nextjs_oauth_application_edit` |
| `settings-mutations` | `settings_mutations_signed_in_spec` (13 missing, 1.1) | `nextjs_settings_advanced_writes`, `_billing_writes` $, `_third_party_analytics_writes`, `_dismiss_ai_promo_writes`, `_team_members_writes` $ |
| `auth-pages`, `auth-mutations` | `auth_*_parity_spec`, `review_reminders_parity_spec` (no fixtures) | `nextjs_auth_login`, `_signup`, `_two_factor`, `_secure_redirect`, `_confirmations`, `_devise_redirects`, `_login_writes`, `_logout`, `_passwords`, `_two_factor_writes`, `nextjs_review_reminders`, `nextjs_user_invalidate_sessions`, `nextjs_users_email_unsubscribe`, `nextjs_users_session_endpoints` |
| `oauth-integrations` | `oauth_applications_signed_in_spec`, `connections_signed_in_spec` | `nextjs_oauth_applications`, `nextjs_connections_unlink`, `nextjs_social_callbacks` |
| `ws11-public`, `public-pages`, `storefront-posts`, `storefront-profile`, `storefront-profile-products`, `ws11b`, `wishlists-mutations` | `public_*`, `seller_pages_spec`, `storefront_*`, `gumroad_blog_spec`, `post_redirect_spec` | `nextjs_acme_challenge`, `_crossdomain`, `_embedded_analytics_js`, `_favicon`, `_github_stars`, `_indexnow_key`, `_llms`, `_public_lookup_data`, `_public_working_webhook`, `_robots`, `_sellers_switch`, `_public_api`, `_public_charge`, `_public_license_key_lookup`, `_public_ping`, `_public_widgets`, `_gumroad_blog_index`, `_gumroad_blog_post`, `_post_redirect`, `_seller_pages_*`, `_storefront_posts`, `_storefront_profile`, `_post_views`, `_utm_link_tracking`, `_utm_links_writes`, `_wishlist_items_writes`, `_wishlist_unsubscribe`, `_wishlists_writes` |
| `seller-products`, `products-mutations`, `ws12b`, `ws12c`, `product-page` | `seller_products_*`, `product_page_parity_spec`, `seller_json_mutations_signed_in_spec` | `nextjs_products_index`, `_new`, `_edit` (6 missing), `_archived`, `_affiliated`, `nextjs_collabs`, `nextjs_products_writes`, `nextjs_affiliate_redirect`, `nextjs_customer_actions` $ (license writes), `nextjs_imported_customers`, `nextjs_review_responses`, `nextjs_bundles`, `nextjs_cart_items_count`, `nextjs_product_duplicates`, `nextjs_product_editor_json`, `nextjs_product_events`, `nextjs_tags`, `nextjs_product_page` |
| `audience-pages`, `audience-mutations` | `emails_*`, `workflows`, `followers_signed_in_spec`, UTM specs | `nextjs_emails`, `_emails_writes`, `_workflows`, `_workflows_writes`, `_followers`, `_utm_links_index`, `_utm_links_form` |
| `dashboard-home`, `dashboard-json`, `dashboard-pages`, `analytics-data`, `customers`, `customers-paged`, `seller-dashboard` | `dashboard_*`, `analytics_*`, `churn_signed_in_spec`, `customers_*`, `seller_dashboard_*` | `nextjs_dashboard`, `_dashboard_json`, `_events`, `_audience`, `_churn`, `_analytics`, `_analytics_data`, `_customers`, `_customers_paged` (6 missing), `_affiliates`, `_collaborators`, `_tax_center` $ |
| `discover` | `discover_parity_spec` (8 missing) | `nextjs_discover` |
| `communities`, `content-delivery-mutations` | `communities_*`, `library_mutations_signed_in_spec`, `content_delivery_json_signed_in_spec` | `nextjs_communities`, `_communities_writes`, `_library_writes`, `_dropbox_files`, `_media_locations`, `_s3_utility` |
| `buyer-pages` | `buyer_pages_parity_spec` | `nextjs_buyer_library`, `_buyer_invoice_confirm`, `_buyer_password_edit`, `_buyer_password_new`, `_buyer_reviews`, `_buyer_subscription_magic_link`, `_buyer_wishlists`, `_buyer_wishlists_following` |
| `checkout`, `checkout-payouts` | `checkout_parity_spec`, `payouts_signed_in_spec` (4 missing) | `nextjs_checkout`, `nextjs_payouts` $, `nextjs_subscription_manage` |
| `url-redirect-pages`, `url-redirects` | `url_redirect_*` (36 missing, 1.1) | `nextjs_url_redirect_*` (16 flags) $, `nextjs_url_redirect_writes` $, `nextjs_consumption_analytics` |
| `ws75-pages` | `agent_signed_in_spec`, `piracy_reports_signed_in_spec`, `dispute_evidence_signed_in_spec`, `generate_invoice_redirect_spec` | `nextjs_agent`, `_piracy_reports`, `_dispute_evidence`, `_dispute_evidence_success`, `_generate_invoice_redirect` |
| `internal-api` | `internal_api_parity_spec`, `internal_agent_parity_spec` | `nextjs_internal_agent`, `_internal_api_host`, `_internal_installments`, `_internal_product_files`, `_internal_product_posts`, `_internal_review_videos` |
| `ws17e-admin-api` | `controllers/api/internal/admin/*`, `admin_impersonate_parity_spec` | `nextjs_admin_api_auth`, `_campaigns`, `_piracy`, `_users`, `nextjs_admin_impersonate` (suspended-seller case missing, 1.2) |
| `api-v2-products`, `api-v2-ws17b`, `api-v2-ws17c`, `api-token-auth` | `api/v2/*_parity_spec`, `controllers/api/v2/*` | `nextjs_api_v2_*` (17 flags; licenses are not served in Node, see 4.6; `payouts_media` records the Polish and Bosnian IBAN-prefixed `bank_account_visual`, while Card and European destinations still hand back with no example) |
| `mobile-api`, `mobile-analytics` | `api/mobile/*_parity_spec` (37 missing, 1.1) | `nextjs_mobile_*` (17 flags); `nextjs_mobile_url_redirects` has no replay (1.2) |

Flag counts per row come from `routes.json`; the full flag-to-route list is `node -e` over that file. I did
not check that each flag's replay actually turns that flag on, except by name for the 161 flags the replay
files mention literally; the `api-v2-*` and `mobile-*` flags are built by string template in
`ROUTE_FLAGS` and were matched by hand.

## 4. Unproven items, money and security first

Ordered by impact. "Unproven" means: ported, with unit tests or partial vectors, but without a Rails
fixture or golden that covers the behaviour, or with the covering check not run.

1. **Signed S3/CloudFront/Cloudflare URLs** (`nextjs/src/server/controllers/url-redirects/files.ts`,
   `streaming.ts`, `server/infra/signed-urls.ts`). Security: a wrong signature, expiry or key choice either
   breaks every download or hands out a longer-lived link. `signed-urls.golden.json` pins the algorithms with a
   fake RSA key and a frozen clock. The delivery replay (`url-redirects.replay.test.ts`) masks `X-Amz-Date`,
   `X-Amz-Signature`, `Expires` and `Signature`, so no check ever compares a real signature, the expiry
   window per file size, or the production key/bucket/distribution selection. 36 of the delivery examples
   have no fixture (1.1). To close: record `url_redirect_delivery_gate_spec`, `url_redirect_download_page_spec`
   and the kindle examples, replay `url-redirects` and `url-redirect-pages` against minio (the replay seeds
   `SPEC_OBJECTS` itself), then sign one URL per type in a staging environment and fetch it. Stamped PDFs,
   rich content, variants and preorders deliberately hand back (`files.ts` top comment).
2. **Chargeback-rate payout reserve** (`server/page-props/payouts/payouts.ts`: `chargebackRateReserveCents`,
   `payableCentsUnderReserve`, `reserveBreakdown`). Money: it decides how much a seller sees as payable.
   Vectors in `payout-reserve.test.ts` are copied from the Ruby specs, not recorded. The four `payouts_signed_in_spec`
   examples at :251-:283 (whole rows under 75 percent, leftover on the waiting line, below the minimum, reserve
   anchored on what was already paid) have no fixture. The `paidCentsUnderChargebackRateHold` SQL (payments in
   `creating/processing/unclaimed/completed`) has no Rails comparison at all. The page only reads; no payout
   execution is ported. Cached balance stats: only the miss is ported (live compute plus the refresh job, two recorded examples,
   job compared in `checkout-payouts.replay.test.ts`); a blob that exists is read and handed back, so the cached-blob path has no Rails comparison.
3. **Sales tax rounding and validation** (`server/tax/sales-tax-calculation.ts`, `regional-vat-id-shape.ts`,
   `sales-tax-countries.ts`). Money: `lookupTaxCents` rounds half away from zero in BigInt arithmetic; its tests
   are `customer_surcharge_controller_spec` vectors "then derived half-up cases", i.e. the extra cases are
   reasoned, not recorded. The Bahrain, Kenya, Nigeria and Tanzania id validators and `regionalVatIdValidator` routing
   are "derived from the Ruby source" in `sales-tax.test.ts`. No tax golden or fixture exists for them. TaxJar,
   `ZipTaxRate`, GeoIP and vendor validators hand back. Close with a golden generator that calls
   `SalesTaxCalculator` and the validators on the same inputs (none exists in `nextjs/scripts/golden`).
   Recorded 2026-11-10 (lane 15): the empty 400 typed by a registered `format` param (`xml`, `text`, `js`). Disproved by recording:
   a Singapore rate with an empty `applicable_years` is not served as `[]` (`json_data_for_attr` reads a blank list as nil, so
   Rails raises `NoMethodError` on `include?`); the Node hand-back is right and stays. A missing or empty `products` renders
   the exceptions app, whose test-env body (debug page, `text/plain`) differs from production's, so a fixture cannot pin it.
4. **Billing and team writes** (`settings-mutations.ts`, `server/models/billing-detail.ts`,
   `policies/settings/billing.ts`). Security and compliance: they write billing details and change team roles,
   remove and restore members. The 13 examples in 1.1 (billing :255-:277, team :348-:401) have no fixture, so
   no check compares the rows written, the `versions`/jobs enqueued or the policy refusals ("refuses a member whose
   role cannot manage the team"). Replays ignore `db.versions` because specs run with PaperTrail off, so audit
   rows are unproven for every write in this list.
5. **Receipt mailer rental redirect** (`server/mail/mailers/receipt-mailer.ts:61`, `receipt-presenter.ts:318`).
   `RENTAL_REDIRECT_PROVEN = false` makes a rental with a rental url_redirect throw `MailViewNotPortedError`, so
   it hands back to Rails (safe default). To flip: regenerate the golden (section 2), confirm
   `receipt-presenter.test.ts` ("offers View content ... Watch ...") and the receipt replay pass, including the
   position of the `product_files` read (`receipt-mailer.ts:354`, "not recorded from Ruby"), then set the constant
   to `true` and delete the UNPROVEN comments and the README paragraph.
6. **License writes** (`server/models/license.ts`, `controllers/customer-actions.ts`, mobile
   `PUT|PATCH /mobile/licenses/:id`). Security and money-adjacent: disable, enable, set, adjust and reset uses.
   Fixtures exist (`seller_json_mutations_signed_in_spec` x11, `mobile_api_parity_spec` x4) but the replays have
   not been run; `ws12b.replay.test.ts` and `mobile-api.replay.test.ts` cover them. `Licenses` writes a
   PaperTrail version (`disabled_at`, `serial`) that the replay cannot compare (above). `License#rotate!`, license
   creation and the public API `licenses#verify|enable|disable|decrement_uses_count|rotate` are not ported (they
   need `Purchase#payload_for_ping_notification`); `controllers/api/v2/licenses_controller_spec` has 53 recorded
   fixtures and no replay or Node handler, so nothing proves those today.
7. **Everything above the line is replay-unverified.** Step 0 below replays all 1,759 existing fixtures. Until
   then treat even "proven by replay" in `workstreams.md` as unconfirmed here.

Smaller items noted in the code, none money or security: `models/README.md:380` (lock timeout retry path has
no golden), `models/README.md:487` (`page-props/signed-in/reads.ts` carries a looser copy of a flags read that no
golden pins), `discover.replay.test.ts` header says the replayer only rebuilds `products` and `purchases` while
`parity/README.md` and the recorder (`ES_ONLY_SORTS`) now cover `ProductPageView`; could not determine whether the
header is stale. Re-check before recording the Discover autocomplete and recently viewed examples.

## Recommended order

Bring-up, once: MySQL with `db/schema.rb` loaded into a disposable `parity_test`, Redis, Elasticsearch 7.17, minio
or an S3 test bucket, DynamoDB local, `bundle install`, `npm ci` in `nextjs/`, and a `.env.test` at the repo root.

0. **Baseline replay of what exists.** No recording yet.
   ```bash
   cd nextjs
   PARITY_DATABASE_URL=mysql://root:password@127.0.0.1:3306/parity_test npm run parity
   ```
   Fix or log every failure first: a red existing replay means a merged port is wrong, and it would hide
   failures in step 1. Do the same for `npm test` (unit tests) and `node scripts/typecheck.ts`.
1. **Money and security recordings** (these gate the largest-impact flags):
   ```bash
   PARITY_RECORD=1 bin/rspec spec/requests/payouts_signed_in_spec.rb
   PARITY_RECORD=1 bin/rspec spec/requests/url_redirect_delivery_gate_spec.rb spec/requests/url_redirect_download_page_spec.rb spec/requests/url_redirects_parity_spec.rb
   PARITY_RECORD=1 bin/rspec spec/requests/settings_mutations_signed_in_spec.rb
   cd nextjs && PARITY_DATABASE_URL=... npx vitest run --config parity/vitest.config.ts parity/__tests__/checkout-payouts.replay.test.ts parity/__tests__/url-redirect-pages.replay.test.ts parity/__tests__/url-redirects.replay.test.ts parity/__tests__/settings-mutations.replay.test.ts
   ```
2. **Receipt rental golden** (section 2 command), then flip `RENTAL_REDIRECT_PROVEN` and replay `src/server/mail`.
3. **Mobile API** (largest block, 37 examples):
   ```bash
   PARITY_RECORD=1 bin/rspec spec/requests/api/mobile/mobile_api_parity_spec.rb spec/requests/api/mobile/mobile_purchases_sales_parity_spec.rb spec/requests/api/mobile/mobile_products_subscriptions_parity_spec.rb
   cd nextjs && PARITY_DATABASE_URL=... npx vitest run --config parity/vitest.config.ts parity/__tests__/mobile-api.replay.test.ts
   ```
4. **Auth and audience**: `review_reminders_parity_spec.rb` (replay `auth-mutations`), `customers_paged_signed_in_spec.rb`
   (replay `customers-paged`).
5. **Pages**: `seller_products_edit_signed_in_spec.rb` (`seller-products`), `storefront_profile_products_parity_spec.rb`
   (`storefront-profile-products`), `discover_parity_spec.rb` (`discover`, needs Elasticsearch and the
   `ProductPageView` index).
6. **The two gaps outside the tagged specs** (1.2).
7. **Close-out**: `cd nextjs && node scripts/parity-debt.ts` must end with `0 without a fixture, 0 unresolved`;
   `git status` shows only new fixture files plus the receipt golden; `npm run parity` is green with
   `PARITY_DATABASE_URL`. Only then walk the flag table in section 3 and enable flags in staging, lowest
   blast radius first (reads, then JSON writes, then the $ flags last, each with the shadow period README.md
   requires).

Record fixtures on one machine in one sitting where possible: fixtures embed the recording app's
`secretKeyBase` and `recordedOn`, and a spec that records times far from `travel_to` re-records with a
different offset each day (see the Limits section of `nextjs/parity/README.md`).
