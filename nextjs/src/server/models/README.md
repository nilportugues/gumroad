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
- `user.ts`, `link.ts`: the first model services.
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
```

## Known gaps

- Record attributes are not type-cast on assignment. Code that sets a datetime must truncate it to the
  column precision itself, as `Deletable` does; MySQL would otherwise round it.
- Prisma returns JSON column numbers as JS numbers, so a stored `1.0` reads back as the Integer `1`.
  Versions of JSON columns can differ from Rails for such values.
- No `touch`, so `has_paper_trail`'s `on_touch` callback is not ported.
- `json_data` accessors (`attr_json_data_accessor`) and `stripped_fields` are not ported yet.

Still Ruby-only on `User`: `stripped_fields`, the username/email uniqueness and format validators,
`timezone`/`currency_type`/`recommendation_type` inclusion, every `validate :method`, password
validations, `save_external_id`, `set_refund_policy_enabled` (needs Flipper), avatar tracking, the
`after_*` callbacks that touch other models or enqueue jobs, and the state machine.

Still Ruby-only on `Link`: permalink generation and locking, `user` presence, `default_price_cents`,
`support_email` and `json_data`-backed validations, every `validate :method`, `validates_associated
:installment_plan`, `set_default_discover_fee_per_thousand` (reads the seller), and the `after_*` and
`after_commit` callbacks that touch prices, offer codes, caches, licenses and search.
