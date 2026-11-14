# frozen_string_literal: true

# Writes nextjs/src/server/models/__fixtures__/stripe-payment-intent-request.golden.json: the HTTP requests the real
# `StripeChargeProcessor#create_payment_intent_or_charge!` sends to Stripe (method, path, the headers a port has to set, the
# form-encoded body), over the branches of a paid checkout: plain card, on-session future usage, off-session confirm, Indian
# mandates (validated, looked up, passed as options, missing), UPI Autopay, a buyer-currency quote, a direct charge, a destination
# charge, and statement descriptors. Refusals before any call are recorded as the error Ruby raises.
#
# Stripe is never reached: WebMock answers every call with a canned PaymentIntent in `requires_confirmation`, and the two
# lookups the mandate branch makes (`get_mandate_id_from_chargeable`, `reject_pending_checkout_mandate!`) are replaced on the
# processor instance, with the fact that they were asked recorded as `mandate_lookup`.
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_test_24 TEST_DATABASE_NAME=gumroad_test_24 DISABLE_TEST_REDIS_ISOLATION=1 \
#     REDIS_HOST=redis:6379/50 SIDEKIQ_REDIS_HOST=redis:6379/51 RPUSH_REDIS_HOST=redis:6379/52 \
#     RACK_ATTACK_REDIS_HOST=redis:6379/53 DISABLE_SPRING=1 bundle exec rails runner nextjs/scripts/golden/stripe-payment-intent-request.rb
require "json"
require "webmock"
require "factory_bot_rails"
include FactoryBot::Syntax::Methods
include WebMock::API

FactoryBot.definition_file_paths << Rails.root.join("spec", "support", "factories")
FactoryBot.reload

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/stripe-payment-intent-request.golden.json")
Rails.logger = ActiveSupport::Logger.new(nil)
ActiveRecord::Base.connection.execute("SET FOREIGN_KEY_CHECKS = 0")
%w[merchant_accounts users].each { |t| ActiveRecord::Base.connection.execute("DELETE FROM #{t}") }
Redis.new(url: "redis://#{ENV.fetch('REDIS_HOST')}").flushdb

NOTIFICATIONS = []
ErrorNotifier.singleton_class.prepend(Module.new do
  def notify(*args, **kwargs) = NOTIFICATIONS << { args: args.map(&:to_s), kwargs: kwargs.transform_values(&:to_s) }
end)

CAPTURED = []
EXPLICIT_KEY = { value: nil }
stub_request(:post, %r{\Ahttps://api\.stripe\.com/v1/payment_intents(/[^/]+/confirm)?\z}).with do |request|
  CAPTURED << {
    method: request.method.to_s.upcase,
    path: request.uri.path.sub(/pi_\w+/, "pi_ID"),
    headers: {
      # the caller's own key, or the one the stripe gem makes up per attempt
      "Idempotency-Key" => request.headers["Idempotency-Key"] == EXPLICIT_KEY[:value] ? "<explicit>" : "<generated>",
      "Stripe-Account" => request.headers["Stripe-Account"],
      "Stripe-Version" => request.headers["Stripe-Version"],
      "Content-Type" => request.headers["Content-Type"],
    }.compact,
    body: request.body.to_s,
  }
  true
end.to_return do |request|
  status = request.uri.path.end_with?("/confirm") ? "processing" : "requires_confirmation"
  { status: 200, headers: { "Content-Type" => "application/json" },
    body: { id: "pi_ID", object: "payment_intent", status:, amount: 500, currency: "usd", latest_charge: nil, next_action: nil, last_payment_error: nil, metadata: {} }.to_json }
end

PROCESSOR = StripeChargeProcessor.new
PROCESSOR.define_singleton_method(:get_mandate_id_from_chargeable) { |*| (MANDATE_LOOKUPS << :lookup) && RESOLVED_MANDATE[:id] }
PROCESSOR.define_singleton_method(:reject_pending_checkout_mandate!) { |*| MANDATE_LOOKUPS << :pending_check }
MANDATE_LOOKUPS = []
RESOLVED_MANDATE = { id: nil }

SELLER = create(:user)
WebMock.enable!
WebMock.disable_net_connect!
DESTINATION = MerchantAccount.new(user_id: SELLER.id, charge_processor_id: "stripe", charge_processor_merchant_id: "acct_destination", country: "GB")
DIRECT = MerchantAccount.new(user_id: SELLER.id, charge_processor_id: "stripe", charge_processor_merchant_id: "acct_direct", country: "CA")
DIRECT.json_data = { "meta" => { "stripe_connect" => "true" } }
PLATFORM = MerchantAccount.new(user_id: nil, charge_processor_id: "stripe", charge_processor_merchant_id: "acct_platform")
MERCHANTS = { "platform" => PLATFORM, "destination" => DESTINATION, "direct" => DIRECT }.freeze

def chargeable_from(spec, merchant)
  case spec["kind"]
  when "payment_method"
    chargeable = StripeChargeablePaymentMethod.allocate
    chargeable.instance_variable_set(:@merchant_account, merchant)
    chargeable.instance_variable_set(:@payment_method_id, spec["payment_method_id"])
    chargeable.instance_variable_set(:@customer_id, spec["customer_id"])
    chargeable.instance_variable_set(:@payment_method_id_on_connect_account, spec["payment_method_id_on_connect_account"])
    chargeable.instance_variable_set(:@customer_id_on_connect_account, spec["customer_id_on_connect_account"])
    chargeable.stripe_setup_intent_id = spec["stripe_setup_intent_id"]
    chargeable.validated_stripe_mandate_id = spec["validated_mandate_id"]
    payment_method = Stripe::PaymentMethod.construct_from(type: "card", card: { brand: "visa", country: spec["country"] })
    chargeable.instance_variable_set(:@payment_method, payment_method)
    chargeable.instance_variable_set(:@payment_method_on_connect_account, payment_method)
    chargeable
  when "upi"
    StripeChargeableUpi.new(merchant_account: merchant, customer_id: spec["customer_id"], payment_method_id: spec["payment_method_id"],
                            fingerprint: "fp", stripe_payment_intent_id: nil, stripe_account_id: nil,
                            recurring_authorization_verified_at: spec["verified"] ? Time.current : nil,
                            recurring_authorization_currency: spec["authorization_currency"],
                            recurring_authorization_max_amount_cents: spec["authorization_max_cents"])
  end
end

BASE = {
  "merchant" => "platform",
  "chargeable" => { "kind" => "payment_method", "payment_method_id" => "pm_card", "customer_id" => nil, "country" => "US" },
  "amount_cents" => 500, "amount_for_gumroad_cents" => 145, "reference" => "CH-1", "description" => "Gumroad Charge abc==",
  "metadata" => { "purchases{0}" => "p0==" }, "statement_description" => "Edgar", "transfer_group" => "CH-1",
  "off_session" => false, "setup_future_charges" => false, "mandate_options" => nil, "mandate_expected" => false,
  "resolved_mandate_id" => nil, "fail_fast_without_mandate" => false,
  "processor_amount_cents" => nil, "processor_currency" => nil, "processor_gumroad_amount_cents" => nil,
  "stripe_fx_quote_id" => nil, "idempotency_key" => nil,
}.freeze

def with(**overrides)
  chargeable = overrides.delete(:chargeable)
  input = BASE.merge(overrides.transform_keys(&:to_s))
  input["chargeable"] = BASE["chargeable"].merge(chargeable.transform_keys(&:to_s)) if chargeable
  input
end

def run_case(input)
  CAPTURED.clear
  MANDATE_LOOKUPS.clear
  NOTIFICATIONS.clear
  RESOLVED_MANDATE[:id] = input["resolved_mandate_id"]
  EXPLICIT_KEY[:value] = input["idempotency_key"].presence
  input["fail_fast_without_mandate"] ? Feature.activate(:fail_india_recurring_charge_without_mandate) : Feature.deactivate(:fail_india_recurring_charge_without_mandate)
  merchant = MERCHANTS.fetch(input["merchant"])
  chargeable = chargeable_from(input["chargeable"], merchant)
  options = {
    metadata: input["metadata"]&.transform_keys(&:to_s), statement_description: input["statement_description"],
    transfer_group: input["transfer_group"], off_session: input["off_session"], setup_future_charges: input["setup_future_charges"],
    mandate_options: input["mandate_options"]&.deep_symbolize_keys, mandate_expected: input["mandate_expected"],
    processor_amount_cents: input["processor_amount_cents"], processor_currency: input["processor_currency"],
    processor_gumroad_amount_cents: input["processor_gumroad_amount_cents"], stripe_fx_quote_id: input["stripe_fx_quote_id"],
    idempotency_key: input["idempotency_key"]
  }
  options[:metadata] = nil if input["metadata"].nil?
  error = nil
  begin
    PROCESSOR.create_payment_intent_or_charge!(merchant, chargeable, input["amount_cents"], input["amount_for_gumroad_cents"],
                                               input["reference"], input["description"], **options)
  rescue StandardError => e
    error = { class: e.class.name, message: e.message, code: e.respond_to?(:error_code) ? e.error_code : nil }
  end
  { input:, output: { requests: CAPTURED.map(&:dup), error:, mandate_lookup: MANDATE_LOOKUPS.dup, notified: NOTIFICATIONS.size } }
end

cases = []
add = ->(**overrides) { cases << run_case(with(**overrides)) }

# plain card, every merchant account shape
%w[platform destination direct].each { |merchant| add.call(merchant:) }
add.call(merchant: "direct", chargeable: { payment_method_id_on_connect_account: "pm_on_connect", customer_id_on_connect_account: "cus_on_connect" })
add.call(merchant: "direct", chargeable: { payment_method_id_on_connect_account: "pm_on_connect", customer_id_on_connect_account: nil })
add.call(chargeable: { customer_id: "cus_1" })
add.call(metadata: nil, reference: "ref-with spaces & symbols")
add.call(description: "Gumroad Charge x+y=z & 100%")
add.call(description: "")
add.call(transfer_group: nil, metadata: { "k" => "", "other" => "v" })
add.call(idempotency_key: "key-abc")
add.call(merchant: "direct", idempotency_key: "key-abc")

# future usage and off-session
add.call(setup_future_charges: true)
add.call(setup_future_charges: true, off_session: true)
add.call(off_session: true)
add.call(off_session: true, merchant: "destination")
add.call(off_session: true, merchant: "direct")
add.call(setup_future_charges: true, chargeable: { country: "IN" })
add.call(setup_future_charges: true, chargeable: { country: "IN" }, merchant: "direct")

# Indian mandates
add.call(off_session: true, chargeable: { country: "IN", validated_mandate_id: "mandate_validated" })
add.call(off_session: true, chargeable: { country: "IN" }, resolved_mandate_id: "mandate_resolved")
add.call(off_session: true, chargeable: { country: "IN" }, resolved_mandate_id: "mandate_resolved", mandate_expected: true)
add.call(off_session: true, chargeable: { country: "IN" }, resolved_mandate_id: nil)
add.call(off_session: true, chargeable: { country: "IN" }, resolved_mandate_id: nil, mandate_expected: true)
add.call(off_session: true, chargeable: { country: "IN" }, resolved_mandate_id: nil, mandate_expected: true, fail_fast_without_mandate: true)
add.call(off_session: true, chargeable: { country: "IN" }, mandate_options: { payment_method_options: { card: { mandate_options: { reference: "r", amount_type: "maximum", amount: 1000, currency: "inr" } } } })
add.call(off_session: true, chargeable: { country: "IN", kind: "payment_method" }, mandate_options: { payment_method_options: { card: { mandate_options: { reference: "r", amount: 1000 } } } }, resolved_mandate_id: "mandate_from_setup")
add.call(off_session: false, chargeable: { country: "IN" }, mandate_options: { payment_method_options: { card: { mandate_options: { reference: "r", amount: 1000, currency: "inr" } } } })
add.call(off_session: true, chargeable: { country: "IN" }, mandate_options: { payment_method_options: { card: { request_three_d_secure: "any" } } })
add.call(off_session: true, chargeable: { country: "US" }, mandate_options: { payment_method_options: { card: { mandate_options: { reference: "r", currency: "inr" } } } })

# UPI Autopay
upi = { kind: "upi", customer_id: "cus_upi", payment_method_id: "pm_upi", verified: true, authorization_currency: "inr", authorization_max_cents: 1_000_000 }
add.call(off_session: true, chargeable: upi, processor_amount_cents: 99_900, processor_currency: "inr", processor_gumroad_amount_cents: 12_000)
add.call(off_session: false, chargeable: upi, processor_amount_cents: 99_900, processor_currency: "inr")
add.call(off_session: true, chargeable: upi, processor_amount_cents: 99_900, processor_currency: "usd")
add.call(off_session: true, chargeable: upi.merge(verified: false), processor_amount_cents: 99_900, processor_currency: "inr")
add.call(off_session: true, chargeable: upi.merge(authorization_currency: "usd"), processor_amount_cents: 99_900, processor_currency: "inr")
add.call(off_session: true, chargeable: upi.merge(authorization_max_cents: 0), processor_amount_cents: 99_900, processor_currency: "inr")
add.call(off_session: true, chargeable: upi.merge(authorization_max_cents: 50_000), processor_amount_cents: 99_900, processor_currency: "inr")
add.call(off_session: true, chargeable: upi.merge(authorization_max_cents: 2_000_000), processor_amount_cents: 1_600_000, processor_currency: "inr")
add.call(off_session: true, chargeable: upi, processor_amount_cents: 99_900, processor_currency: "inr", mandate_expected: true, setup_future_charges: true)

# buyer currency
add.call(processor_amount_cents: 46_000, processor_currency: "eur", processor_gumroad_amount_cents: 13_000, stripe_fx_quote_id: "fxq_123", idempotency_key: "fx-key")
add.call(processor_amount_cents: 46_000, processor_currency: "eur", processor_gumroad_amount_cents: 13_000, stripe_fx_quote_id: "fxq_123", idempotency_key: "fx-key", merchant: "direct")
add.call(processor_amount_cents: 46_000, processor_currency: "eur", processor_gumroad_amount_cents: 13_000, stripe_fx_quote_id: "fxq_123", idempotency_key: "fx-key", merchant: "destination")
add.call(processor_amount_cents: 46_000, processor_currency: "eur", stripe_fx_quote_id: "", idempotency_key: "")
add.call(processor_amount_cents: 0, processor_currency: "eur")
add.call(processor_amount_cents: 500, processor_currency: "")

# seller proceeds
add.call(merchant: "direct", amount_cents: 100, amount_for_gumroad_cents: 100)
add.call(merchant: "direct", amount_cents: 100, amount_for_gumroad_cents: 101)
add.call(merchant: "destination", amount_cents: 100, amount_for_gumroad_cents: 100)
add.call(merchant: "destination", amount_cents: 100, amount_for_gumroad_cents: 99)
add.call(merchant: "platform", amount_cents: 100, amount_for_gumroad_cents: 500)
add.call(merchant: "destination", processor_amount_cents: 400, processor_currency: "eur", processor_gumroad_amount_cents: 400)

# statement descriptors
["Edgar", "edgarfe2cd25a1", "Jane Doe & Sons, LLC!", "A very long creator name that keeps going past the limit",
 "  padded  ", "Ünïcødé Nâme", "名前", "!!!", "", nil, "a.b/c d", "UPPER lower 123", "x" * 22, "x" * 23, "a  b", "tab\tname", "new\nline",
 "dots...", "slash//", "12345678901234567890 ab", "1234567890123456789 -ab"].each do |name|
  add.call(statement_description: name)
end

File.write(OUT, JSON.pretty_generate(
  constants: { base: BASE },
  cases:
) + "\n")
puts "wrote #{OUT} (#{cases.size} cases, #{cases.count { |c| c[:output][:error] }} refusals)"
