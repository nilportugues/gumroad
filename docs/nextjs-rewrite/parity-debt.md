# Parity debt

> **Status 2026-11-10.** The sections below were written when no environment could run Rails or the replays, and are kept as the
> history of what was unproven. They have since been closed against a real stack (setup in [parity-local-stack.md](parity-local-stack.md)):
> every tagged example has a fixture (`node scripts/parity-debt.ts` reports 0 without one) and all 59 replay files pass (2,758 tests).
> What is open now is in [parity-tasks.md](parity-tasks.md) and the "Open items" of [workstreams.md](workstreams.md). The counts
> table is current; sections 1 to 4 describe the state at `b8fbe3067` unless a line says otherwise.

## Counts

| | Count |
| --- | ---: |
| Spec files containing `parity: true` | 102 |
| Examples tagged `parity: true` | 1,932 |
| Of those, with a fixture | 1,932 |
| Of those, without a fixture | 0 |
| Fixture files (incl. `PARITY_RECORD=all` controller specs) | 2,746 |
| Replay test files | 51 (59 test files in the parity run) |
| Replay result | 59 files, 2,758 tests passed, 12 skipped, 0 failed |

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
| WS-17h | `api/mobile/mobile_purchases_sales_parity_spec.rb` (whole file) | 21 of 21 | `nextjs_mobile_purchases`, `nextjs_mobile_sales` | `R mobile-api.replay.test.ts` |
| WS-17k | `api/mobile/mobile_products_subscriptions_parity_spec.rb` (whole file) | 16 of 16 | `nextjs_mobile_products`, `_subscriptions`, `_preorders`, `_installments` | `R mobile-api.replay.test.ts` |
| WS-23b | `payouts_signed_in_spec.rb` :251-:283 (chargeback-rate reserve) | 4 of 28 | `nextjs_payouts` | `R checkout-payouts.replay.test.ts` |

Total: 119. Exact example names: `node scripts/parity-debt.ts`.

### 1.2 Known gaps outside the tagged specs

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

`delete-wishlist-products-job.golden.json` was re-recorded on lane 17 (`gumroad_test_17`, Redis 47) with the real `WishlistProduct#mark_deleted!`; the job runs in Node. Left: a wishlist product with a variant, recurrence, quantity above one or rent, or of a rentable or recurring product (the unported `WishlistProduct` validations) hands back.

`discover_parity_spec.rb` gained two affiliate-cookie examples (`?affiliate_id=` on the root page, `?a=` of a global affiliate on a search box visit), recorded on lane 16 (`gumroad_test_16`, Redis 61-63, replay Redis 60, `PARITY_ES_INDEX_SUFFIX=-c16`); `discover.replay.test.ts` checks the cookie value is the replay's own second, as `ws12b.replay` does. They close the discover affiliate-param hand-back; no debt line was open for it.

`schedule-affiliate-workflows.golden.json` was regenerated on lane 15 (`gumroad_test_15`, Redis 56-58, `PARITY_ES_INDEX_SUFFIX=-c15`) with seven token cases (Integer, 2**70, negative, true, false); the 40 existing cases are unchanged. `ScheduleAffiliateWorkflowJobsJob` still hands back a Float, Array or Hash token (Rails casts an Array to an IN list). No debt line was open for it.

Variant workflows (`POST /workflows`, `PUT /workflows/:id` with `workflow_type: "variant"`) run in Node: `Workflow::ManageService` looks the option up with `BaseVariant.find_by_external_id` (`findBaseVariantId` in `workflow-manage.ts`; an id that does not decrypt looks up `id IS NULL`, so the workflow keeps no option, and an unpublished workflow's emails follow the new option). The old hand-back example is replaced by three recorded examples in `workflows_mutations_signed_in_spec.rb` (create, repoint with emails, unknown option id), recorded on lane 15 (`gumroad_test_15`, Redis 56-59) and replayed in `audience-mutations.replay` (42 tests pass); the `save-installment.golden.json` case "workflow create: a variant workflow" now runs instead of being refused. Still handing back: a `variant_external_id` that is not text. Posts of type variant followed (see below). No debt line was open for it. Three older examples of that spec (follower/affiliate, paid filters out of order, accountant) failed while recording on lane 15 because of leftover rows in `gumroad_test_15`; their fixtures were left untouched.

Posts (emails) of type variant (`POST /emails`, `PUT /emails/:id` with `installment_type: "variant"`) run in Node: `SaveInstallmentService#save_installment` sets `base_variant` from `BaseVariant.find_by_external_id(params[:variant_external_id])`, the same lookup as the workflow (`findBaseVariantId` moved from `workflow-manage.ts` to `save-installment.ts`, still re-exported; an id that does not decrypt looks up `id IS NULL` and the post keeps no option). Six cases were added to `save-installment.golden.json` (lane 15, `gumroad_test_15`, Redis 56, `PARITY_ES_INDEX_SUFFIX=-c15`; the 108 existing cases are byte-identical) and three recorded examples to `emails_mutations_signed_in_spec.rb` (create, unknown option id, repoint a draft), replayed in `audience-mutations.replay`. No debt line was open for it. A `variant_external_id` that is not text still hands back, for posts too.

Three examples in `spec/requests/settings_mutations_signed_in_spec.rb` (a boolean `facebook_pixel_id`, a boolean `notification_endpoint`, boolean billing detail fields) were recorded on lane 15 (`gumroad_test_15`, Redis 56-59, `PARITY_ES_INDEX_SUFFIX=-c15`) and replay green in `settings-mutations`. Closed: `stringValue` cast a boolean to `"t"`/`"f"` for every column, but Rails gives `"1"`/`"0"` on a varchar column and `"t"`/`"f"` on a text one. It now takes the column kind (varchar by default; `notification_endpoint` and billing `additional_notes` are text). `facebook_pixel_id: true` saves `"1"` in Rails (the pixel regex accepts it) where Node failed validation on `"t"`; a boolean Google Analytics id or meta tag fails validation either way, so only the pixel id and the billing fields show it. The new fixtures use the replay secret key base; the 38 existing ones were left as recorded.

The product page (`product_page_parity_spec.rb`) no longer hands an ebook back: `setMeta` builds the JSON-LD `Book` (author, `workExample` per alive epub/pdf/mobi file in position order, with its ISBN) as `Product::StructuredData#build_ebook_structured_data` does. One example ("renders an ebook with its book files in the structured data") was recorded on lane 16 (`gumroad_test_16`, Redis 61-63) and replays green in `product-page` (54 tests); with the port reverted the replay hands the page back and fails.

The product page no longer hands a non-USD product back: `setMeta` prices the JSON-LD `Offer` as `Product::StructuredData#build_offer_data` does (USD from the cached rate when one is stored, else the product's own currency and amount, divided by `unit_scaling_factor`; `cachedRate` reads Redis only and never fetches) and `product:price:amount` divides by the currency's unit factor instead of 100. One example ("renders a euro product with its price converted to dollars in the structured data", the stored EUR rate seeded from the fixture's Redis) was recorded on lane 16 and replays green in `product-page` (55 tests); with the port reverted the replay hands the page back and fails. The no-rate fallback (own currency and amount) and single-unit currencies are covered by unit tests only. Still handing back: a product with asset previews or profile sections, and the `layout`, `embed` and `overlay` params.

The seller's own product page (the editing props) no longer hands back when the seller has posts: `posts` is `ProfileSectionsPresenter#visible_posts` (alive, published, workflow-free audience posts with `shown_on_profile`, `published_at DESC, id ASC`, at most 999; `{id, name, slug, published_at}`), shared with the settings profile through `visiblePosts` and the pure `shownProfilePosts` in `page-props/settings/profile.ts` (4 unit tests in `profile.test.ts`). One example ("lists the posts a profile section could show in the seller's edit controls": two shown posts out of order plus a hidden one) was recorded on lane 16 (`gumroad_test_16`, Redis 61-63, replay Redis 60, `PARITY_ES_INDEX_SUFFIX=-c16`) and replays green in `product-page` (56 tests); with the port reverted the replay hands the page back and fails. No debt line was open for it.

`Installment#validate_call_to_action_url_and_text` runs in Node (`installment-writes.ts`; the `URI.regexp` pattern moved to `src/lib/ruby-uri-regexp.ts`, shared with the custom field writes). A post with a call to action no longer hands back from `PUT /emails/:id`, the workflow email writes or `PublishScheduledPostJob`: text missing, link missing or not an http(s) address add the two Rails messages, and blank text/link are judged with `[[:space:]]` (Unicode `White_Space`, not ASCII only). Three examples in `emails_mutations_signed_in_spec.rb` (valid call to action kept, link without text, link that is not a web address) were recorded on lane 21 (`gumroad_test_21`, Redis 42-45, replay Redis 41, `PARITY_ES_INDEX_SUFFIX=-c21`) and replay in `audience-mutations`; six cases were added to `publish-scheduled-post.golden.json` (the existing cases are byte-identical) and the valid-link case is no longer in the test's hand-back list. No request sets the call to action, so only a post that already carries one (legacy rows) reaches this validation. No debt line was open for it.

`delete-product-files-archives-worker.golden.json` was recorded on lane 15 (`gumroad_test_15`, Redis 56-59, `PARITY_ES_INDEX_SUFFIX=-c15`). The one remaining
hand-back of `DeleteProductFilesArchivesWorker` is `ProductFilesArchive#mark_deleted!` (PaperTrail, CdnDeletable); a deleted SKU (Rails fails on a
Mysql2 unknown-column error) and non-Integer ids hand back too. A variant without a category, a missing category row (NoMethodError) and a category without a product
(RecordNotFound `Couldn't find Link without an ID`) now fail in Node like Ruby: six new golden cases on lane 15, the 28 existing ones unchanged. No debt line was open for it.

`remove-suspended-account-follows-worker.golden.json` was recorded on lane 15 (`gumroad_test_15`, Redis 56-58, `PARITY_ES_INDEX_SUFFIX=-c15`). The one remaining
hand-back of `RemoveSuspendedAccountFollowsWorker` is `Follower#mark_deleted!` (confirmed_at reset and Follower callbacks) for a live follow; a non-Integer user id hands back too. No debt line was open for it.

`delete-expired-oauth-device-authorizations-job.golden.json` was recorded on lane 20 (`gumroad_test_20`, Redis 36-39, `PARITY_ES_INDEX_SUFFIX=-c20`). `DeleteExpiredOauthDeviceAuthorizationsJob` has no hand-back; no debt line was open for it.

`flush-delivered-email-infos-job.golden.json` was recorded on lane 20 (`gumroad_test_20`, Redis 37 for `REDIS_HOST` and `SIDEKIQ_REDIS_HOST`, `PARITY_ES_INDEX_SUFFIX=-c20`); its replay needs `JOBS_REDIS_URL` and is skipped without it. The one hand-back of `FlushDeliveredEmailInfosJob` is a buffer entry that is not `{i, p, t}` integers (never written by `EmailInfo.buffer_delivered`); no debt line was open for it.
`DELETE /v2/products/:link_id/variant_categories/:id` (`nextjs_api_v2_products`) runs in Node, audit row included (see "Variant category destroy" in workstreams.md). Three examples in `products_api_resource_writes_parity_spec.rb`, recorded on lane 16 (`gumroad_test_16`, Redis 61-63, `PARITY_ES_INDEX_SUFFIX=-c16`) and replayed in `api-v2-products` (66 tests pass); with `routes.json` reverted three of them fail. No debt line was open for it.

`PUT|PATCH /mobile/licenses/:id` no longer hands back an `enabled` that is an array or hash: Rails' boolean cast turns it into true (lane 16, Redis 60-64; example
"enables a disabled license when enabled is an array" recorded and replayed in `mobile-api.replay.test.ts`). No debt line was open for it.

`DELETE /links/:id` (`nextjs_products_writes`) no longer hands back a product with public files: `Link#delete!` runs `alive_public_files.update_all(scheduled_for_deletion_at: 10.minutes.from_now)`, ported as `schedulePublicFilesForDeletion` (no `updated_at` change, the file rows are not soft-deleted). Example "schedules the public files of a deleted product for deletion" recorded and replayed in `products-mutations.replay.test.ts` (lane 15, Redis 55-59). Still handing back: a product shown in a profile section and one with a custom domain. No debt line was open for it.

`POST /links/:id/unpublish` by a collaborator on the product runs in Node (`fetch_product_and_enforce_access` accepts `logged_in_user.collaborator_for?(product)`; `find` no longer raises `NotPortedError` for it, and `authorize` judges the collaborator by their own account role, as Rails does). A collaborator on a different product of the same seller still answers 404. Two examples in `products_mutations_signed_in_spec.rb`, recorded on lane 15 (`gumroad_test_15`, Redis 56-59, `PARITY_ES_INDEX_SUFFIX=-c15`) and replayed in `products-mutations.replay` (25 tests pass). No debt line was open for it.

`PUT /links/:id/sections` (`LinksController#update_sections`, `nextjs_products_writes`) runs in Node for the owner, a team member with `update?` and a collaborator on the product (`find(input, "access", ...)` now also hands the collaborating set to the policy; `linkPolicy.update` is `LinkPolicy#update_sections?`). It stores the decrypted ids and `main_section_index.to_i` in the product's `json_data` (`Link` saves may now change the `sections` and `main_section_index` keys of `json_data` and no others; any other key still raises `NotPortedError`), then deletes the product's `seller_profile_sections` the list leaves out, in one transaction, and answers 204. Rails draws the route for the discover host and seller domains only (`product_info_and_purchase_routes`), so Node serves it on the discover host and hands the app host (Rails: 404) and seller subdomains/custom domains back, and so it does a section id that does not decrypt (Rails stores `nil`) and a `main_section_index` that is not text, a number or null. Four examples in `products_mutations_signed_in_spec.rb` (collaborator reorders and drops a section; owner empties the list and keeps another product's section; collaborator on another product: 404; accountant: 401), recorded on lane 15 (`gumroad_test_15`, Redis 56-58, `PARITY_ES_INDEX_SUFFIX=-c15`) and replayed in `products-mutations.replay` (29 tests pass; with the `json_data` allowance reverted the two writing examples fail). Still in Rails for collaborators: `POST /links/:id/update`, `publish`, `release_preorder` and `disable_downloads_for_all_files` (none is registered in Node at all: they need the product save pipeline, `Link#publish!`, preorder release charges, and `ProductFile` writes with `GenerateProductFilesArchivesJob`), and `Link#collaborator_for_display` (`assertNoCollaborator` in `product-props.ts`, which gates the product page, not these writes). No debt line was open for it.

`GET /internal/products/:product_id/existing_product_files` by a collaborator on the product runs in Node when the owner's library has no live file (`collaboratingProductIds`, the same check as `fetch_product_and_enforce_access`); a user who neither owns nor collaborates on the product gets the 404 Rails' `e404` gives, no longer a hand-back. Three examples in `internal_api_parity_spec.rb`, recorded on lane 15 (`gumroad_test_15`, Redis 56-59, `PARITY_ES_INDEX_SUFFIX=-c15`) and replayed in `internal-api.replay` (105 tests pass). The remaining hand-back is a library with files (`ProductFile#as_json(existing_product_file: true)`; for a collaborator Rails also narrows the list to the product). No debt line was open for it.

`DELETE /links/:id` also runs the rest of `Link#delete!` in Node: `clear_featured_product_sections!` (drops `featured_product_id` from featured-product sections), `remove_from_profile_sections!` (strips the id from every products section of the seller under the `seller_profiles` row lock) and `custom_domain&.mark_deleted!` (the existing `CustomDomainDeletable`). Three examples replace "hands a deletion of a product shown in a profile section back to Rails" (its fixture is deleted): products sections, featured section, custom domain, recorded on lane 15 (`gumroad_test_15`, Redis 56-59, `PARITY_ES_INDEX_SUFFIX=-c15`) and replayed in `products-mutations.replay` (23 tests pass). The custom domain example pins `created_at`/`updated_at` in the past: the column has second precision, so a row created in the replay's own second would show no `updated_at` change. Still handing back: nothing on this route; a profile section whose `json_data` already breaks its schema raises `NotPortedError` before the first write (JSON::Validator's messages are not reproduced). No debt line was open for it.

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
| `ws17e-admin-api` | `controllers/api/internal/admin/*`, `admin_impersonate_parity_spec` | `nextjs_admin_api_auth`, `_campaigns`, `_piracy`, `_users`, `nextjs_admin_impersonate` |
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
6. **The gap outside the tagged specs** (1.2).
7. **Close-out**: `cd nextjs && node scripts/parity-debt.ts` must end with `0 without a fixture, 0 unresolved`;
   `git status` shows only new fixture files plus the receipt golden; `npm run parity` is green with
   `PARITY_DATABASE_URL`. Only then walk the flag table in section 3 and enable flags in staging, lowest
   blast radius first (reads, then JSON writes, then the $ flags last, each with the shadow period README.md
   requires).

Record fixtures on one machine in one sitting where possible: fixtures embed the recording app's
`secretKeyBase` and `recordedOn`, and a spec that records times far from `travel_to` re-records with a
different offset each day (see the Limits section of `nextjs/parity/README.md`).

Library `?purchase_id=` (WS-16, lane 16: `gumroad_test_16`, Redis 61-63, `PARITY_ES_INDEX_SUFFIX=-c16`) runs in Node: `receipt_purchases` comes from `LibraryPresenter#receipt_purchases` (library-visible purchase, membership access, receipt/all `ThirdPartyAnalytic` on the product or its seller) and `purchase_analytics` is `{}` unless the seller has a pixel id (below). Three recorded examples in `buyer_pages_parity_spec.rb` (tracked purchase, receipt analytics flag, purchase not in the library) replay in `buyer-pages.replay` (39 tests pass). `PurchaseSellerAnalyticsPresenter#props` is now ported (`purchaseAnalyticsProps` in `library.ts`) for a USD purchase of a USD product with no `purchase_presentments` row; two more recorded examples (Google Analytics + Facebook ids; TikTok id with quantity 2, `tax_cents` 150 and `skip_free_sale_analytics`) replay green (41 tests pass). Still handing back: a pixel-id seller's purchase displayed or priced in another currency (`usd_cents_to_currency` rates), a purchase with a buyer-currency presentment row (`buyer_presentment_*` event fields), and a seller opted into buyer-local currency (`buyerCurrencyDisplayProps` throws `NotPortedError`). Only the first `purchase_id` is read (a flat query keeps the last one), not the controller's `MAX_TRACKED_PURCHASE_ANALYTICS` list. No debt line was open for it; the subscriptions tab and bundle filters with a download page are unchanged. The 'purchase_id' hand-back that `LIBRARY_OPTIONS` had for any value is gone. Verified by reverting the three source files: the 12 new unit tests and 3 new replays fail.

Signed-out wishlist writes (WS-11e, lane 17: `gumroad_test_17`, Redis 46-50, `PARITY_ES_INDEX_SUFFIX=-c17`) run in Node: `POST/PUT/PATCH/DELETE /wishlists`, `/wishlists/:id`, `/wishlists/:id/followers` and `/wishlists/:id/products[/:id]` without a session answer `authenticate_user!` (`signedOutRefusal` in `wishlists-mutations.ts`): `e404_json` for a JSON request, else a 302 to `/login?next=<fullpath>` (303 for an Inertia PUT/PATCH/DELETE), before any wishlist lookup. They were the "a signed-out wishlist request" hand-backs. Nine recorded examples (`when signed out` in `wishlist_items_mutations_signed_in_spec.rb` and `wishlists_mutations_signed_in_spec.rb`) replay in `ws11b.replay` (53 tests) and `wishlists-mutations.replay` (21 tests), plus 5 unit tests in `wishlists-signed-out.test.ts`. Reverting the two controller files fails all 9 new replays. A signed-out request in a format the port does not model (an XHR asking for neither JSON nor HTML) still hands back, as does a signed-in request with no current seller. No debt line was open for it.
`User#has_brazilian_stripe_connect_account?` (WS-10/WS-12, lane 19: `gumroad_test_19`, Redis 31-34, replay Redis 30, `PARITY_ES_INDEX_SUFFIX=-c19`) runs in Node (`hasBrazilianStripeConnectAccount` in `dashboard/payout-info.ts`). `merchant_account(stripe)` is the first live Connect account only when `merchant_migration_enabled?` holds (the `check_merchant_account_is_linked` flag, or the `merchant_migration` feature plus a Connect-supported routing country, legal-entity routed under `stripe_connect_routing_by_legal_entity_country`) and a Gumroad-managed account otherwise, so the answer is whether that Connect account's country is `BR`. It handed back for any Brazilian Connect account; the collaborators and affiliates pages (`collaborators_disabled_reason`, `affiliates_disabled_reason`), the collab and affiliated product pages and `POST /customer_surcharge` no longer do. Four examples recorded in `seller_dashboard_collaborators_signed_in_spec.rb` and `seller_dashboard_affiliates_signed_in_spec.rb` (linked: reason shown; not linked: reason nil) replay in `seller-dashboard.replay` (51 tests pass). No debt line was open for it. Verified by reverting `payout-info.ts`: the new unit tests and the 4 replays fail. The `merchant_migration` Flipper branch has no fixture (the recorder cannot seed Redis feature state) and is unit-tested only; the collab and affiliated product pages and the surcharge path have no Brazilian fixture either.
`DELETE /mobile/sales/:id/review_response` (`nextjs_mobile_sales`) runs in Node (see "Mobile review response destroy" in workstreams.md). Five examples in `mobile_purchases_sales_parity_spec.rb`, recorded on lane 20 (`gumroad_test_20`, Redis 35-38, `PARITY_ES_INDEX_SUFFIX=-c20`) and replayed in `mobile-api` on `gumroad_replay_20` (Redis 39); with `routes.json` reverted four of them fail. Hand-back left: a subscription's or gift sender's sale. No debt line was open for it.
Library `?purchase_id=` (WS-16, lane 16: `gumroad_test_16`, Redis 61-63, `PARITY_ES_INDEX_SUFFIX=-c16`) runs in Node: `receipt_purchases` comes from `LibraryPresenter#receipt_purchases` (library-visible purchase, membership access, receipt/all `ThirdPartyAnalytic` on the product or its seller) and `purchase_analytics` is `{}` unless the seller has a pixel id (below). Three recorded examples in `buyer_pages_parity_spec.rb` (tracked purchase, receipt analytics flag, purchase not in the library) replay in `buyer-pages.replay` (39 tests pass). `PurchaseSellerAnalyticsPresenter#props` is now ported (`purchaseAnalyticsProps` in `library.ts`) for a USD purchase of a USD product with no `purchase_presentments` row; two more recorded examples (Google Analytics + Facebook ids; TikTok id with quantity 2, `tax_cents` 150 and `skip_free_sale_analytics`) replay green (41 tests pass). Still handing back: a pixel-id seller's purchase displayed or priced in another currency (`usd_cents_to_currency` rates), a purchase with a buyer-currency presentment row (`buyer_presentment_*` event fields), and a seller opted into buyer-local currency (`buyerCurrencyDisplayProps` throws `NotPortedError`). A `purchase_id[]` list is now read in full (see below). No debt line was open for it; the subscriptions tab and bundle filters with a download page are unchanged. The 'purchase_id' hand-back that `LIBRARY_OPTIONS` had for any value is gone. Verified by reverting the three source files: the 12 new unit tests and 3 new replays fail.

Library `?purchase_id[]=` lists (lane 16) run in Node: `queryParamStrings` reads `Array(params[:purchase_id]).select(String)` (a flat key keeps the last value, `purchase_id[]` keys each value), `trackedPurchaseIds` keeps the first `MAX_TRACKED_PURCHASE_ANALYTICS` (50) and drops ids that do not decrypt, and `purchaseAnalyticsProps` / `receiptPurchases` answer for every id the buyer owns, ordered by purchase id as `by_external_ids` returns them. `assertFlatQuery` takes `arrayParams` so only `purchase_id[]` escapes the bracketed-query hand-back (`creators[]` and the like still hand back). Still handing back: a flat `purchase_id` mixed with `purchase_id[]` (Rack raises ParameterTypeError), `purchase_id[key]` hashes and `;` separated queries. A seventh example in `buyer_pages_parity_spec.rb` (two sellers' purchases plus an undecodable id, passed out of order) was recorded on lane 16 and replays green in `buyer-pages.replay` (42 tests). A hand-back replays green too, so the unit tests carry the proof: with the five source files reverted, the new `rails-request.test.ts`, `library-route.test.ts` and `library-tracked.test.ts` cases fail. Non-USD purchases and products still hand back (the rates file / Redis cache port is the next piece). No debt line was open for it.
A product page whose product has a collaborator runs in Node: `collaboratorForDisplay` in `product-props.ts` is `Link#collaborator_for_display` (an undeleted `Collaborator` whose invitation was accepted, shown unless `Collaborator#show_as_co_creator_for_product?` is false: the affiliate's `dont_show_as_co_creator` flag when `apply_to_all_products`, the `affiliates_links` row's otherwise) and `collaborating_user` is that user's `author_byline_props`. The `assertNoCollaborator` hand-back is gone. Four examples in `product_page_parity_spec.rb` (credited collaborator, opt-out on every product, opt-out on this product, pending invitation), recorded on lane 15 (`gumroad_test_15`, Redis 56-58, `PARITY_ES_INDEX_SUFFIX=-c15`) and replayed in `product-page.replay` (60 tests pass; with the port reverted the four fail). Six unit tests in `product-props-collaborator.test.ts`. The product and bundle edit pages followed (below). No debt line was open for it.

The product edit page (`Products/Edit`) and the bundle editor (`Bundles/Product/Edit`, `Bundles/Share/Edit`) run in Node for a product or bundle with a collaborator, for the owner and for the collaborator. `collaborating_user` is `collaboratingUserProps` in `seller-products/edit.ts` (`collaboratorForDisplay`, then `author_byline_props`). `ProductPresenter#collaborator_editing?` (the viewer's seller is not the owner) changes three things: `existing_files` stops at the product's own files (already empty, since a `product_files` row is a blocker), `waitlist` is nil, and `current_seller_external_id` is the collaborator's account (already `context.currentSeller`). So `editBlockers` takes a `collaboratorEditing` flag that drops the `existing_files` and `waitlist` probes, and `assertEditSupported`/`assertBundleEditSupported` no longer hand back a viewer other than the owner. The `collaborator` row probe and the `is_collab` flag blocker are removed from both editors (`is_collab` does not enter `eligible_for_installment_plans?`). Seven examples in `seller_products_edit_signed_in_spec.rb` (credited collaborator, opt-out on every product, opt-out on this product, pending invitation, a collaborator editing the owner's product, the bundle editor for the owner and for the collaborator), recorded on lane 15 (`gumroad_test_15`, Redis 56-58, `PARITY_ES_INDEX_SUFFIX=-c15`) and replayed in `seller-products.replay` (90 tests pass). `seller-products.replay` now enables `nextjs_bundle_editor`: these are the first recorded bundle-editor visits, and they found one difference, fixed here: Rails puts the bundle's `title` meta tag after the application-level tags (`Bundles::BaseController` redeclares `set_default_page_title`, which Rails moves to run last), so `bundles/pages.ts` calls `meta.moveToEnd(["title"])`. The bundle examples pin the bundled products' `created_at`, which the editor lists. The other bundle-editor states (versions, SKUs, files, covers, an offer code) are still only unit-tested. Verified by reverting the source files: the new unit tests and the seven replays fail. No debt line was open for it.

`POST /settings/payments/opt_in_to_au_backtax_collection` (WS-10, lane 21: `gumroad_test_21`, Redis 42-45, replay Redis 41, `PARITY_ES_INDEX_SUFFIX=-c21`) runs in Node (`settings-payments-mutations.ts`). Twelve examples in `spec/requests/settings_payments_backtax_opt_in_spec.rb`, replayed in `settings-mutations.replay`: individual and business legal names, a missing compliance revision, a business with no name (check skipped), characters outside the basic plane and accented ones (Ruby counts characters), the team admin's audit note, the 401 and 403 answers, and two hand-backs (a blank signature and no signature: Rails answers 422 through RecordInvalid; a non-text signature has no example). No debt line was open for it.

`User#has_valid_payout_info?` for a Stripe Connect or PayPal Connect seller (WS-10, lane 19: `gumroad_test_19`, Redis 31-34, replay Redis 30, `PARITY_ES_INDEX_SUFFIX=-c19`) runs in Node (`hasValidPayoutInfo` in `dashboard/payout-info.ts`), which the collaborators page reads for each collaborator's `setup_incomplete`. It handed back for any live Connect account. Now a linked (`merchant_migration_enabled?`) non-Brazilian Stripe Connect account is valid with no bank account or payout email, a Brazilian one falls through to the bank checks (a Connect row no longer counts as the Stripe account behind the bank account), and a live PayPal Connect account replaces the compliance-info requirement. Five recorded examples in `seller_dashboard_collaborators_signed_in_spec.rb` (linked Connect, unlinked Connect, linked Brazilian Connect, PayPal Connect with a payout email, payout email alone) replay in `seller-dashboard.replay` (56 tests pass), plus 13 unit tests in `payout-info-valid.test.ts`. Reverting `payout-info.ts` fails 4 of the 5 replays (the fifth is the unchanged non-Connect path) and 8 unit tests. Still handing back: a PayPal Connect seller with no payment address, whose payout email is `paypal_account_details` from PayPal's API (not recordable offline; unit-tested as the hand-back). Rails refuses a Brazilian Connect user as a collaborator, so the recording creates the collaborator first and connects the account after. No debt line was open for it.

`PUT /mobile/sales/:id/revoke_access` and `/undo_revoke_access` (`nextjs_mobile_sales`) run in Node (see "Mobile sale access toggle" in workstreams.md). Nine examples in `mobile_sales_access_parity_spec.rb`, recorded on lane 20 (`gumroad_test_20`, Redis 35-38, `PARITY_ES_INDEX_SUFFIX=-c20`) and replayed in `mobile-api` on `gumroad_replay_20` (Redis 39; 104 tests pass); with the two `routes.json` entries removed all nine fail. The replay ignores `db.purchases.updated.*.changes.updated_at` (the seed is stamped with the replay's clock) and `db.versions` as for every mobile write, so the PaperTrail row of the toggle is pinned only by the web golden. The two writing examples use `:free_purchase` because `update!` revalidates and a `validate: false` row fails it (422 in Rails); Node skips validations as the library writes do, so a sale that fails validation answers 422 in Rails and succeeds in Node. No debt line was open for it.

Wishlist products with a version or a recurrence (WS-11f, lane 17: `gumroad_test_17`, Redis 47-50, `PARITY_ES_INDEX_SUFFIX=-c17`) run in Node: `POST /wishlists/:wishlist_id/products` with `option_id` (`variants_or_skus.find_by_external_id!`: an alive version of an alive category of the product, else 404) and `recurrence` finds or builds the row by product, version and recurrence, and `WishlistProducts` now validates the recurrence (inclusion for a recurring product, absence otherwise) and `versioned_product_has_variant` (unless being marked deleted). Before, any `option_id`, `recurrence` or product with versions was the "a wishlist product with an option, recurrence, quantity or rent" hand-back. Still hands back: a product with `skus_enabled`, `quantity_enabled` or rentals, an explicit `quantity`/`rent`, and a non-string or empty-string `recurrence`. `updateWishlistRecommendable` now casts the wishlist row, so a second product no longer touches `wishlists.updated_at` (the raw tinyint made `recommendable` look changed). Eleven new examples in `wishlist_items_mutations_signed_in_spec.rb` replace "hands a product with a version" (kept as "hands a product with skus"); `ws11b.replay` 64 tests, 6 new unit tests in `wishlist-product.test.ts`. No debt line was open for it.
`expire-transcoded-videos-job.golden.json` was re-recorded on lane 18 (`gumroad_test_18`, Redis 52, `PARITY_ES_INDEX_SUFFIX=-c18`) with the real `TranscodedVideo#mark_deleted!`. `ExpireTranscodedVideosJob` now expires videos without a streamable file in Node (new `models/transcoded-video.ts`); a video with `streamable_type` and `streamable_id` set still hands back before its write because the flag update on the `ProductFile` (`update!` with its callbacks) is not ported, and no golden case reads a `ProductFile` row. No debt line was open for it.
`POST /customer_surcharge` (E5b, lane 16: `gumroad_test_16`, replay Redis 60, `PARITY_ES_INDEX_SUFFIX=-c16`) no longer hands back a US taxable state or a Canadian province (TaxJar: `tax/taxjar.ts`, request body and Redis memo as the gem and `TaxjarApi#with_caching` write them, 200/400/404/500/503 handled, the rest left to Rails) or a VAT id with a local validator (BH, KE, NG, TZ, OM). Fifteen examples in `customer_surcharge_parity_spec.rb` ("TaxJar buyers and tax ids") replay in `customer-surcharge` (47 tests pass); the replay boots a local TaxJar stand-in (`TAXJAR_ENDPOINT`) that serves the recorded answers and asserts the port sent the recorded bodies in order. Verified by reverting the controller: the TaxJar, fallback, SaaS-code and tax-id examples fail. The TaxJar answers are WebMock stubs (the sandbox is not reachable from the recorder), so the response shape is the documented one, not a live capture. Still open: vendor-checked VAT ids, a Canary Islands GeoIP buyer, commission and renewal lines.

`delete-wishlist-products-job.golden.json` was re-recorded on lane 22 (`gumroad_test_22`, Redis 23, `PARITY_ES_INDEX_SUFFIX=-c22`) with recurrence cases. `DeleteWishlistProductsJob` no longer hands back a recurrence or a recurring product (the `WishlistProducts` recurrence validation already ran in Node); a variant, a quantity above one, rent and a rentable product still hand back. New goldens on lane 22: `rebuild-gmail-abuse-filter-job`, `invalidate-product-cache-worker`, `backfill-orphaned-shown-products-in-profile-sections-job`, `refresh-high-volume-seller-fee-eligibility-job`; their hand-backs are a `shown_products` entry that is not a plain integer, and a seller id that matches a user (the user save callbacks).

`GET /library/purchase/:purchase_id/update/:id` (WS-13, `PostsController#redirect_from_purchase_id`, `nextjs_post_purchase_redirect`; lane 16: `gumroad_test_16`, Redis 63/53/44/45 with `DISABLE_TEST_REDIS_ISOLATION=1`, replay Redis 34, `PARITY_ES_INDEX_SUFFIX=-c16`) runs in Node (`posts-redirect.ts`). Nine examples in `posts_redirect_from_purchase_id_signed_in_spec.rb`, replayed in `ws12b` (78 tests pass); with the `routes.json` entry removed eight of them fail. A post with no seller (Rails raises `NoMethodError` on `Link#seller`, so it has no recording) or no slug hands back. No debt line was open for it.
