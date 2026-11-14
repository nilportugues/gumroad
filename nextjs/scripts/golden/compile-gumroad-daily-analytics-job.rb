# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/compile-gumroad-daily-analytics-job.golden.json: CompileGumroadDailyAnalyticsJob run by the
# real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). The job imports 46 days (today and the 45 before it),
# each with four aggregates and an insert or update, so every case records a few hundred statements. Run it like
# delete-product-files-worker.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/compile-gumroad-daily-analytics-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[gumroad_daily_analytics purchases service_charges users].freeze
RECOMMENDED = Purchase.flag_mapping["flags"][:was_product_recommended]
# The first and last day the job imports: Date.today minus 45 days, and today
FIRST_DAY = "2026-09-20"
LAST_DAY = "2026-11-04"

Rails.logger = ActiveSupport::Logger.new(nil)

def user_row(id, **overrides) = { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, confirmed_at: SEEDED_AT, user_risk_state: "not_reviewed", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def purchase_row(id, at, seller: 1, **overrides)
  { id:, link_id: 1, seller_id: seller, purchase_state: "successful", price_cents: 1000, fee_cents: 100, flags: 0, created_at: at, updated_at: at }.merge(overrides)
end

def charge_row(id, at, **overrides) = { id:, user_id: 1, charge_cents: 500, state: "successful", charge_processor_refunded: 0, created_at: at, updated_at: at }.merge(overrides)

def analytic_row(id, day, **overrides)
  { id:, period_ended_at: "#{day} 23:59:59.999999", gumroad_price_cents: 0, gumroad_fee_cents: 0, creators_with_sales: 0, gumroad_discover_price_cents: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, seed = {})
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "CompileGumroadDailyAnalyticsJob", args:  []) do
    CompileGumroadDailyAnalyticsJob.new.perform
  end
  result.delete("seed")
  result
end

cases = []
cases << run("no sales at all")
cases << run("a sale on the last day", { users: [user_row(1)], purchases: [purchase_row(1, "2026-11-04 08:00:00")] })
cases << run("a sale on the first day", { users: [user_row(1)], purchases: [purchase_row(1, "#{FIRST_DAY} 00:00:00")] })
cases << run("a sale the day before the first day", { users: [user_row(1)], purchases: [purchase_row(1, "2026-09-19 23:59:59.999999")] })
cases << run("a sale after the clock", { users: [user_row(1)], purchases: [purchase_row(1, "2026-11-05 00:00:00")] })
cases << run("sales on the edges of a day", { users: [user_row(1)], purchases: [purchase_row(1, "2026-10-10 00:00:00"), purchase_row(2, "2026-10-10 23:59:59.999999", price_cents: 250, fee_cents: 25), purchase_row(3, "2026-10-11 00:00:00", price_cents: 700, fee_cents: 70)] })
cases << run("a sale of exactly one dollar", { users: [user_row(1)], purchases: [purchase_row(1, "2026-10-10 12:00:00", price_cents: 100, fee_cents: 10)] })
cases << run("a sale below one dollar", { users: [user_row(1)], purchases: [purchase_row(1, "2026-10-10 12:00:00", price_cents: 99, fee_cents: 9)] })
cases << run("a free sale", { users: [user_row(1)], purchases: [purchase_row(1, "2026-10-10 12:00:00", price_cents: 0, fee_cents: 0)] })
cases << run("a refunded sale", { users: [user_row(1)], purchases: [purchase_row(1, "2026-10-10 12:00:00", stripe_refunded: true)] })
cases << run("a sale whose refund flag is false", { users: [user_row(1)], purchases: [purchase_row(1, "2026-10-10 12:00:00", stripe_refunded: false)] })
cases << run("a failed sale", { users: [user_row(1)], purchases: [purchase_row(1, "2026-10-10 12:00:00", purchase_state: "failed")] })
cases << run("a sale of a recommended product", { users: [user_row(1)], purchases: [purchase_row(1, "2026-10-10 12:00:00", flags: RECOMMENDED), purchase_row(2, "2026-10-10 13:00:00")] })
cases << run("two sellers on one day", { users: [user_row(1), user_row(2)], purchases: [purchase_row(1, "2026-10-10 12:00:00"), purchase_row(2, "2026-10-10 13:00:00", seller: 2), purchase_row(3, "2026-10-10 14:00:00", seller: 2)] })
cases << run("a seller suspended for fraud", { users: [user_row(1, user_risk_state: "suspended_for_fraud")], purchases: [purchase_row(1, "2026-10-10 12:00:00")] })
cases << run("a seller suspended for a terms violation", { users: [user_row(1, user_risk_state: "suspended_for_tos_violation")], purchases: [purchase_row(1, "2026-10-10 12:00:00")] })
cases << run("a seller flagged for review", { users: [user_row(1, user_risk_state: "flagged_for_fraud")], purchases: [purchase_row(1, "2026-10-10 12:00:00")] })
cases << run("a sale of a seller that does not exist", { purchases: [purchase_row(1, "2026-10-10 12:00:00")] })
cases << run("a service charge", { users: [user_row(1)], service_charges: [charge_row(1, "2026-10-10 12:00:00")] })
cases << run("service charges that do not count", { users: [user_row(1)], service_charges: [charge_row(1, "2026-10-10 12:00:00", state: "failed"), charge_row(2, "2026-10-10 12:00:00", charge_processor_refunded: 1)] })
cases << run("a service charge and a sale on one day", { users: [user_row(1)], purchases: [purchase_row(1, "2026-10-10 12:00:00")], service_charges: [charge_row(1, "2026-10-10 13:00:00")] })
cases << run("a day that already has an analytic with the same numbers", { users: [user_row(1)], purchases: [purchase_row(1, "2026-10-10 12:00:00")], gumroad_daily_analytics: [analytic_row(1, "2026-10-10", gumroad_price_cents: 1000, gumroad_fee_cents: 100, creators_with_sales: 1)] })
cases << run("a day that already has an analytic with other numbers", { users: [user_row(1)], purchases: [purchase_row(1, "2026-10-10 12:00:00")], gumroad_daily_analytics: [analytic_row(1, "2026-10-10", gumroad_price_cents: 5, gumroad_fee_cents: 5, creators_with_sales: 5, gumroad_discover_price_cents: 5)] })
cases << run("an analytic from the day before the first day", { gumroad_daily_analytics: [analytic_row(1, "2026-09-19", gumroad_price_cents: 5)] })
cases << run("two analytics for one day", { users: [user_row(1)], purchases: [purchase_row(1, "2026-10-10 12:00:00")], gumroad_daily_analytics: [analytic_row(1, "2026-10-10"), analytic_row(2, "2026-10-10", gumroad_price_cents: 7)] })
cases << run("an analytic ending at another time of day", { gumroad_daily_analytics: [analytic_row(1, "2026-10-10", period_ended_at: "2026-10-10 23:59:59")] })
cases << run("a large sale", { users: [user_row(1)], purchases: [purchase_row(1, "2026-10-10 12:00:00", price_cents: 1_000_000_000, fee_cents: 100_000_000)] })
cases << run("sales that sum past an integer column", { users: [user_row(1)], purchases: [purchase_row(1, "2026-10-10 12:00:00", price_cents: 2_000_000_000), purchase_row(2, "2026-10-10 13:00:00", price_cents: 2_000_000_000)] })

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
