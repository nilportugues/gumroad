# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/recover-stranded-buyers-job.golden.json: RecoverStrandedBuyersJob run by the real app
# against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). The recovery service (Risk::StrandedBuyerRecoveryService)
# is replaced by a stub that raises (the job reports it as that buyer's ERROR), so a run that reaches it records the whole scan without
# a write; Node stops earlier, once a buyer survives the settled-history and dispute filters, and hands the run back. Run it like alert-on-stuck-piracy-reports-job.rb
# (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/recover-stranded-buyers-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[purchases].freeze
CHARGEBACK_REVERSED = Purchase.flag_mapping["flags"][:chargeback_reversed]

Rails.logger = ActiveSupport::Logger.new(nil)

Risk::StrandedBuyerRecoveryService.singleton_class.prepend(Module.new do
  def call(**) = raise("recovery stubbed")
end)

def ago(duration) = (NOW - duration).utc.strftime("%Y-%m-%d %H:%M:%S")

def purchase_row(id, email, **overrides)
  { id:, link_id: 1, seller_id: 1, email:, purchase_state: "successful", price_cents: 500, flags: 0, created_at: ago(90.days), updated_at: ago(90.days) }.merge(overrides)
end

def blocked(id, email, code = "blocked_browser_guid", **overrides) = purchase_row(id, email, purchase_state: "failed", error_code: code, created_at: ago(2.days), **overrides)

# Three settled purchases make a clean history.
def history(first_id, email, count = 3, **overrides) = Array.new(count) { |i| purchase_row(first_id + i, email, **overrides) }

def run(name, purchases = [])
  result = capture(name, now: NOW, tables: TABLES, seed: { purchases: }, sidekiq: true, job: "RecoverStrandedBuyersJob", args: []) do
    RecoverStrandedBuyersJob.new.perform
  end
  result.delete("seed")
  result.delete("rows")
  result
end

cases = []
cases << run("no purchases")
cases << run("a blocked failure and no history", [blocked(1, "a@example.com")])
cases << run("a blocked failure and two settled purchases", [blocked(1, "a@example.com"), *history(10, "a@example.com", 2)])
cases << run("a blocked failure and three settled purchases", [blocked(1, "a@example.com"), *history(10, "a@example.com")])
cases << run("a blocked failure for each blocking code", [blocked(1, "a@example.com", "blocked_browser_guid"), blocked(2, "b@example.com", "blocked_email_domain"), blocked(3, "c@example.com", "blocked_ip_address")])
cases << run("a failure with another error code", [blocked(1, "a@example.com", "card_declined"), *history(10, "a@example.com")])
cases << run("a blocked failure 31 days old", [blocked(1, "a@example.com", created_at: ago(31.days)), *history(10, "a@example.com")])
cases << run("a blocked failure 29 days old", [blocked(1, "a@example.com", created_at: ago(29.days)), *history(10, "a@example.com")])
cases << run("a failure with no email", [blocked(1, nil), *history(10, "a@example.com")])
cases << run("history that is too recent", [blocked(1, "a@example.com"), *history(10, "a@example.com", 3, created_at: ago(59.days))])
cases << run("history just old enough", [blocked(1, "a@example.com"), *history(10, "a@example.com", 3, created_at: ago(60.days + 1.second))])
cases << run("history of free purchases", [blocked(1, "a@example.com"), *history(10, "a@example.com", 3, price_cents: 0)])
cases << run("history of refunded purchases", [blocked(1, "a@example.com"), *history(10, "a@example.com", 3, stripe_refunded: true)])
cases << run("history of chargedback purchases", [blocked(1, "a@example.com"), *history(10, "a@example.com", 3, chargeback_date: ago(80.days))])
cases << run("history of chargedback and reversed purchases", [blocked(1, "a@example.com"), *history(10, "a@example.com", 3, chargeback_date: ago(80.days), flags: CHARGEBACK_REVERSED)])
cases << run("history of failed purchases", [blocked(1, "a@example.com"), *history(10, "a@example.com", 3, purchase_state: "failed")])
cases << run("history under another casing", [blocked(1, "A@Example.com"), *history(10, "a@example.com")])
cases << run("a disputed purchase of the buyer", [blocked(1, "a@example.com"), *history(10, "a@example.com"), purchase_row(20, "a@example.com", chargeback_date: ago(10.days))])
cases << run("a disputed purchase that was reversed", [blocked(1, "a@example.com"), *history(10, "a@example.com"), purchase_row(20, "a@example.com", chargeback_date: ago(10.days), flags: CHARGEBACK_REVERSED)])
cases << run("a disputed purchase under another casing", [blocked(1, "a@example.com"), *history(10, "a@example.com"), purchase_row(20, "A@EXAMPLE.com", chargeback_date: ago(10.days))])
cases << run("a disputed PayPal purchase", [blocked(1, "a@example.com"), *history(10, "a@example.com"), purchase_row(20, "a@example.com", chargeback_date: ago(10.days), charge_processor_id: "paypal")])
cases << run("a disputed Stripe purchase", [blocked(1, "a@example.com"), *history(10, "a@example.com"), purchase_row(20, "a@example.com", chargeback_date: ago(10.days), charge_processor_id: "stripe")])
cases << run("one buyer disputed and another not", [blocked(1, "a@example.com"), blocked(2, "b@example.com"), *history(10, "a@example.com"), *history(20, "b@example.com"), purchase_row(30, "a@example.com", chargeback_date: ago(10.days))])
cases << run("two buyers, one with history", [blocked(1, "a@example.com"), blocked(2, "b@example.com"), *history(10, "b@example.com")])
cases << run("the same buyer failing twice", [blocked(1, "a@example.com"), blocked(2, "a@example.com", "blocked_ip_address"), *history(10, "a@example.com")])
# 501 candidates are read in two slices of 500 and 1; only the newest has a history.
many = (1..501).map { |i| blocked(i, "buyer#{i}@example.com", created_at: (NOW - i.minutes).utc.strftime("%Y-%m-%d %H:%M:%S")) }
cases << run("501 candidates and no history", many)
cases << run("501 candidates and a history in the second slice", [*many, *history(2000, "buyer501@example.com")])
cases << run("501 candidates and a history in the first slice", [*many, *history(2000, "buyer1@example.com")])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
