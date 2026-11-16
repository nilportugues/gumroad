# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/alert-on-blocked-established-subscribers-job.golden.json: AlertOnBlockedEstablishedSubscribersJob
# run by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). A run where a subscription clears the
# successful-charge floor goes on to read the latest failures and the declining platform blocks, which Node does not; it hands the run
# back there. Run it like alert-on-blocked-established-buyers-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/alert-on-blocked-established-subscribers-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
TABLES = %w[purchases platform_blocks subscriptions].freeze
ORIGINAL = Purchase.flag_mapping["flags"][:is_original_subscription_purchase]
GIFT_RECEIVER = Purchase.flag_mapping["flags"][:is_gift_receiver_purchase]

Rails.logger = ActiveSupport::Logger.new(nil)

def ago(duration) = (NOW - duration).utc.strftime("%Y-%m-%d %H:%M:%S")

def purchase_row(id, subscription_id, **overrides)
  { id:, link_id: 1, seller_id: 1, email: "a@example.com", subscription_id:, purchase_state: "successful", price_cents: 500, flags: 0, created_at: ago(90.days), updated_at: ago(90.days) }.merge(overrides)
end

def blocked(id, subscription_id, code = "blocked_browser_guid", **overrides) = purchase_row(id, subscription_id, purchase_state: "failed", error_code: code, created_at: ago(2.days), **overrides)

def history(first_id, subscription_id, count = 6, **overrides) = Array.new(count) { |i| purchase_row(first_id + i, subscription_id, **overrides) }

def run(name, purchases = [])
  result = capture(name, now: NOW, tables: TABLES, seed: { purchases: }, sidekiq: true, job: "AlertOnBlockedEstablishedSubscribersJob", args: []) do
    AlertOnBlockedEstablishedSubscribersJob.new.perform
  end
  result.delete("seed")
  result.delete("rows")
  result
end

cases = []
cases << run("no purchases")
cases << run("a blocked failure and no history", [blocked(1, 7)])
cases << run("a blocked failure and five successful charges", [blocked(1, 7), *history(10, 7, 5)])
cases << run("a blocked failure and six successful charges", [blocked(1, 7), *history(10, 7)])
cases << run("a blocked failure for each blocking code", [blocked(1, 7, "blocked_browser_guid"), blocked(2, 8, "blocked_email_domain"), blocked(3, 9, "blocked_ip_address")])
cases << run("a failure with another error code", [blocked(1, 7, "card_declined"), *history(10, 7)])
cases << run("a blocked failure 31 days old", [blocked(1, 7, created_at: ago(31.days)), *history(10, 7)])
cases << run("a blocked failure 29 days old", [blocked(1, 7, created_at: ago(29.days)), *history(10, 7)])
cases << run("a blocked failure with no subscription", [blocked(1, nil), *history(10, 7)])
cases << run("a blocked failure on the original purchase", [blocked(1, 7, flags: ORIGINAL), *history(10, 7)])
cases << run("a blocked failure on a gift receiver purchase", [blocked(1, 7, flags: GIFT_RECEIVER), *history(10, 7)])
cases << run("charges of another subscription", [blocked(1, 7), *history(10, 8)])
cases << run("failed charges only", [blocked(1, 7), *history(10, 7, 6, purchase_state: "failed")])
cases << run("the same subscription failing twice", [blocked(1, 7), blocked(2, 7, "blocked_email_domain"), *history(10, 7)])
cases << run("two subscriptions, one with history", [blocked(1, 7), blocked(2, 8), *history(10, 8)])
# 501 candidates are read in two slices of 500 and 1; only the newest has a history.
many = (1..501).map { |i| blocked(i, 1000 + i, created_at: (NOW - i.minutes).utc.strftime("%Y-%m-%d %H:%M:%S")) }
cases << run("501 candidates and no history", many)
cases << run("501 candidates and a history in the second slice", [*many, *history(2000, 1501)])
cases << run("501 candidates and a history in the first slice", [*many, *history(2000, 1001)])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
