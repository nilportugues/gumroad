# Model services

ActiveRecord models ported to plain functions over Prisma rows. A model is a `defineModel()` call that
lists its callbacks and validations in the order the Ruby class declares them; the runtime runs them in
the order Rails does and writes through the Prisma transaction client.

## Layout

- `runtime/`: the lifecycle. `define-model.ts` (validations, callbacks, timestamps, save/destroy),
  `record.ts` (attributes and dirty tracking), `transaction.ts` (joined transactions, `after_commit`),
  `validators.ts`, `errors.ts`, and `testing.ts` (a fake transaction client that records writes).
- `concerns/`: behaviour shared across models.
  - `paper-trail.ts`: `has_paper_trail`. Writes the same `versions` rows as paper_trail 17.
  - `deletable.ts`: `Deletable` soft deletion.
  - `serialized-columns.ts`, `psych.ts`: `serialize` YAML/JSON columns, byte for byte with Psych and
    the json gem.
- `associations.ts`: the association reflections of every Ruby model, read from
  `prisma/relations/manifest.json`.
- `user.ts`, `link.ts`: the first model services. `user-data.generated.json` holds the constant lists user.ts
  reads (DENYLIST, time zones, currencies, disposable domains), written by `scripts/golden/user.rb`.
- The small models behind the Node job ports (`platform-block.ts`, `wishlist.ts`, ...). These need
  ActiveRecord's exact statements, so they read through `sql.ts` (raw `SELECT table.*`,
  `find_in_batches`, Arel's `IN`) and validate associations with `concerns/rails-validations.ts`.
  `concerns/job-runtime.ts` gives them `perform_async` and `AfterCommitEverywhere`, and
  `concerns/ruby-time.ts` ActiveSupport's date arithmetic. Their tests replay
  `src/worker/jobs/__fixtures__/model-jobs.golden.json`, recorded from the real models under
  ActiveRecord 8.1 with a stub mysql2 driver (`generate-model-jobs-golden.rb` next to it).
- `../../lib/flags.ts`: `has_flags` (flag_shih_tzu).

## Defining a model

```ts
const paperTrail = hasPaperTrail<Follower>("Follower", { itemType: "Follower" });

export const Followers = defineModel<Follower>({
  rubyClass: "Follower",
  prismaModel: "Follower",
  delegate: (tx) => tx.follower as never,
  validations: [validatesPresenceOf(["email"])],
  // has_paper_trail is declared first in every versioned model, so its callbacks go first.
  afterCreate: [...paperTrail.afterCreate],
  afterUpdate: [...paperTrail.afterUpdate],
  beforeDestroy: [...paperTrail.beforeDestroy],
});
```

Serialized text columns stay as their database text on the record; decode them with
`yamlColumn()`/`jsonColumn()` where the value is needed. Request context for versions comes from
`withPaperTrailRequest({ whodunnit, controllerInfo }, fn)`.

## Golden vectors

The byte-exact ports are tested against output recorded from the real gems, pinned to the versions in
`Gemfile.lock`. Regenerate a fixture after changing its script, and commit both together:

```sh
bundle exec ruby nextjs/scripts/golden/serialize.rb     # concerns/__fixtures__/serialize.golden.json
bundle exec ruby nextjs/scripts/golden/paper-trail.rb   # concerns/__fixtures__/paper-trail.golden.json (needs sqlite3)
bundle exec ruby nextjs/scripts/golden/flags.rb         # lib/__fixtures__/flags.golden.json
bundle exec ruby nextjs/scripts/golden/user.rb          # __fixtures__/user.golden.json, user-data.generated.json
```

`src/worker/jobs/__fixtures__/generate-model-jobs-golden.rb` pins its own gems (see its header) and
needs a scratch Redis database for the unique-jobs locks. So do `generate-comment-golden.rb` and
`generate-reputation-golden.rb` (Flipper, $redis and a MemCacheStore over a fake Dalli server), and
`scripts/golden/rails-cache.rb` (`src/server/cache/__fixtures__/rails-cache.golden.json`).

`scripts/golden/user-writes.rb`, `risk-jobs.rb` and `lift-platform-stripe-pause.rb` boot the whole app
with `rails runner` against a scratch database and Redis db (see `user-writes.rb`'s header): they
truncate and seed the tables a case uses, run the real model or job, and record every statement and
its answer with `support/rails_recorder.rb`. Job cases record as production Sidekiq runs them (see
below); `user-writes.rb` saves outside any executor, so with the query cache off.

## Query cache

`runtime/query-cache.ts` is ActiveRecord 8.1's query cache. `withExecutor(fn, options)` is
`Rails.application.executor.wrap`: the worker's processor wraps every job in it with
`SIDEKIQ_EXECUTOR`, and a request handler would use `WEB_EXECUTOR`. Inside it, raw SELECTs through
`sql.ts` or a client from `queryCacheClient` are keyed on their rendered SQL (LRU of 100 per pool),
answered with fresh copies, and dropped by any write or rollback; locking reads, `find_in_batches`
loads and `uncached` blocks bypass it, and `reload` clears it. `SIDEKIQ_EXECUTOR` also emulates
production Sidekiq's `mysql2_proxy` pools (USE_DB_WORKER_REPLICAS=true): a separate replica store
for `connectedTo("reading")`, and the cache cleared whenever `lib/mysql2_proxy_routing.rb` would
switch the pool serving a SELECT. `runtime/__fixtures__/query-cache.golden.json` pins both
executors against the real adapter (`scripts/golden/query-cache.rb`).

Job goldens run each case through `scripts/golden/support/sidekiq_executor.rb` (a thread of its
own, the Rails reloader, the proxy pools), and their tests replay inside `asSidekiqJob`. Goldens of
model calls recorded outside any executor (`user-writes`, the comment model cases, the `search`
golden's document builders) keep the cache off, and so do their tests.

Known differences from Rails:

- Rails keeps the proxy's last-write clock and serving pool per Sidekiq thread, across jobs; Node
  starts each job fresh.
- Reads Node runs concurrently within one job are not deduplicated; Rails runs them in sequence.
- Typed Prisma reads (`findUnique` and friends) are not cached.
- Any trailing lock clause marks a read as locking, where Rails looks at the relation's `lock`, so a
  hand-written `find_by_sql("... FOR UPDATE")` would be cached there and not here. No such call is
  ported.

## Known gaps

- Record attributes are not type-cast on assignment. Code that sets a datetime must truncate it to the
  column precision itself, as `Deletable` does; MySQL would otherwise round it.
- Prisma returns JSON column numbers as JS numbers, so a stored `1.0` reads back as the Integer `1`.
  Versions of JSON columns can differ from Rails for such values.
- No `touch`, so `has_paper_trail`'s `on_touch` callback is not ported.
- `json_data` accessors (`attr_json_data_accessor`) and `stripped_fields` are not ported yet.
- PaperTrail's `object` on an update lists the attributes ActiveModel's LazyAttributeSet had
  materialized (written or dirty-checked) first, then the rest in column order. `Record` tracks that
  order for every model; reads a callback makes only to decide something Rails decides without
  touching the attribute belong in `record.untracked(...)`.

### `Comment` (`comment.ts`)

Ported from comment.rb, ancestry 4.3.3 (`has_ancestry cache_depth: true`), JsonData, Deletable and
`has_paper_trail`, in Rails' callback order; golden: `src/worker/jobs/__fixtures__/comment.golden.json`
(`generate-comment-golden.rb` runs the real model on the fake mysql2 driver). Refused with
`NotPortedError`, before any write: `destroy` (ancestry's `:destroy` orphan strategy), changing
`ancestry` on a stored comment (`update_descendants_with_new_ancestry`), writing `json_data` on a
stored comment (`merge_json_data_with_current_row`), and creating a root `user_submitted` comment
(its after_commit sends `CommentMailer.notify_seller_of_new_comment`). Not ported:
`mark_subtree_deleted!`/`mark_subtree_undeleted!`, the `was_alive_before_marking_subtree_deleted`
accessor, ExternalId, and ancestry's navigation scopes.

### `Link` (`link.ts`)

Ported for `link.update(banned_at:)`, the one product save the risk flows make (golden:
`__fixtures__/link-writes.golden.json`): every validation and callback of link.rb and its concerns
that runs on that update, in Rails' order, including the after-commit search update. The guard
refuses with `NotPortedError` before any SQL: creating or destroying a product, changing anything
but `banned_at`, a product without `unique_permalink`, a non-USD price whose rate is not cached
(`CurrencyHelper#query_rate` falls back to HTTP), and an installment plan on a bundle
(`validate_bundle_content_eligibility`). Money messages come from `link-data.generated.json`,
which `scripts/golden/link-writes.rb` writes from the app's own formatter.

### `CustomDomain` (`custom-domain.ts`)

Ported for `mark_deleted!` on an alive domain (golden: the suspension cases of
`__fixtures__/user-writes.golden.json`), with `stripped_fields`, every validation and the
`GenerateSslCertificate` job the stripped domain can trigger. `PublicSuffix.valid?`/`.parse` are in
`concerns/public-suffix.ts`, on the rule list of the bundled gem (`public-suffix-list.generated.json`,
golden `concerns/__fixtures__/public-suffix.golden.json`). Every other save refuses before SQL.

`ScheduledPayout` (`scheduled-payout.ts`) is ported for `create!` only.

### `Purchase`, `Subscription`, `UrlRedirect` (`purchase.ts`, `subscription.ts`, `url-redirect.ts`)

Read side only, for the jobs in `src/worker/jobs/purchase-reads-jobs.ts`; nothing writes these tables from Node.
Ported: the `has_flags` maps of all three (Purchase's lives in `search/flags.ts`), `Purchase.find`, the
`successful`/`in_progress`/`created_between` scopes, `rentals_to_expire`, the left join on `events` that
CreateMissingPurchaseEventsWorker reads, `chargedback_not_reversed_or_refunded?`, `Subscription#not_is_test_subscription`,
the deactivation relations and `purchase.url_redirect`. Typed `where(created_at: range)` on a `datetime(0)` column floors
the range to the second (`truncateToSeconds`); a raw `where("... < ?", time)` keeps the fraction. Golden:
`src/worker/jobs/__fixtures__/purchase-reads-jobs.golden.json`, from `scripts/golden/purchase-reads-jobs.rb`
(the purchase factory charges Stripe, so purchases are plain INSERTs of the columns a read looks at).
Still Ruby-only: everything else in purchase.rb (4.6k lines of callbacks, money readers, charge processor flows) and
`UrlRedirect` beyond the has_one read.

#### Subscription period logic (WS-46)

`SubscriptionRecord` (`subscription.ts`) is one loaded subscription: `alive?`, `in_free_trial?`, `charges_completed?`,
`recurrence`/`period` (the price, or the installment plan and its snapshot), `end_time_of_subscription`,
`end_time_of_last_paid_period`, `overdue_for_charge?`, `seconds_overdue_for_charge`, `indian_card_mandate_held?`,
`send_renewal_reminders?`, `india_card_mandate_reliability_enabled?` (renewal merchant account, Flipper, the order's
purchase count) and `current_subscription_price_cents` (see "Renewal pricing" below). `belongs_to`/`has_one` associations load once per record, as in
ActiveRecord; relation reads (`purchases.last`, `successful_purchases`) query every time and lean on the query cache. Methods
call each other as the Ruby does, repeats included, so cache hits and the statements after a cache clear match.
`Time + n.months` is `advance` (day clamped to the target month's end: 31 January + 1 month is 28 February, 29 February
2024 + 12 months is 28 February 2025). Golden: `worker/jobs/__fixtures__/subscription-reminder-jobs.golden.json`.

Refused with `NotPortedError` (so the job is handed back to Rails before its first write):

- An offer code whose `ownership_duration_tiers` is not an Array of Hashes, or whose tiers start in the same month (the
  validations rule both out; `sort_by` is not stable).
- A Charge without a successful purchase (`Charge#purchaser` is a delegation to `purchase_as_chargeable`).
- Mailer arguments whose Ruby `#inspect` is not ported (`SentEmailInfo.mailer_key_digest` takes Integers, nil, booleans and
  plain ASCII Strings).

#### Renewal pricing (WS-48)

`subscription-pricing.ts` is `Subscription#current_subscription_price_cents`: an installment plan charges
`original_purchase.minimum_paid_price_cents`; a membership charges the original purchase's price, less the discount it keeps
(`reuse_original_discount_on_next_charge?`, `discount_applies_to_next_charge?` and the pay-what-you-want undo of a tiered code
in `cached_tiered_pwyw_renewal_pre_discount_total_cents`) or the best renewal-eligible code (`compute_auto_renewal_offer_code`:
the product's, the seller's universal ones and the original tiered code, each checked by `eligible_auto_renewal_offer_code?`
and `evaluate_for_buyer`). `offer-code.ts` is the read side of `OfferCode`: `amount_off`, `original_price`, tiers, usage limits
(`times_used`, `active_once_per_cart_reservations`), `discount`, `ownership_months_for`. `purchase-pricing.ts` is the part of
`Purchase` it needs: `minimum_paid_price_cents` for a purchase that is not a recurring or pre-order charge,
`displayed_price_cents_before_offer_code`, `minimum_paid_price_cents_per_unit_before_discount`, `offer_code_for_pricing`
and `offer_code_applies_to_selected_variant?`.

Integer cents, with the Float steps Ruby has (`price * (percentage / 100.0)`, the commission deposit) rounded half away from
zero by `rubyRound` (`concerns/ruby-numeric.ts`, `Math.round` rounds a negative half up). `PurchaseRecord` and
`OfferCodeRecord` load each association once, like the ActiveRecord objects; the original purchase's `subscription` is the
subscription it was loaded through (`has_one` sets the inverse), so its `last_payment_option` and `price` are shared. Methods
send the statements the Ruby does even when the answer is not read (`OfferCode#discount` loads the products only to list their
ids; a fixed code reads the unit price it never uses), because the query cache and the statement list both depend on them.

Golden: the `price:` cases of `worker/jobs/__fixtures__/subscription-reminder-jobs.golden.json` run
`current_subscription_price_cents` alone (the cents and every statement), and the `missing charge:` cases run the sweep around
it. The arithmetic is also checked on 12,300 seeded inputs against the real Ruby methods
(`__fixtures__/offer-code-pricing-vectors.golden.json`, `scripts/golden/offer-code-pricing-vectors.rb`; test:
`models/offer-code-pricing.test.ts`).

Time is a JavaScript Date, so microseconds in `datetime(6)` columns (`free_trial_ends_at`, `cancelled_at`) are rounded to
milliseconds; a comparison with `Time.current` within a millisecond of equal could differ.

`SentEmailInfo` is complete: `key_exists?`, `set_key!`, `mailer_key_digest`, `mailer_exists?`, `ensure_mailer_uniqueness`.
`charge.ts` is `Charge::Chargeable.find_by_purchase_or_charge!` and `AutoInvoiceEligibility`; `row-reads.ts` the shared
`belongs_to`/`find_by(id:)` statements.

#### Countries, purchasing power parity and Stripe Connect routing (WS-52)

`compliance-countries.ts` is the lookup half of `Compliance::Countries` over `countries.generated.json`, which
`scripts/golden/countries.rb` writes from the real `countries` gem with `config/initializers/countries.rb` applied (names,
alpha2/alpha3, currency, the Unaccent table, `COUNTRIES_SUPPORTED_BY_STRIPE_CONNECT`, the blocked lists). `findByName`
reproduces `ISO3166::Country.find_country_by_any_name`: the query and every searched name go through `parse_value` (drop
`(`, `)`, `[]` and `,`, unaccent, lower case each character on its own: Ruby does not use the final sigma), and the country
that comes last in the gem's order wins a name two countries share. `countries.test.ts` replays 9,255 probes, the parsed name
index and the normalization vectors Ruby recorded (`__fixtures__/countries.golden.json`) and fails when the gem version in
`Gemfile.lock`, the initializer, `lib/utilities/compliance/countries.rb` or the Stripe Connect list change: re-run the script.
Not ported: subdivisions, `for_select*`, the tax lists, Japan's prefectures.

`purchasing-power-parity.ts` is `PurchasingPowerParityService` (`get_factor`, `get_all_countries_factors`, `set_factor`) over
the `ppp` Redis namespace, and `User#min_ppp_factor`. Every Redis error falls back to the unadjusted factor, as Ruby's
`REDIS_TRANSPORT_ERRORS` rescue does; the stored value goes through `String#to_f`. Golden: `__fixtures__/purchasing-power-parity.golden.json`
(279 cases with the Redis commands the service sent). `PurchaseRecord` multiplies a PPP-discounted price by the factor of
`alpha2(ip_country)` (memoized per record, the seller loaded where `purchasing_power_parity_factor` loads it); 4,000 seeded
vectors from the real `Purchase#minimum_paid_price_cents` are in `offer-code-pricing-vectors.golden.json`
(`minimum_paid_price_ppp`), and the `purchasing power parity:` cases of the subscription reminder golden check the statements
and the `ppp` Redis commands.

`stripe-connect-routing.ts` derives a compliance record's `country_code`, `business_country_code` and
`legal_entity_country_code` from the stored country names, and `merchant_migration_enabled?` uses them
(`User#stripe_connect_routing_country_code`, switched by the `stripe_connect_routing_by_legal_entity_country` feature). The
`Connect routing:` cases of the subscription reminder golden run the real code over `user_compliance_info` rows.

`UpdatePurchasingPowerParityFactorsWorker` (`worker/jobs/update-purchasing-power-parity-factors-worker.ts`) downloads the World
Bank zip with `lib/ruby-open-uri.ts` (open-uri's redirect, loop and status rules), reads it with `lib/ruby-zip.ts` and
`lib/ruby-csv.ts`, and rounds with `rubyFloatRoundDigits` (`Float#round(2)`: 45,000 vectors). It hands the job back before the
first write for what those readers do not reproduce: a damaged, ZIP64 or encrypted zip, a CSV the csv gem calls malformed or
with a bare carriage return or mixed line breaks, and a year header `Integer()` reads in a form other than plain decimal.

#### Subscription writes (WS-47)

`subscription-writes.ts` is `Subscription` as a runtime model (`Subscriptions`) for updates of a stored row, plus
`with_lock`, `deactivate!`, `end_subscription!` and `unsubscribe_and_fail!`; `subscription-event.ts` is `SubscriptionEvent`
(`create_interruption_event`). Callbacks run in Rails' order: validations (required seller, `must_have_payment_option`,
installment plans), `end_indian_card_mandate_hold`, PaperTrail, `create_interruption_event`, the inventory counter
`UPDATE`s, and after commit (reverse order) the audience-member refresh, `PostToPingEndpointsWorker` and the
`ElasticsearchIndexerWorker` pushes of `update_purchase_index` (with TransactionalAttributeChangeTracker's
`attributes_committed`). `subscriptionView(record)` is the WS-46 `SubscriptionRecord` over the same record and association
cache, so `with_lock`'s reload drops what was loaded. `Subscriptions.save` of a new row and `destroy` refuse with
`NotPortedError`. `SubscriptionCancellationEmailJob` is pushed through `deliverLater` (`jobClass`/`extraKeywords`).
Goldens: `worker/jobs/__fixtures__/subscription-writes-jobs.golden.json` (`scripts/golden/subscription-writes-jobs.rb`).

Handed back to Rails before the first write: a failed charge on the card of a mandate-reliable merchant account
(`indian_card_mandate_error_status`, `refresh_indian_card_mandate!` call Stripe); a member cancellation workflow whose
filters Node cannot judge (see WS-51); a subscription cancelled while the job waited for its lock. For a cancelled
subscription Node reads the seller's workflows before `BEGIN`, where Rails reads them after the commit
(`readWorkflowsForCancellation`), so the hand-back decision is made before anything is written; the workflows are then
evaluated and scheduled after the commit, as Rails does. `Time.current` is a JavaScript Date, so `deactivated_at` and friends lose microseconds.
Purchase.inventory_pending_create_commit_ids is always empty in Node (no purchase is created there).

### Money: `CurrencyHelper`, `Credit`, `BalanceTransaction`, `Balance`, `BacktaxCollection`

`concerns/currency-helper.ts` is `get_rate`/`query_rate` (the `currencies` Redis namespace, refilled from
OpenExchangeRates, with the last-known-rate fallback when Redis is down), `get_usd_cents`,
`usd_cents_to_currency` and `formatted_dollar_amount`. Money is a 60-digit `Decimal` over the rate's
shortest Float form, which matches BigDecimal on 800+ recorded vectors. Golden:
`concerns/__fixtures__/currency.golden.json` (`scripts/golden/currency.rb`, `CURRENCY_SOURCE` on the capture
server). `models/link.ts` still has its own `getUsdCents` that refuses on a missing rate; move it over.

`credit.ts` (record, validations, the `add_comment` after_create), `credit-creation.ts`
(`create_for_balance_change_on_stripe_account!` and `create_for_bank_debit_on_stripe_account!`),
`balance-transaction.ts` (`create!`, `update_balance!` with its balance lock and retry,
`find_or_create_balance`), `balance.ts` (validations, the non-USD Gumroad-held report, the after-commit
`UpdateSellerRefundEligibilityJob` enqueue) and `backtax-collection.ts` are ported for credits. Golden:
`worker/jobs/__fixtures__/money-jobs.golden.json` (`scripts/golden/money-jobs.rb`). Association reads that
Rails caches on the instance go through `concerns/belongs-to-record.ts`, which keeps one record per cached
row; which of them load, and when, is part of the SQL the golden pins (the `has_many` reader's inverse
`user` on a backtax agreement, the `reload` in `update_balance!` that drops them).

Refused with `NotPortedError`: balance transactions for a purchase, refund or dispute, a returned-payment,
financing-paydown or fee-retention credit, `capital_deduction_date`, a non-Stripe merchant account's
`holder_of_funds`, writing `json_data` on a stored credit, and `create_for_credit!` and the other
`create_for_*` methods. `update_balance!` does not retry on `ActiveRecord::LockWaitTimeout`. `MerchantAccount`
is a read-only record (`merchant-account.ts`).

### `User` (`user.ts`)

Ported, in Rails' callback order: every validation and `before_validation` of user.rb and its
concerns (golden: `scripts/golden/user.rb` runs user.rb's own declarations), Devise's confirmable,
recoverable and pwned_password callbacks, `has_one_time_password`, JsonData (`json_data` NULL → `{}`
on read, `merge_json_data_with_current_row`), `save_external_id`, the `before_create` flags,
`clear_products_cache`, the Stripe Apple Pay and business-profile jobs, `fence_newsletter_cutover`,
and the `after_commit` jobs (`GenerateUsernameJob`, `UpdatePurchaseEmailToMatchAccountWorker`,
`ReindexSubscriptionCurrentEmailWorker`, `GenerateSubscribePreviewJob`).

Devise's confirmation, reconfirmation and email-changed mails go out through
`src/server/mail/devise-notification.ts`, which pushes the same `deliver_later` job Ruby does.

Reached through `userCollaborators`, whose defaults throw `NotPortedError` (checked before any
write when they would run after commit):

- `after_create :create_global_affiliate!`, `:create_refund_policy!` (user.rb:409-410): GlobalAffiliate
  and SellerRefundPolicy models. Until they land, no User can be created in Node.
- `update_audience_members_affiliates` (user.rb:1994): AudienceMember.
- `update_alive_cart_email` (user.rb:1888): Cart.
- `make_affiliate_of_the_matching_approved_affiliate_requests` (user.rb:1918): AffiliateRequest.

Still Ruby-only on `User`:

- `user_risk_state` (`user-risk.ts`, golden `__fixtures__/user-writes.golden.json`) is fully
  ported, suspensions included: `invalidate_active_sessions!` (Doorkeeper revocation for the
  first-party mobile apps, `oauth-application.ts`), `disable_links_and_tell_chat` and
  `enable_links_and_tell_chat` through `Link#update`, `delete_custom_domain!` through
  `CustomDomain#mark_deleted!`, and `currently_linked?` for `record_hold_released!`.
- `tier_state` (user.rb:565-590).
- Avatar: `has_one_attached :avatar` with `set_avatar_changed` (user.rb:212-215). Node attaches no
  files; `validate :avatar_is_valid` only runs its attachment read.
- `json_data` values compare by their JSON text in the merge, where Ruby compares values (1 vs 1.0).
- Instance methods beyond the ones jobs need: the payout, balance, stats, tax, compliance,
  team, social login, avatar URL and communities methods (user.rb:247-1760 and app/modules/user).
  `deactivate!` and `current_payout_processor` in particular.
- `Mail::Address#domain` is reproduced for addresses EMAIL_REGEX accepts and `Name <addr>`; other
  shapes follow the golden vectors only.

- `WarmSellerReputationSummaryJob` builds its Rails.cache key from `products.cache_key_with_version`,
  whose version ends in `MAX(links.updated_at)` to the microsecond. If the driver hands that back as a
  Date, sub-millisecond digits read as zero and Node fills a different cache slot than Rails (same
  aggregate, one extra query per 10 minutes). The $redis snapshot it writes is unaffected.
- JS Dates hold milliseconds, so microseconds read from a `datetime(6)` column are lost. Writes that
  need them (`Date#end_of_day`) use `MicroDate`, which assumes Prisma sends a Date as its
  `toISOString()`; check that against MySQL before relying on it outside the golden tests.
- `runtime/validators.ts`: `validatesUniquenessOf` puts the scope before `id != ?` and lacks the
  unique-index skip of ActiveRecord 8.1, and `validatesAssociatedPresence` is not what a required
  `belongs_to` does under `belongs_to_required_validates_foreign_key = true` (which loads the parent
  on every save). `concerns/rails-validations.ts` has versions that match Rails; move callers over.
- No savepoints, so `create_or_find_by!` inside an outer transaction is not ported.

`community.ts` is `User#accessible_communities_ids` (the polymorphic `resource` preload is ported for products only; any other
resource type throws `NotPortedError`). `two-factor-authentication.ts` is `User#send_authentication_token!`, the enqueue side of
TwoFactorAuthenticationMailer; nothing in Node calls it yet. Goldens: `scripts/golden/community-chat-recap-notifications.rb` and
`scripts/golden/send-authentication-token.rb`.

Still Ruby-only on the job-port models (app/models/...):

- `ping_delivery.rb:19` `as_props` (needs `Purchase#external_id_numeric`).
- `workflow_installment_schedule_intent.rb:19` `enqueue!`, `:79` `mark_processed`, `:94`
  `mark_processed!`, `:104` `claim_fanout!`, `:113` `begin_fanout`, `:135` `renew_fanout`, `:148`
  `defer_fanout`.
- `event.rb:4` `TimestampScopes`, `:40` `user_external_id`.
- `product_cached_value.rb:18` `assign_cached_values` (reads `Link` metrics), so the before_create
  aborts and rows cannot be created from Node.
- `zip_tax_rate.rb:14-15` the `json_data` accessors.
- `community_chat_recap_run.rb:13` `between`, `:22` `check_if_finished!`.
- `large_seller.rb:17` `create_if_warranted` (takes a `User`).
- `stamped_pdf.rb:12` `user`, plus `S3Retrievable` and `CdnDeletable#mark_deleted_from_cdn`.
- `wishlist.rb:27-57` `find_by_url_slug`, `seo_indexable(?)`, `url_slug`, `followed_by?`,
  `wishlist_products_for_email`, `ExternalId` and `Wishlist::StructuredData`. `WishlistFollower` and
  `CommunityChatMessage` have no model service; the jobs query them directly.

Still Ruby-only on `User`: `stripped_fields`, the username/email uniqueness and format validators,
`timezone`/`currency_type`/`recommendation_type` inclusion, every `validate :method`, password
validations, `save_external_id`, `set_refund_policy_enabled` (needs Flipper), avatar tracking, the
`after_*` callbacks that touch other models or enqueue jobs, and the state machine.

Still Ruby-only on `Link`: permalink generation and locking, `user` presence, `default_price_cents`,
`support_email` and `json_data`-backed validations, every `validate :method`, `validates_associated
:installment_plan`, `set_default_discover_fee_per_thousand` (reads the seller), and the `after_*` and
`after_commit` callbacks that touch prices, offer codes, caches, licenses and search.

- `BalanceTransaction#update_balance!` retries a lock wait timeout like Rails (3 attempts, 0.5 s × attempt
  backoff), but that path has no golden: the money goldens never hit a lock timeout.

### `Refund`, `FailedRefundException`, `Dispute`, `DisputeEvidence` (WS-49)

Read side first, for the jobs in `src/worker/jobs/refund-dispute-jobs.ts`. Golden:
`worker/jobs/__fixtures__/refund-dispute-jobs.golden.json` (`scripts/golden/refund-dispute-jobs.rb`: every job as a Sidekiq job,
with the statements, Redis, ErrorNotifier reports and errors recorded) and
`models/__fixtures__/dispute-evidence-window.golden.json` (`scripts/golden/dispute-evidence-window.rb`).

- `refund.ts`: `Refunds` is a record that refuses every save (`NotPortedError`), so a port that would write a refund hands the
  job back. Ported: the `purchase` and `failed_refund_exception.refund` belongs_to loads (cached per record), the `JsonData`
  readers (`jsonDataForAttr` follows `json_data_for_attr`, blank is nil; `rubyToI` is `Object#to_i`), `retained_fee_cents`,
  `scope :pending_fee_retention`, `Credit.where(fee_retention_refund:).failed_refund_fee_reversals.exists?` and `external_id`.
  Still Ruby-only: `retain_fee`, `record_fee_retention_failure!`, `collect_pending_fee_retention!`, `write_off_fee_retention!`,
  `count_fee_retention_attempt!`, `sync_fee_retention_recoverable` and the `effective`/`reversed_failures` scopes.
- `failed-refund-exception.ts`: the model (validations in Rails' order, the three scopes, `escalate!`,
  `update!(notification_sent_at:)`, `increment!(:notification_failures)`). The `GlobalConfig`-backed `default_owner`,
  `response_sla` and `default_notification_room` belong to the code that creates exceptions (Ruby).
- `dispute-evidence.ts`: the seller's evidence window (`window_duration` with the weekend extension, `seller_response_due_at`,
  `window_open?`, `hours_left_in_window`, `seller_response_reminder_at`) and the `seller_contacted`/`not_resolved` scopes.
  `latest_window_start`, `claim_seller_contacted_window!` and every write stay in Ruby. `dispute.ts`: the state lists, the
  `includes(:dispute)` preload and `CreateMissingDisputeEvidenceJob`'s relation. The dispute state machine, formalization side
  effects and dispute credits are Ruby.
- Not ported, and not needed by the jobs above: the refund and dispute `BalanceTransaction`/`Credit` paths (`create_for_refund!`,
  `create_for_dispute_won!`, ...). The code that writes them (`RefundPurchaseWorker`, the dispute events of
  `HandleStripeEventWorker`, `Purchase::HandleFailedRefundService`) calls the charge processor first, so it stays Ruby until the
  checkout and refund workstreams; extend the credit golden then.
- `datetime(6)` columns (`due_at`, `notification_sent_at`, `seller_contacted_at`, `event_created_at`) are JavaScript Dates:
  microseconds are lost on read, and a stamp Node writes has millisecond precision where Ruby's `Time.current` has microseconds.

### Workflows, installments and their schedulers (WS-51)

Read side of `Workflow`, `Installment`/`InstallmentRule` and `WithFiltering`, for the jobs in `src/worker/jobs/workflow-jobs.ts`
and the member cancellation scheduling of `SetSubscriptionAsDeactivatedWorker`. Golden: `worker/jobs/__fixtures__/workflow-jobs.golden.json`
(`scripts/golden/workflow-jobs.rb`, 118 cases: every job as a Sidekiq job with its statements, scheduled `at` and Redis; run it with the
`OBFUSCATE_IDS_*` keys its header names, because the variant external ids in the seeds depend on them).

- `workflow.ts`: `WorkflowRecord` (the row, `json_data` parsed on first use, `seller`/`base_variant` loaded once per record), the type and
  trigger predicates, `applies_to_purchase?`, `link.workflows.alive`, `seller.workflows.alive.<type scope>`, `workflow.installments.alive[.published]`
  and `installment.installment_rule`. `workflow-scheduling.ts` lists the installments a scheduler pushes for (rule read per installment, rule-less
  ones skipped).
- `with-filtering.ts`: `purchase_passes_filters` / `seller_post_passes_filters`, including the `not_bought_products` and `not_bought_variants`
  probes (`seller.sales...exists?` with the UNION subquery of `Purchase.by_external_variant_ids_or_products`, written as ActiveRecord renders it:
  flag values quoted, `IN ('1', '2')` for variant ids, `1=0` for no products). `PurchaseRecord` (purchase-pricing.ts) gained `seller()`,
  `license()` and `subscriptionRow()`.
- Filters are JSON values, and Ruby compares them with whatever the column holds. Node judges the types the filters are written with (numbers for the
  price and license filters, string lists for products and variants, ISO 8601 strings for `created_after`/`created_before`, which ActiveSupport coerces
  with `to_datetime`) and throws `NotPortedError` for anything else: a string where a number is compared, a date in another format, a variant external
  id that does not decode, the `seller_post_filter_cache`/`seller_post_probe_batch` arguments of the batch callers. `assertWorkflowSupported` runs the
  same checks without reading, so a job that evaluates workflows after its first write can decide first.
- A column that is not a Hash raises `ArgumentError: json_data must be a hash` at the first filter read, as in Rails; invalid JSON is handed back.
- `installment-rule.ts`: `cached_version`, `cached_version_state` and `displayable_time_duration` (a month is 2629746 seconds). The writes, the
  pending-version Lua scripts and the callbacks stay in Ruby. `product-affiliate.ts`: the workflow schedule token lease of `ProductAffiliate`
  (`enqueue_workflow_schedule`, `claim_workflow_schedule`, `workflow_schedule_dispatchable?`, Ruby's `Integer()` for the claim time).
- `perform_at` scores a scheduled job with `Time#to_f`, which divides the time in nanoseconds by 1e9 and so reads `...245.123` back as
  `...245.1230001`. `rubyTimeToF` does the same and `enqueue()` uses it for `at`.
- Not ported: the sends (`Installment#send_installment_from_workflow_for_*`, `PostEmailApi`), `Installment` as a runtime model (publish, schedule,
  `WorkflowInstallmentScheduleIntent.enqueue!` and the `Workflow#publish!`/`schedule_installment` writes), `Workflow#mark_deleted!`,
  `InstallmentRule`'s version callbacks.

### Audience filters, installment writes and the jobs they unblock (WS-63)

Supersedes the "Not ported" and hand-back lines of the WS-51 section above for everything listed here.

- `audience-member.ts`: `AudienceMember.normalize_filter_params` and `AudienceMember.filter`, every SQL branch, as the text ActiveRecord's `to_sql`
  writes (`filterAudience` returns the fragments, `audienceSql` / `firstSql` / `countSql` are the statements `to_sql`, `first`, `count` and
  `limit(n).count` send). Bound values are quoted as strings (`> '500'`, `IN ('4', '5')`), hash conditions as typed values. Golden:
  `__fixtures__/audience-member-filter.golden.json` (`scripts/golden/audience-member-filter.rb`, 548 param/option combinations).
- `installment-audience.ts`: `Installment#audience_members_filter_params`. Stored dates are turned into the seller's time zone with
  `concerns/rails-time-zone.ts` (`time-zones.generated.json` maps ActiveSupport's zone names to tz identifiers; checked against ActiveSupport for all
  152 zones on 11 dates, DST gaps included; an ambiguous local midnight takes the earlier instant). Node reads the ISO 8601 forms the filters are stored
  in; anything `Date.parse` would accept beyond them, a variant id that does not decode, a price filter stored as a string, and the has-not-clicked
  reference (it asks DynamoDB) throw `NotPortedError`. Ruby quirk kept: a product permalink that resolves to no product leaves the filter empty, which
  matches everyone (only `waitlisted_products` guards against it).
- `installment-reschedule.ts`: the reschedule half of `SendWorkflowInstallmentWorker` (`current_recipient_reference_time`,
  `recipient_matches_current_audience?` for purchases, followers, affiliates and cancelled memberships, `reschedule_with_current_rule`), and
  `workflowDeliveryReferenceTime` in `installment-send.ts`. Golden: `worker/jobs/__fixtures__/installment-sends.golden.json`
  (`scripts/golden/installment-sends.rb`, 83 cases: production-mode mail, provider recorders, audience member rows).
- `installment-rule.ts` gained `CACHE_COMMITTED_VERSION_SCRIPT` and `cacheVersionBang` (`InstallmentRule#cache_version!`), which
  `SendWorkflowInstallmentWorker#current_rule_version` runs for a rule the cache does not hold. The pending-version scripts and the rule's save
  callbacks are still Ruby's.
- `installment-emailable.ts`: `Installment.emailable_posts_for_purchase` (the three-way UNION), for `SendLastPostJob`.
- `direct-affiliate.ts`: `DirectAffiliate#schedule_workflow_jobs`, with the `includes(:affiliate)` / `includes(:product)` preloads of the job that calls it.
  Golden: `schedule-affiliate-workflows.golden.json` (40 cases).
- `workflow-resubscribed-memberships.ts`: `reschedule_pending_resubscribed_memberships`, with the preloads of `find_in_batches ... preload(...)` filling
  the `PurchaseRecord` memo. A workflow that excludes buyers of other products (`ResubscriptionExclusionProbe`), a filter Node does not judge, and a
  batch of 1000 restarted memberships are decided before the intent's fanout is claimed, so the job hands back untouched. Golden: the "delay edit" cases of
  `schedule-workflow-installment.golden.json` (73 cases).
- `installment-writes.ts`: `Installment#publish!`, `#unpublish!` and `#mark_deleted!` as a `defineModel` with the validations and callbacks a save runs
  (paper_trail `versions` row, `ElasticsearchIndexerWorker` four seconds after commit). Golden: `publish-scheduled-post.golden.json`
  (`scripts/golden/publish-scheduled-post.rb`, 27 cases). Left to Rails, with `NotPortedError` before the first write: a post that emails its audience
  (`validate_sending_limit_for_sellers` counts it in Elasticsearch, and the publish is followed by a `PostEmailBlast`), a post with files
  (`transcode_videos!`), a call to action, a message the sanitizer would have to judge, a post without a slug (friendly_id), and a seller content
  moderation would review (the `content_moderation` kill switch on and the seller not a VIP; the review asks an AI model).
- Not ported: `Workflow#publish!`, `#unpublish!` and `#mark_deleted!`, `InstallmentRule#advance_version!` and the rule's save callbacks (pending
  version scripts), `UrlRedirect` creation for posts with files, `Installment` creation.
