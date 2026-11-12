# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/charge-preorder-worker.golden.json: ChargePreorderWorker run by the real app against a
# scratch database as a Sidekiq job (support/sidekiq_executor.rb). A preorder that exists reaches Preorder#charge! (a card charge), which
# Node hands back to Rails; those cases are recorded up to it, which a marker exception stands in for. A missing one raises Ruby's
# NoMethodError on nil. Run it like pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/charge-preorder-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[preorders].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

Preorder.prepend(Module.new do
  def charge!(*, **) = raise(HandBackMarker)
end)

def preorder_row(id, **overrides) = { id:, preorder_link_id: 1, seller_id: 1, purchaser_id: 2, state: "authorization_successful", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def run(name, args, *preorders)
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { preorders: }, sidekiq: true, job: "ChargePreorderWorker", args:) do
    ChargePreorderWorker.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("a preorder that does not exist", [9])
cases << run("a preorder that does not exist among others", [9], preorder_row(1), preorder_row(2))
cases << run("a preorder", [1], preorder_row(1))
cases << run("a preorder among others", [2], preorder_row(1), preorder_row(2), preorder_row(3))
%w[authorization_successful charge_successful cancelled authorization_failed].each do |state|
  cases << run("a #{state} preorder", [1], preorder_row(1, state:))
end
cases << run("a preorder on a later attempt", [1, 3], preorder_row(1))
cases << run("a missing preorder on a later attempt", [9, 3], preorder_row(1))
cases << run("a preorder id as a digit string", ["1"], preorder_row(1))
cases << run("a preorder id of nil", [nil], preorder_row(1))
cases << run("a preorder id as a float", [1.0], preorder_row(1))
cases << run("a preorder id as a word", ["one"], preorder_row(1))
cases << run("no arguments", [], preorder_row(1))
cases << run("one argument too many", [1, 1, 1], preorder_row(1))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
