# frozen_string_literal: true

# Writes nextjs/src/server/models/__fixtures__/refund-write.golden.json: the Refund row as refund_purchase! and
# Credit.create_for_refund_fee_retention! write it (`purchase.refunds << refund`, then a `save!` after the retained fee is set), run by the
# real classes against a scratch database, with every statement the mysql2 driver sent recorded between the "refund" markers.
# Stripe is never reached: nothing in a Refund save calls it.
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_test_28 TEST_DATABASE_NAME=gumroad_test_28 DISABLE_TEST_REDIS_ISOLATION=1 \
#     REDIS_HOST=redis:6379/45 SIDEKIQ_REDIS_HOST=redis:6379/46 RPUSH_REDIS_HOST=redis:6379/47 \
#     RACK_ATTACK_REDIS_HOST=redis:6379/48 DISABLE_SPRING=1 bundle exec rails runner nextjs/scripts/golden/refund-write.rb
require_relative "support/paid_sale"

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/refund-write.golden.json")

BASE = [["total_transaction_cents", 500], ["amount_cents", 500], ["creator_tax_cents", 0], ["fee_cents", 145], ["gumroad_tax_cents", 0]].freeze

def seed_refund(purchase, **attributes)
  Refund.new({ purchase:, link_id: purchase.link_id, seller_id: purchase.seller_id, processor_refund_id: "re_golden01", status: "succeeded",
               total_transaction_cents: 100, amount_cents: 100, fee_cents: 0, creator_tax_cents: 0, gumroad_tax_cents: 0,
               created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(attributes)).save!(validate: false)
end

# inserts: attribute assignments applied in order before `refunds << refund`; updates: applied after it, then `save!` (one list per save).
def run_case(name, seed:, inserts: BASE, updates: [], existing: false, concurrent: nil)
  warn "case: #{name}"
  $random_seq = 0
  result = nil
  out = capture(name, now: NOW, tables: $dirty, seed:, inserts:, updates:, existing:) do
    purchase = Purchase.find(1)
    purchase.link.user
    purchase.seller
    refund = existing ? Refund.find(1) : Refund.new
    concurrent&.call # another request writes the row after this instance loaded it
    marker("refund", "start")
    begin
      unless existing
        inserts.each { |key, value| refund.public_send("#{key}=", value) }
        result = purchase.refunds << refund
      end
      updates.each do |batch|
        batch.each { |key, value| refund.public_send("#{key}=", value) }
        refund.save!
      end
    ensure
      marker("refund", "end")
    end
  end
  c = ActiveRecord::Base.connection
  $dirty = ALL_TABLES.reject { c.select_value("SELECT 1 FROM #{c.quote_table_name(_1)} LIMIT 1").nil? }
  out.merge("appended" => result ? true : false)
end

def plain_sale(&) = sale(succeeded_at: SEEDED_AT, &)

warn "seeding"
cases = []
cases << run_case("a full refund is inserted with the product and seller of its purchase", seed: plain_sale, inserts: BASE + [["status", "succeeded"], ["processor_refund_id", "re_new01"], ["is_for_fraud", false]])
cases << run_case("a refund with no processor refund id is inserted", seed: plain_sale, inserts: BASE + [["is_for_fraud", false]])
cases << run_case("a refund for fraud, with a note, funded by Gumroad, is inserted", seed: plain_sale,
                                                                                     inserts: BASE + [["status", "succeeded"], ["processor_refund_id", "re_new01"], ["is_for_fraud", true], ["gumroad_funded", true], ["balance_reconciliation_needed", true], ["note", "Buyer was charged twice"]])
cases << run_case("a refund with a buyer-currency snapshot keeps its json_data keys in order", seed: plain_sale,
                                                                                               inserts: BASE + [["presentment_currency", "eur"], ["presentment_amount_cents", 460], ["presentment_price_cents", 460], ["presentment_tip_cents", 0], ["presentment_settled_currency", "usd"], ["presentment_settled_amount_cents", 500], ["status", "succeeded"], ["processor_refund_id", "re_new02"], ["is_for_fraud", false]])
cases << run_case("a refund whose processor refund id is taken on the same product is not inserted", seed: plain_sale { |purchase, _, _| seed_refund(purchase) },
                                                                                                     inserts: BASE + [["status", "succeeded"], ["processor_refund_id", "re_golden01"], ["is_for_fraud", false]])
cases << run_case("a refund whose processor refund id is taken on another product is inserted", seed: plain_sale { |purchase, seller, _|
  other = create(:product, user: seller, unique_permalink: "other", created_at: SEEDED_AT, updated_at: SEEDED_AT)
  Refund.new(purchase:, link_id: other.id, seller_id: seller.id, processor_refund_id: "re_golden01", status: "succeeded", total_transaction_cents: 100, amount_cents: 100, fee_cents: 0,
             creator_tax_cents: 0, gumroad_tax_cents: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT).save!(validate: false)
}, inserts: BASE + [["status", "succeeded"], ["processor_refund_id", "re_golden01"], ["is_for_fraud", false]])
cases << run_case("a second refund with no processor refund id is inserted", seed: plain_sale { |purchase, _, _| seed_refund(purchase, processor_refund_id: nil) },
                                                                             inserts: BASE + [["is_for_fraud", false]])
cases << run_case("the retained fee and its pending collection are saved on the refund just inserted", seed: plain_sale,
                                                                                                       inserts: BASE + [["status", "succeeded"], ["processor_refund_id", "re_new01"], ["is_for_fraud", false]],
                                                                                                       updates: [[["retained_fee_cents", 61]], [["fee_retention_pending", true]]])
cases << run_case("a retained fee that is not pending leaves the refund not recoverable", seed: plain_sale,
                                                                                          inserts: BASE + [["status", "succeeded"], ["processor_refund_id", "re_new01"], ["is_for_fraud", false]],
                                                                                          updates: [[["retained_fee_cents", 61]], [["fee_retention_pending", false]]])
cases << run_case("a refund is recoverable while attempts are below the cap", seed: plain_sale { |purchase, _, _| seed_refund(purchase) }, existing: true,
                                                                              updates: [[["fee_retention_pending", true], ["fee_retention_attempts", 167]]])
cases << run_case("a refund is not recoverable once attempts reach the cap", seed: plain_sale { |purchase, _, _| seed_refund(purchase) }, existing: true,
                                                                             updates: [[["fee_retention_pending", true], ["fee_retention_attempts", 168]]])
cases << run_case("a written-off refund is no longer pending", seed: plain_sale { |purchase, _, _| seed_refund(purchase) }, existing: true,
                                                               updates: [[["fee_retention_pending", true], ["fee_retention_written_off_at", "2026-11-04T12:30:45Z"]]])
cases << run_case("a save that changes nothing sends no update", seed: plain_sale { |purchase, _, _| seed_refund(purchase) }, existing: true, updates: [[]])
cases << run_case("another save's json_data keys survive a save of a stale record", seed: plain_sale { |purchase, _, _| seed_refund(purchase) }, existing: true,
                  concurrent: -> { Refund.find(1).update_columns(json_data: { "fee_retention_error" => { "class" => "Stripe::APIError", "message" => "boom" } }.to_json) },
                  updates: [[["note", "late"]]])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.iso8601(3), "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
