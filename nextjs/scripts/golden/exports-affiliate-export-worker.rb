# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/exports-affiliate-export-worker.golden.json: Exports::AffiliateExportWorker run by the real
# app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). `User.find(seller_id, recipient_id)` is the only read
# before the export itself (a tempfile and a mail); users that are found reach the export service, which Node hands back, recorded up
# to there with a marker exception (`hands_back`). Rails drops nil and repeated ids before it reads, so a pair that collapses to one id is
# a plain find; two ids read `id IN (...)`. Run it like pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/exports-affiliate-export-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

Exports::AffiliateExportService.prepend(Module.new do
  def perform(*, **) = raise(HandBackMarker)
end)

def user_row(id, **overrides)
  { id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, confirmed_at: nil, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, args, *users)
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { users: }, sidekiq: true, job: "Exports::AffiliateExportWorker", args:) do
    Exports::AffiliateExportWorker.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("a seller and a recipient", [1, 2], user_row(1), user_row(2))
cases << run("a recipient with a lower id than the seller", [2, 1], user_row(1), user_row(2))
cases << run("a seller among others", [2, 3], user_row(1), user_row(2), user_row(3), user_row(4))
cases << run("a seller and no recipient", [1, nil], user_row(1), user_row(2))
cases << run("no seller and a recipient", [nil, 2], user_row(1), user_row(2))
cases << run("neither a seller nor a recipient", [nil, nil], user_row(1), user_row(2))
cases << run("the same user as seller and recipient", [1, 1], user_row(1), user_row(2))
cases << run("a seller that does not exist", [9, 2], user_row(1), user_row(2))
cases << run("a recipient that does not exist", [1, 9], user_row(1), user_row(2))
cases << run("neither user exists", [8, 9], user_row(1), user_row(2))
cases << run("a seller that does not exist and no recipient", [9, nil], user_row(1))
cases << run("a deleted recipient", [1, 2], user_row(1), user_row(2, deleted_at: SEEDED_AT))
cases << run("ids as digit strings", %w[1 2], user_row(1), user_row(2))
cases << run("one id as a digit string", [1, "2"], user_row(1), user_row(2))
cases << run("the same id as an integer and a digit string", [1, "1"], user_row(1), user_row(2))
cases << run("an id as a float", [1.0, 2], user_row(1), user_row(2))
cases << run("an id as a word", ["one", 2], user_row(1), user_row(2))
cases << run("no arguments", [], user_row(1))
cases << run("one argument", [1], user_row(1))
cases << run("three arguments", [1, 2, 3], user_row(1), user_row(2))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
