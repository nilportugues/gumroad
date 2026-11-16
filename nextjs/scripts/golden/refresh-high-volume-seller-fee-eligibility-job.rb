# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/refresh-high-volume-seller-fee-eligibility-job.golden.json:
# RefreshHighVolumeSellerFeeEligibilityJob run by the real app against a scratch database as a Sidekiq job
# (support/sidekiq_executor.rb). Run it like delete-expired-oauth-device-authorizations-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases
capture_elasticsearch!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/refresh-high-volume-seller-fee-eligibility-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
THIS_MONTH = "2026-11-02 08:00:00"
MONTH_START = "2026-11-01 00:00:00"
LAST_MONTH = "2026-10-31 23:59:59"
THRESHOLD = User::HIGH_VOLUME_FEE_THRESHOLD_CENTS
TABLES = %w[purchases users].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

def user_row(id, **overrides)
  { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, user_risk_state: "compliant", flags: 0, json_data: nil,
    confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def flagged_user_row(id, month = "2026-10") = user_row(id, json_data: { high_volume_fee_month: month }.to_json)

def purchase_row(id, seller_id, price_cents, **overrides)
  { id:, link_id: 1, seller_id:, purchase_state: "successful", price_cents:, created_at: THIS_MONTH, updated_at: THIS_MONTH }.merge(overrides)
end

def run(name, purchases = [], users = [], args: [])
  capture(name, now: NOW, tables: TABLES, seed: { purchases:, users: }, sidekiq: true, job: "RefreshHighVolumeSellerFeeEligibilityJob", args:) do
    RefreshHighVolumeSellerFeeEligibilityJob.new.perform(*args)
  end
end

cases = []
cases << run("no purchases and no flagged sellers")
cases << run("a seller over the threshold", [purchase_row(1, 7, THRESHOLD + 1)])
cases << run("a seller exactly at the threshold", [purchase_row(1, 7, THRESHOLD)])
cases << run("a seller one cent under the threshold", [purchase_row(1, 7, THRESHOLD - 1)])
cases << run("sales that add up to the threshold", [purchase_row(1, 7, THRESHOLD - 500), purchase_row(2, 7, 300), purchase_row(3, 7, 200)])
cases << run("sales of last month do not count", [purchase_row(1, 7, THRESHOLD, created_at: LAST_MONTH), purchase_row(2, 7, 1)])
cases << run("a sale at the start of the month counts", [purchase_row(1, 7, THRESHOLD, created_at: MONTH_START)])
cases << run("purchases that are not paid sales", [purchase_row(1, 7, THRESHOLD, purchase_state: "failed"), purchase_row(2, 8, THRESHOLD, stripe_refunded: true),
                                                  purchase_row(3, 9, 0), purchase_row(4, 10, THRESHOLD, purchase_state: "in_progress")])
cases << run("a partially refunded sale still counts", [purchase_row(1, 7, THRESHOLD, stripe_refunded: false)])
cases << run("a flagged seller with no sales", [], [flagged_user_row(5)])
cases << run("a flagged seller that also qualifies", [purchase_row(1, 5, THRESHOLD)], [flagged_user_row(5)])
cases << run("a user whose json_data names another key", [], [user_row(5, json_data: { other_high_volume_fee_month_note: 1 }.to_json), user_row(6, json_data: { color: "red" }.to_json)])
cases << run("qualifying sellers come before flagged ones", [purchase_row(1, 30, THRESHOLD), purchase_row(2, 10, THRESHOLD + 5)], [flagged_user_row(20), flagged_user_row(10), flagged_user_row(3)])
cases << run("one seller below and one above", [purchase_row(1, 7, THRESHOLD), purchase_row(2, 8, 100)])
[nil, "", "  ", false, [], {}].each { |arg| cases << run("a blank argument #{arg.inspect} runs the nightly sweep", [purchase_row(1, 7, THRESHOLD)], args: [arg]) }
cases << run("a seller id refreshes that seller", [purchase_row(1, 7, THRESHOLD)], [user_row(7)], args: [7])
cases << run("a seller id that does not exist", [], [], args: [99])
cases << run("a seller id given as a digit string", [purchase_row(1, 7, THRESHOLD)], [user_row(7)], args: ["7"])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases.each { _1.delete("rows"); _1.delete("seed") } }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
