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

- `user_risk_state` (`user-risk.ts`, golden `__fixtures__/user-writes.golden.json`) is ported except
  for the suspending events: `suspend_for_fraud!`/`suspend_for_tos_violation!` throw
  `NotPortedError` before any SQL (`invalidate_active_sessions!` revokes Doorkeeper tokens,
  `disable_links_and_tell_chat` saves products, `delete_custom_domain!`). A transition also refuses
  inside its transaction, which rolls it back, when clearing a suspension would unban products
  (`enable_links_and_tell_chat` with products) and when the seller has current
  `social_connect_verifications` (`currently_linked?` reads the identity tables).
- `tier_state` (user.rb:565-590).
- Avatar: `has_one_attached :avatar` with `set_avatar_changed` (user.rb:212-215). Node attaches no
  files; `validate :avatar_is_valid` only runs its attachment read.
- `json_data` values compare by their JSON text in the merge, where Ruby compares values (1 vs 1.0).
- Instance methods beyond the ones jobs need: the payout, balance, stats, tax, compliance,
  team, social login, avatar URL and communities methods (user.rb:247-1760 and app/modules/user).
  `deactivate!` and `invalidate_active_sessions!` in particular.
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

Still Ruby-only on the job-port models (app/models/...):

- `sent_email_info.rb:20` `mailer_key_digest`, and `mailer_exists?`/`ensure_mailer_uniqueness` on it
  (they hash Ruby's `Array#to_s` of arbitrary mailer arguments).
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
