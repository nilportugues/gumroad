# frozen_string_literal: true

# Produces nextjs/src/server/models/__fixtures__/link-publish-schedule-invalidated.golden.json: what the real Link#publish_schedule_invalidated?
# (the `if:` of the after_save that cancels a pending publish schedule) answers right after a save that changes one thing about a persisted
# product. Each case lists the columns it starts from and the attributes it changes. Run it like refund-affiliate-balance.rb.
require_relative "support/paid_sale"

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/link-publish-schedule-invalidated.golden.json")
AT = Time.utc(2026, 1, 2, 3, 4, 5)
UNPUBLISHED_BY_ADMIN = Link.flag_mapping["flags"][:is_unpublished_by_admin]
ARCHIVED = Link.flag_mapping["flags"][:archived]

def run_case(name, initial: {}, change:)
  seller = create(:user)
  product = create(:product, user: seller)
  product.update_columns(draft: false, purchase_disabled_at: nil, deleted_at: nil, banned_at: nil, flags: 0, **initial)
  product = Link.find(product.id)
  attributes = change.respond_to?(:call) ? change.call(product) : change
  product.update!(attributes)
  { "name" => name, "initial" => initial.transform_values { _1.respond_to?(:iso8601) ? _1.utc.iso8601 : _1 }.merge("flags" => initial.fetch(:flags, 0)),
    "change" => attributes.transform_values { _1.respond_to?(:iso8601) ? _1.utc.iso8601 : _1 }, "invalidated" => product.send(:publish_schedule_invalidated?) }
end

cases = [
  run_case("deleting a product", change: { deleted_at: AT }),
  run_case("restoring a deleted product", initial: { deleted_at: AT }, change: { deleted_at: nil }),
  run_case("publishing a draft", initial: { draft: true }, change: { draft: false }),
  run_case("turning a published product into a draft", change: { draft: true }),
  run_case("disabling a product", change: { purchase_disabled_at: AT }),
  run_case("enabling a disabled product", initial: { purchase_disabled_at: AT }, change: { purchase_disabled_at: nil }),
  run_case("moving the time a product was disabled", initial: { purchase_disabled_at: AT }, change: { purchase_disabled_at: AT + 1.day }),
  run_case("banning a product", change: { banned_at: AT }),
  run_case("unbanning a product", initial: { banned_at: AT }, change: { banned_at: nil }),
  run_case("an admin takedown of a draft that is already disabled", initial: { draft: true, purchase_disabled_at: AT }, change: { flags: UNPUBLISHED_BY_ADMIN }),
  run_case("an admin takedown of a published product", change: { flags: UNPUBLISHED_BY_ADMIN }),
  run_case("another flag on a product an admin already took down", initial: { flags: UNPUBLISHED_BY_ADMIN }, change: { flags: UNPUBLISHED_BY_ADMIN | ARCHIVED }),
  run_case("clearing the takedown flag", initial: { flags: UNPUBLISHED_BY_ADMIN }, change: { flags: 0 }),
  run_case("a flag that is not a takedown", change: { flags: ARCHIVED }),
  run_case("renaming a product", change: { name: "Renamed" }),
]

File.write(OUT, JSON.pretty_generate({ "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
