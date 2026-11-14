# frozen_string_literal: true

# Writes nextjs/src/server/models/__fixtures__/processor-payment-intent.golden.json: Order::ChargeService#save_processor_payment_intent!
# (the row that ties a purchase to the PaymentIntent that charged it), run by the real service against a scratch database with
# every statement the mysql2 driver sent recorded between the "save" markers. Stripe is never reached.
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_test_24 TEST_DATABASE_NAME=gumroad_test_24 DISABLE_TEST_REDIS_ISOLATION=1 \
#     REDIS_HOST=redis:6379/50 SIDEKIQ_REDIS_HOST=redis:6379/51 RPUSH_REDIS_HOST=redis:6379/52 \
#     RACK_ATTACK_REDIS_HOST=redis:6379/53 DISABLE_SPRING=1 bundle exec rails runner nextjs/scripts/golden/processor-payment-intent.rb
require_relative "support/paid_sale"

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/processor-payment-intent.golden.json")

def run_case(name, seed:, intent_id:)
  warn "case: #{name}"
  $random_seq = 0
  result = capture(name, now: NOW, tables: $dirty, seed:, intent_id:) do
    purchase = Purchase.find(1)
    marker("save", "start")
    begin
      Order::ChargeService.allocate.send(:save_processor_payment_intent!, purchase, intent_id)
    ensure
      marker("save", "end")
    end
  end
  c = ActiveRecord::Base.connection
  $dirty = ALL_TABLES.reject { c.select_value("SELECT 1 FROM #{c.quote_table_name(_1)} LIMIT 1").nil? }
  result
end

def existing_intent(intent_id) = ->(purchase, *) { ProcessorPaymentIntent.new(purchase:, intent_id:).save!(validate: false) }

cases = []
cases << run_case("a first intent is inserted", seed: sale, intent_id: "pi_3QFirstIntent")
cases << run_case("an intent already saved for the purchase is updated to the new id", seed: sale(&existing_intent("pi_3QOldIntent")), intent_id: "pi_3QNewIntent")
cases << run_case("the same intent saved again sends no update", seed: sale(&existing_intent("pi_3QSameIntent")), intent_id: "pi_3QSameIntent")
cases << run_case("a blank intent id is invalid", seed: sale, intent_id: "")
cases << run_case("a nil intent id is invalid", seed: sale, intent_id: nil)

File.write(OUT, JSON.pretty_generate({ "now" => NOW.iso8601(3), "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
