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
needs a scratch Redis database for the unique-jobs locks.

## Known gaps

- Record attributes are not type-cast on assignment. Code that sets a datetime must truncate it to the
  column precision itself, as `Deletable` does; MySQL would otherwise round it.
- Prisma returns JSON column numbers as JS numbers, so a stored `1.0` reads back as the Integer `1`.
  Versions of JSON columns can differ from Rails for such values.
- No `touch`, so `has_paper_trail`'s `on_touch` callback is not ported.
- `json_data` accessors (`attr_json_data_accessor`) and `stripped_fields` are not ported yet.
- PaperTrail's `object` on an update lists the attributes ActiveModel's LazyAttributeSet had
  materialized (written or dirty-checked) first, then the rest in column order. Only models that
  record that order in `ivars[MATERIALIZED_ATTRIBUTES]` (so far `comment.ts`) match Rails; the others
  write column order, which differs from Rails for updates of loaded records.

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

Reached through `userCollaborators`, whose defaults throw `NotPortedError` (checked before any
write when they would run after commit):

- `after_create :create_global_affiliate!`, `:create_refund_policy!` (user.rb:409-410): GlobalAffiliate
  and SellerRefundPolicy models. Until they land, no User can be created in Node.
- Devise mail (confirmation, reconfirmation, email changed): UserSignupMailer. Any email change on a
  persisted user is postponed into `unconfirmed_email` and mails, so it is refused too.
- `update_product_search_index!` (user.rb:1904): `Link#enqueue_index_update_for` / ProductIndexingService.
- `update_audience_members_affiliates` (user.rb:1994): AudienceMember.
- `update_alive_cart_email` (user.rb:1888): Cart.
- `make_affiliate_of_the_matching_approved_affiliate_requests` (user.rb:1918): AffiliateRequest.

Still Ruby-only on `User`:

- Both state machines: `user_risk_state` (user.rb:497-563, transitions and their 20 callbacks into
  Risk, comments, IP blocks, Gmail abuse filter, sessions, custom domains) and `tier_state`
  (user.rb:565-590). Only the predicates (`isSuspended`, `isFlagged`, ...) are ported.
- Avatar: `has_one_attached :avatar` with `set_avatar_changed` (user.rb:212-215) and
  `validate :avatar_is_valid` (user.rb:377). Node attaches no files, so both are no-ops here.
- `seller_profile.saved_changes` in the `clear_products_cache` and `generate_subscribe_preview`
  conditions (user.rb:483, 2011): callers pass them as `ivars.seller_profile_saved_changes`. Rails'
  `seller_profile` also builds an unsaved profile there, which a later save of the same instance
  inserts; that is not reproduced.
- `perform_bulk` in `clear_products_cache` enqueues one job per product rather than one push, so
  the jobs' `created_at` can differ by milliseconds.
- `json_data` values compare by their JSON text in the merge, where Ruby compares values (1 vs 1.0).
- Instance methods beyond the ones jobs need: the payout, balance, stats, tax, compliance,
  team, social login, avatar URL and communities methods (user.rb:247-1760 and app/modules/user).
  `deactivate!`, `invalidate_active_sessions!`, `with_lock` and the risk transitions in particular.
- `Mail::Address#domain` is reproduced for addresses EMAIL_REGEX accepts and `Name <addr>`; other
  shapes follow the golden vectors only.

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
