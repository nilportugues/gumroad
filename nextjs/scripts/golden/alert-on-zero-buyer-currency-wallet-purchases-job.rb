# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/alert-on-zero-buyer-currency-wallet-purchases-job.golden.json:
# AlertOnZeroBuyerCurrencyWalletPurchasesJob run by the real app against a scratch database as a Sidekiq job
# (support/sidekiq_executor.rb). The two Flipper features and the throttle key are set before each case
# (`redis_before`); the alert is an InternalNotificationWorker push. REDIS_HOST and SIDEKIQ_REDIS_HOST must name the same
# Redis database so one snapshot holds the flags, the throttle and the push. Run it like expiring-credit-card-message-worker.rb
# (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/alert-on-zero-buyer-currency-wallet-purchases-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[purchases purchase_presentments purchase_wallet_types].freeze
PE = Checkout::BuyerCurrencyEligibility::PAYMENT_ELEMENT_WALLETS_FEATURE_NAME
WALLETS = Checkout::BuyerCurrencyEligibility::WALLETS_FEATURE_NAME
THROTTLE_KEY = RedisKey.buyer_currency_wallet_presentment_zero_alerted_at

Rails.logger = ActiveSupport::Logger.new(nil)

# One flag makes the push fail, as a Sidekiq client outage would.
$fail_push = false
InternalNotificationWorker.singleton_class.prepend(Module.new do
  def perform_async(*)
    raise "push failed" if $fail_push

    super
  end
end)

def ago(hours) = (NOW - hours.hours).utc.strftime("%Y-%m-%d %H:%M:%S")

def purchase_row(id, at, state: "successful") = { id:, link_id: 1, seller_id: 1, email: "buyer#{id}@example.com", purchase_state: state, price_cents: 100, flags: 0, created_at: at, updated_at: at }

def presentment_row(purchase, currency = "eur") = { id: purchase, purchase_id: purchase, processor: "stripe", presentment_currency: currency, presentment_price_cents: 100, presentment_total_cents: 100, presentment_gumroad_amount_cents: 10, created_at: SEEDED_AT, updated_at: SEEDED_AT }

def wallet_row(purchase, type = "apple_pay") = { id: purchase, purchase_id: purchase, wallet_type: type }

# A purchase that counts: successful, a wallet type and a non-USD presentment.
def counted(id, at, currency: "eur", wallet: "apple_pay", state: "successful")
  { purchases: [purchase_row(id, at, state:)], purchase_presentments: [presentment_row(id, currency)], purchase_wallet_types: [wallet_row(id, wallet)] }
end

def merge_seeds(*seeds) = seeds.each_with_object(Hash.new { |h, k| h[k] = [] }) { |seed, all| seed.each { |table, rows| all[table].concat(rows) } }

def enable_gate(feature, gate)
  case gate
  when :on then Feature.activate(feature)
  when :off
    Feature.activate(feature)
    Feature.deactivate(feature)
  when :actors100 then Feature.activate_percentage(feature, 100)
  when :actors99 then Feature.activate_percentage(feature, 99)
  when :actors50 then Feature.activate_percentage(feature, 50)
  when :time100 then Flipper.enable_percentage_of_time(feature, 100)
  when :time0 then Flipper.enable_percentage_of_time(feature, 0)
  when :actors_fraction then Feature.activate_percentage(feature, 99.9)
  when :actors100_and_actor_gate
    Feature.activate_percentage(feature, 100)
    Flipper.enable_actor(feature, User.new.tap { _1.id = 5 })
  else raise "unknown gate #{gate}"
  end
end

def run(name, seed = {}, flags: { PE => :on, WALLETS => :on }, throttle: nil, fail_push: false)
  setup = lambda do
    flags.each { |feature, gate| enable_gate(feature, gate) }
    redis.set(THROTTLE_KEY, throttle[:value], **(throttle[:ttl] ? { ex: throttle[:ttl] } : {})) if throttle
  end
  $fail_push = fail_push
  result = capture(name, now: NOW, tables: TABLES, seed:, setup:, sidekiq: true, job: "AlertOnZeroBuyerCurrencyWalletPurchasesJob", args: []) do
    AlertOnZeroBuyerCurrencyWalletPurchasesJob.new.perform
  end
  result.delete("seed")
  result.delete("rows")
  result
end

cases = []
cases << run("no feature is set", flags: {})
cases << run("no feature is set and a throttle from an earlier alert", flags: {}, throttle: { value: "1", ttl: 3600 })
cases << run("only the payment element feature is on", flags: { PE => :on })
cases << run("only the wallets feature is on", flags: { WALLETS => :on })
cases << run("a feature enabled then disabled", flags: { PE => :on, WALLETS => :off })
cases << run("both features on and no purchase ever")
cases << run("both features at 100 percent of actors", flags: { PE => :actors100, WALLETS => :actors100 })
cases << run("one feature on and the other at 100 percent of actors", flags: { PE => :on, WALLETS => :actors100 })
cases << run("one feature at 99 percent of actors", flags: { PE => :on, WALLETS => :actors99 })
cases << run("a feature at 50 percent of actors", flags: { PE => :on, WALLETS => :actors50 })
cases << run("both features at 100 percent of time", flags: { PE => :time100, WALLETS => :time100 })
cases << run("a feature at 0 percent of time", flags: { PE => :on, WALLETS => :time0 })
cases << run("a feature at 99.9 percent of actors reads as 99", flags: { PE => :on, WALLETS => :actors_fraction })
cases << run("a feature with an actor gate and a 100 percent actors gate", flags: { PE => :actors100_and_actor_gate, WALLETS => :on })
cases << run("both features on and a counted purchase an hour ago", counted(1, ago(1)))
cases << run("a recent purchase resets an earlier throttle", counted(1, ago(1)), throttle: { value: "5", ttl: 1000 })
cases << run("a counted purchase just inside the window", counted(1, ago(23.99)))
cases << run("a counted purchase exactly 24 hours ago", counted(1, ago(24)))
cases << run("a counted purchase 25 hours ago", counted(1, ago(25)))
cases << run("a counted purchase 25 hours ago with a live throttle", counted(1, ago(25)), throttle: { value: "7", ttl: 5000 })
cases << run("a counted purchase 25 hours ago with a throttle that never expires", counted(1, ago(25)), throttle: { value: "7", ttl: nil })
cases << run("a counted purchase 48 hours and 59 minutes ago", counted(1, (NOW - 48.hours - 59.minutes).utc.strftime("%Y-%m-%d %H:%M:%S")))
cases << run("a google pay purchase 30 hours ago", counted(1, ago(30), wallet: "google_pay"))
cases << run("a non wallet purchase an hour ago does not count", counted(1, ago(1), wallet: "link"))
cases << run("a usd presentment an hour ago does not count", counted(1, ago(1), currency: "usd"))
cases << run("an uppercase usd presentment an hour ago", counted(1, ago(1), currency: "USD"))
cases << run("a failed purchase an hour ago does not count", counted(1, ago(1), state: "failed"))
cases << run("a purchase with a presentment and no wallet type", { purchases: [purchase_row(1, ago(1))], purchase_presentments: [presentment_row(1)] })
cases << run("a purchase with a wallet type and no presentment", { purchases: [purchase_row(1, ago(1))], purchase_wallet_types: [wallet_row(1)] })
cases << run("the newest id decides the last purchase time", merge_seeds(counted(1, ago(80)), counted(2, ago(30)), counted(3, ago(50))))
cases << run("an older purchase with a newer id", merge_seeds(counted(1, ago(30)), counted(2, ago(60))))
cases << run("a recent purchase among old ones", merge_seeds(counted(1, ago(80)), counted(2, ago(2))))
cases << run("a purchase created in the future", counted(1, (NOW + 2.hours).utc.strftime("%Y-%m-%d %H:%M:%S")))
cases << run("the push fails after the throttle is claimed", counted(1, ago(30)), fail_push: true)
cases << run("the push fails with no purchase ever", fail_push: true)
cases << run("the push fails while the throttle is already held", counted(1, ago(30)), throttle: { value: "7", ttl: 5000 }, fail_push: true)

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
