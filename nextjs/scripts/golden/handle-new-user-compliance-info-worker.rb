# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/handle-new-user-compliance-info-worker.golden.json: HandleNewUserComplianceInfoWorker run
# by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). StripeMerchantAccountManager.handle_new_user_compliance_info
# (Stripe account creation and updates) is replaced by a recorder, so nothing leaves the machine; the golden keeps the compliance info ids it
# was called with under `processed`. Run it like publish-scheduled-post.rb (env in its header).
require_relative "support/rails_cases"
include RailsCases
capture_http!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/handle-new-user-compliance-info-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[user_compliance_info].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

$processed = []
StripeMerchantAccountManager.singleton_class.prepend(Module.new do
  define_method(:handle_new_user_compliance_info) { |info| $processed << info.id; nil }
end)

def info_row(id, **overrides) = { id:, user_id: 5, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def run(name, args, rows)
  $processed = []
  result = capture(name, now: NOW, tables: TABLES, seed: { user_compliance_info: rows }, sidekiq: true, job: "HandleNewUserComplianceInfoWorker", args:) do
    HandleNewUserComplianceInfoWorker.new.perform(*args)
  end
  result.delete("seed")
  result.delete("rows")
  result.merge("processed" => $processed.dup)
end

cases = []
cases << run("a compliance info that does not exist", [99], [])
cases << run("a compliance info id of nil", [nil], [info_row(1)])
cases << run("a live compliance info", [1], [info_row(1)])
cases << run("a deleted compliance info", [1], [info_row(1, deleted_at: SEEDED_AT)])
cases << run("another compliance info exists", [2], [info_row(1)])
cases << run("a compliance info id given as a digit string", ["1"], [info_row(1)])
cases << run("a compliance info id given as a float", [1.0], [info_row(1)])
cases << run("a compliance info id given as a word", ["abc"], [info_row(1)])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
