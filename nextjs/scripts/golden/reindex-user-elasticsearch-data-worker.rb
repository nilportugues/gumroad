# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/reindex-user-elasticsearch-data-worker.golden.json: ReindexUserElasticsearchDataWorker run by
# the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). DevTools.reindex_all_for_user (a full Elasticsearch
# reindex of one seller) is replaced by a recorder that stops the job, so the golden keeps the statements up to it and the user id it was
# called with under `processed`; the admin note written after it is not recorded. Run it like publish-scheduled-post.rb (env in its header).
require_relative "support/rails_cases"
include RailsCases
capture_http!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/reindex-user-elasticsearch-data-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users comments].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

$processed = []
DevTools.singleton_class.prepend(Module.new do
  define_method(:reindex_all_for_user) { |user_id| $processed << user_id; throw :reindex_reached }
end)

def user_row(id, **overrides)
  { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, flags: 0, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, args, rows)
  $processed = []
  result = capture(name, now: NOW, tables: TABLES, seed: { users: rows }, sidekiq: true, job: "ReindexUserElasticsearchDataWorker", args:) do
    catch(:reindex_reached) { ReindexUserElasticsearchDataWorker.new.perform(*args) }
  end
  result.delete("seed")
  result.delete("rows")
  result.merge("processed" => $processed.dup)
end

cases = []
cases << run("a seller that does not exist", [99, 2], [user_row(2)])
cases << run("an admin that does not exist", [1, 99], [user_row(1)])
cases << run("neither exists", [99, 98], [])
cases << run("a seller and an admin", [1, 2], [user_row(1), user_row(2)])
cases << run("the seller is the admin", [1, 1], [user_row(1)])
cases << run("a deleted seller", [1, 2], [user_row(1, deleted_at: SEEDED_AT), user_row(2)])
cases << run("a seller id of nil", [nil, 2], [user_row(2)])
cases << run("an admin id of nil", [1, nil], [user_row(1)])
cases << run("a seller id given as a digit string", ["1", 2], [user_row(1), user_row(2)])
cases << run("a seller id given as a float", [1.0, 2], [user_row(1), user_row(2)])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
