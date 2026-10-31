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

## Known gaps

- Record attributes are not type-cast on assignment. Code that sets a datetime must truncate it to the
  column precision itself, as `Deletable` does; MySQL would otherwise round it.
- Prisma returns JSON column numbers as JS numbers, so a stored `1.0` reads back as the Integer `1`.
  Versions of JSON columns can differ from Rails for such values.
- No `touch`, so `has_paper_trail`'s `on_touch` callback is not ported.
- `json_data` accessors (`attr_json_data_accessor`) and `stripped_fields` are not ported yet.

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

Still Ruby-only on `Link`: permalink generation and locking, `user` presence, `default_price_cents`,
`support_email` and `json_data`-backed validations, every `validate :method`, `validates_associated
:installment_plan`, `set_default_discover_fee_per_thousand` (reads the seller), and the `after_*` and
`after_commit` callbacks that touch prices, offer codes, caches, licenses and search.
