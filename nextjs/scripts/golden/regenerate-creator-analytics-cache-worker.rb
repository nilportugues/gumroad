# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/regenerate-creator-analytics-cache-worker.golden.json: RegenerateCreatorAnalyticsCacheWorker
# run by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). CreatorAnalytics::CachingProxy#overwrite_cache
# (the analytics queries and the cache table writes) and WithMaxExecutionTime are replaced by recorders; the golden keeps the types it was asked
# to overwrite under `processed`. Run it like publish-scheduled-post.rb (env in its header).
require_relative "support/rails_cases"
include RailsCases
capture_http!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/regenerate-creator-analytics-cache-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

$processed = []
CreatorAnalytics::CachingProxy.prepend(Module.new do
  define_method(:overwrite_cache) { |date, by:| $processed << [date.to_s, by.to_s]; nil }
end)
WithMaxExecutionTime.singleton_class.prepend(Module.new do
  define_method(:timeout_queries) { |seconds:, &block| block.call }
end)

def user_row(id, **overrides)
  { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, flags: 0, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, args, rows)
  $processed = []
  result = capture(name, now: NOW, tables: TABLES, seed: { users: rows }, sidekiq: true, job: "RegenerateCreatorAnalyticsCacheWorker", args:) do
    RegenerateCreatorAnalyticsCacheWorker.new.perform(*args)
  end
  result.delete("seed")
  result.delete("rows")
  result.merge("processed" => $processed.dup)
end

cases = []
cases << run("a seller that does not exist", [99, "2026-11-01"], [])
cases << run("a seller id of nil", [nil, "2026-11-01"], [user_row(1)])
cases << run("a seller and a date", [1, "2026-11-01"], [user_row(1)])
cases << run("a deleted seller", [1, "2026-11-01"], [user_row(1, deleted_at: SEEDED_AT)])
cases << run("a seller and a date that is not a date", [1, "never"], [user_row(1)])
cases << run("a seller and a date of nil", [1, nil], [user_row(1)])
cases << run("a seller that does not exist and a date that is not a date", [99, "never"], [])
cases << run("a seller id given as a digit string", ["1", "2026-11-01"], [user_row(1)])
cases << run("a seller id given as a float", [1.0, "2026-11-01"], [user_row(1)])
cases << run("a seller id given as a word", ["abc", "2026-11-01"], [user_row(1)])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
