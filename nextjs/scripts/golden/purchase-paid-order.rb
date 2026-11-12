# frozen_string_literal: true

# Writes nextjs/src/server/models/__fixtures__/purchase-paid-order.golden.json: POST /orders for a paid ($5, USD, one-time) product
# bought with a tokenized card, driven through the real app (ActionDispatch::Integration::Session) against a scratch database, with
# every statement the mysql2 driver sent (SELECTs included), every app Redis command, every Flipper read, every Sidekiq push, every
# Elasticsearch request and every Stripe or TaxJar call in the order Rails made them. Stripe and TaxJar are answered by WebMock from
# support/stripe_paid_order.rb (never the real services).
#
# Cases: the succeeded order, a decline and its variants, a lost PaymentIntent create (retried by the gem, and lost for good), a lost
# confirm, a requires_action (3DS) intent with the late confirmation that follows it, a processing intent, and a taxed, tipped,
# discounted and multi-line order.
#
# `marker` entries bracket Order::CreateService, Purchase::CreateService, Order::ChargeService, Charge::CreateService and each
# request, so a replay can take one span.
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_test_24 TEST_DATABASE_NAME=gumroad_test_24 DISABLE_TEST_REDIS_ISOLATION=1 \
#     REDIS_HOST=redis:6379/50 SIDEKIQ_REDIS_HOST=redis:6379/51 RPUSH_REDIS_HOST=redis:6379/52 \
#     RACK_ATTACK_REDIS_HOST=redis:6379/53 DISABLE_SPRING=1 bundle exec rails runner nextjs/scripts/golden/purchase-paid-order.rb
require_relative "support/paid_sale"
require_relative "support/stripe_paid_order"

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/purchase-paid-order.golden.json")

APP_REDIS_DB = ENV.fetch("REDIS_HOST")[%r{/(\d+)\z}, 1].to_i
module RedisRecorder
  def call_v(command, &block) = RedisRecorder.wrap(self, command) { super }
  def call_once_v(command, &block) = RedisRecorder.wrap(self, command) { super }
  def blocking_call_v(timeout, command, &block) = RedisRecorder.wrap(self, command) { super }

  def self.wrap(client, command)
    result = yield
    if RailsRecorder.log && client.config.db == APP_REDIS_DB
      RailsRecorder.log << { "redis" => command.map(&:to_s), "result" => RailsRecorder.encode_value(result) }
    end
    result
  end
end
RedisClient.prepend(RedisRecorder)

module Marker
  def self.around(klass, method, name)
    klass.prepend(Module.new do
      define_method(method) do |*args, **kwargs, &block|
        marker(name, "start")
        super(*args, **kwargs, &block)
      ensure
        marker(name, "end")
      end
    end)
  end
end
Marker.around(Order::CreateService, :perform, "Order::CreateService")
Marker.around(Purchase::CreateService, :perform, "Purchase::CreateService")
Marker.around(Order::ChargeService, :perform, "Order::ChargeService")
Marker.around(Charge::CreateService, :perform, "Charge::CreateService")
Marker.around(Order::ConfirmService, :perform, "Order::ConfirmService")

# The Stripe and TaxJar calls, in order with the statements around them.
class LoggedResponder
  def initialize(stripe) = @stripe = stripe

  def call(request, entry)
    uri = request.uri
    log = { "http" => { "method" => request.method.to_s.upcase, "host" => uri.host, "path" => uri.path, "query" => uri.query, "body" => request.body } }
    RailsRecorder.log << log if RailsRecorder.log
    answer = @stripe.call(request, entry)
    log["http"]["status"] = answer[:status]
    answer
  rescue StandardError => e
    log["http"]["raised"] = e.class.name
    raise
  end
end

JSON_HEADERS = {
  "Accept" => "application/json", "X-Requested-With" => "XMLHttpRequest", "Content-Type" => "application/json",
  "Referer" => "http://#{DOMAIN}/checkout"
}.freeze

def line(permalink, uid: "uid-0", price_cents: 500, **extra)
  {
    uid:, permalink:, is_multi_buy: false, is_preorder: false, is_rental: false, perceived_price_cents: price_cents, price_cents:,
    tip_cents: nil, quantity: 1, pay_in_installments: false, bundle_products: [], variants: [], call_start_time: "",
    discount_code: "", was_product_recommended: false, recommended_by: "", recommender_model_name: "", affiliate_id: "",
    url_parameters: "{}", referrer: "direct", is_purchasing_power_parity_discounted: false, accepts_purchasing_power_parity_discount: true,
    force_new_subscription: false, custom_fields: []
  }.merge(extra)
end

BUYER = { full_name: "Edgar Gumstein", street_address: "123 Gum Road", country: "United States", state: "CA", city: "San Francisco", zip_code: "94117" }.freeze
WA_BUYER = { full_name: "Edgar Gumstein", street_address: "1 Pike St", country: "United States", state: "WA", city: "Seattle", zip_code: "98121" }.freeze

def order_body(*lines, buyer: BUYER, **extra)
  {
    plugins: "", friend: "", url_parameters: "{}", locale: "en", email: "buyer@example.com", tax_country_election: "",
    is_gift: false, vat_id: "", "g-recaptcha-response": "", recaptcha_challenge_fallback: false, buyer_currency_quote: "",
    cc_zipcode_required: "false", cc_zipcode: buyer[:zip_code], purchase: buyer, line_items: lines,
    card_data_handling_mode: CardDataHandlingMode::TOKENIZE_VIA_STRIPEJS, stripe_payment_method_id: StripePaidOrder::PM_ID
  }.merge(extra)
end

# There is no GeoIP database in the lane, so a buyer's address resolves only through this table (documentation range 203.0.113.0/24).
SEATTLE_IP = "203.0.113.7"
SEATTLE = GeoIp::Result.new(country_name: "United States", country_code: "US", region_name: "WA", city_name: "Seattle",
                            postal_code: "98121", latitude: "47.6", longitude: "-122.3")
GeoIp.singleton_class.prepend(Module.new { def lookup(ip) = ip == SEATTLE_IP ? SEATTLE : super })

def request_json(label, path, body, ip: nil)
  marker("request #{label}", "start")
  s = ActionDispatch::Integration::Session.new(Rails.application).tap { _1.host!(DOMAIN) }
  s.post path, params: body.to_json, headers: JSON_HEADERS, env: ip ? { "REMOTE_ADDR" => ip } : {}
  JSON.parse(s.response.body).merge("_status" => s.response.status)
ensure
  marker("request #{label}", "end")
end

def paid_universe
  # A request writes tables the seed does not touch, so every table is cleared and dumped, not just the last case's.
  $dirty = ALL_TABLES.dup
  universe do
    seller = create(:user, created_at: SEEDED_AT, updated_at: SEEDED_AT)
    seller.update_columns(flags: seller.flags | User.flag_mapping["flags"][:tipping_enabled])
    MerchantAccount.create!(charge_processor_id: "stripe", charge_processor_merchant_id: "acct_platform", charge_processor_alive_at: SEEDED_AT)
    first = create(:product, user: seller, unique_permalink: "paidone", price_cents: 500, created_at: SEEDED_AT, updated_at: SEEDED_AT)
    create(:product, user: seller, unique_permalink: "paidtwo", price_cents: 1000, created_at: SEEDED_AT, updated_at: SEEDED_AT)
    create(:offer_code, user: seller, products: [first], code: "half", amount_percentage: 50, amount_cents: nil, created_at: SEEDED_AT, updated_at: SEEDED_AT)
    yield seller, first if block_given?
  end
end

def run_case(name, seed:, stripe: StripePaidOrder.new)
  warn "case: #{name}"
  $random_seq = 0
  responses = []
  # TaxjarApi caches calculations in the app's Redis, which `capture` leaves alone: a warm cache would hide the TaxJar call.
  $redis.scan_each(match: "taxjar_calculations:*") { $redis.del(_1) }
  result = capture(name, now: NOW, tables: ALL_TABLES, seed:) do
    HttpCapture.responder = LoggedResponder.new(stripe)
    yield responses
  end
  result.merge("responses" => responses, "intents" => stripe.intents.values.map { _1.slice("id", "amount", "status") })
end

# ONLY=<regexp> re-records just the cases whose name matches and keeps the others from the committed file (a full run takes close to an hour).
ONLY = ENV["ONLY"] && Regexp.new(ENV["ONLY"])
cases = []
order_case = ->(name, body, stripe: StripePaidOrder.new, seed: nil, follow: nil, ip: nil) do
  next if ONLY && !name.match?(ONLY)

  seed ||= paid_universe
  cases << run_case(name, seed:, stripe:) do |responses|
    first = request_json("POST /orders", "/orders", body, ip:)
    responses << first
    if follow
      order_id = first.dig("line_items", "uid-0", "order", "id")
      responses << request_json("POST /orders/:id/confirm", "/orders/#{order_id}/confirm", follow)
    end
  end
end

order_case.("a $5 sale", order_body(line("paidone")))
order_case.("a declined card", order_body(line("paidone")), stripe: StripePaidOrder.new(confirm: :decline))
order_case.("a declined card, incorrect zip", order_body(line("paidone")),
            stripe: StripePaidOrder.new(confirm: :decline, decline: { code: "incorrect_zip", decline_code: nil, message: "Your card's zip code is incorrect." }))
order_case.("a declined card, fraudulent", order_body(line("paidone")),
            stripe: StripePaidOrder.new(confirm: :decline, decline: { code: "card_declined", decline_code: "fraudulent", message: "Your card was declined." }))
order_case.("a declined card, insufficient funds", order_body(line("paidone")),
            stripe: StripePaidOrder.new(confirm: :decline, decline: { code: "card_declined", decline_code: "insufficient_funds", message: "Your card has insufficient funds." }))
order_case.("the PaymentIntent create loses its first answer", order_body(line("paidone")), stripe: StripePaidOrder.new(create: 1))
order_case.("the PaymentIntent create loses every answer", order_body(line("paidone")), stripe: StripePaidOrder.new(create: :drop))
order_case.("the confirm loses its first answer", order_body(line("paidone")), stripe: StripePaidOrder.new(confirm: 1))
order_case.("the confirm loses every answer", order_body(line("paidone")), stripe: StripePaidOrder.new(confirm: :drop))
order_case.("a requires_action intent", order_body(line("paidone")), stripe: StripePaidOrder.new(confirm: :requires_action))
order_case.("a processing intent", order_body(line("paidone")), stripe: StripePaidOrder.new(confirm: :processing))
order_case.("a requires_action intent confirmed late", order_body(line("paidone")),
            stripe: StripePaidOrder.new(confirm: :requires_action, retrieve: :succeeded), follow: {})
order_case.("a requires_action intent confirmed late, the card fails", order_body(line("paidone")),
            stripe: StripePaidOrder.new(confirm: :requires_action, retrieve: :requires_payment_method), follow: {})

order_case.("a taxed order (TaxJar answers)", order_body(line("paidone"), buyer: WA_BUYER), ip: SEATTLE_IP)
order_case.("a taxed order (TaxJar is down)", order_body(line("paidone"), buyer: WA_BUYER), stripe: StripePaidOrder.new(taxjar: :down), ip: SEATTLE_IP)
order_case.("a tipped order", order_body(line("paidone", tip_cents: 100, perceived_price_cents: 600)))
order_case.("a discounted order", order_body(line("paidone", discount_code: "half", perceived_price_cents: 250)))
order_case.("a multi-line order, taxed, tipped and discounted",
            order_body(line("paidone", discount_code: "half", perceived_price_cents: 250),
                       line("paidtwo", uid: "uid-1", price_cents: 1000, perceived_price_cents: 1100, tip_cents: 100), buyer: WA_BUYER),
            ip: SEATTLE_IP)

if ONLY
  kept = JSON.parse(File.read(OUT))["cases"]
  cases = kept.map { |old| cases.find { _1["name"] == old["name"] } || old } + cases.reject { |new| kept.any? { _1["name"] == new["name"] } }
end
File.write(OUT, JSON.pretty_generate({ "now" => NOW.iso8601(3), "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
