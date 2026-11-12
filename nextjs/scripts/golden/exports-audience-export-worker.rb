# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/exports-audience-export-worker.golden.json: Exports::AudienceExportWorker run by the real
# app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). `User.find(seller_id, recipient_id)` is the only read
# before the export itself (a tempfile and a mail); users that are found reach the export service, which Node hands back, recorded up
# to there with a marker exception (`hands_back`). Rails drops nil and repeated ids before it reads, so a pair that collapses to one id is
# a plain find; two ids read `id IN (...)`. Run it like pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/exports-audience-export-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

Exports::AudienceExportService.prepend(Module.new do
  def perform(*, **) = raise(HandBackMarker)
end)

def user_row(id, **overrides)
  { id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, confirmed_at: nil, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, args, *users, node_hands_back: false)
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { users: }, sidekiq: true, job: "Exports::AudienceExportWorker", args:) do
    Exports::AudienceExportWorker.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back).merge(node_hands_back ? { "node_hands_back" => true } : {})
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
cases << run("no audience options", [1, 2], user_row(1), user_row(2))
cases << run("an empty options hash", [1, 2, {}], user_row(1), user_row(2))
cases << run("followers selected", [1, 2, { "followers" => true }], user_row(1), user_row(2))
cases << run("customers selected", [1, 2, { "customers" => true }], user_row(1), user_row(2))
cases << run("affiliates selected", [1, 2, { "affiliates" => true }], user_row(1), user_row(2))
cases << run("every audience type selected", [1, 2, { "followers" => true, "customers" => true, "affiliates" => true }], user_row(1), user_row(2))
cases << run("audience types set to false and nil", [1, 2, { "followers" => false, "customers" => nil }], user_row(1), user_row(2))
cases << run("an audience type set to zero", [1, 2, { "followers" => 0 }], user_row(1), user_row(2))
cases << run("an audience type set to the string false", [1, 2, { "affiliates" => "false" }], user_row(1), user_row(2))
cases << run("an unrelated option only", [1, 2, { "colorize" => true }], user_row(1), user_row(2))
cases << run("options and no recipient", [1, nil, { "followers" => true }], user_row(1), user_row(2))
cases << run("options and a seller that does not exist", [9, nil, { "followers" => true }], user_row(1), user_row(2))
cases << run("nil options", [1, 2, nil], user_row(1), user_row(2), node_hands_back: true)
cases << run("string options", [1, 2, "followers"], user_row(1), user_row(2), node_hands_back: true)
cases << run("array options", [1, 2, []], user_row(1), user_row(2), node_hands_back: true)
cases << run("four arguments", [1, 2, {}, 1], user_row(1), user_row(2))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
