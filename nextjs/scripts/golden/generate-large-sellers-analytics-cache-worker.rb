# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/generate-large-sellers-analytics-cache-worker.golden.json:
# GenerateLargeSellersAnalyticsCacheWorker run by the real app against a scratch database as a Sidekiq job
# (support/sidekiq_executor.rb). With no large seller it finishes after the scan; a large seller means CreatorAnalytics::CachingProxy,
# which Node hands back to Rails; those cases are recorded up to it, which a marker exception stands in for.
# Run it like pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/generate-large-sellers-analytics-cache-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users large_sellers].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

CreatorAnalytics::CachingProxy.prepend(Module.new do
  def generate_cache = raise(HandBackMarker)
end)

def user_row(id) = { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, user_risk_state: "compliant", flags: 0, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }

def large_seller_row(id, user_id) = { id:, user_id:, sales_count: 1000, created_at: SEEDED_AT, updated_at: SEEDED_AT }

def run(name, seed)
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "GenerateLargeSellersAnalyticsCacheWorker", args: []) do
    GenerateLargeSellersAnalyticsCacheWorker.new.perform
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("no users", {})
cases << run("users and no large seller", { users: [user_row(1), user_row(2)] })
cases << run("a large seller row whose user is gone", { large_sellers: [large_seller_row(1, 7)] })
cases << run("a large seller", { users: [user_row(1)], large_sellers: [large_seller_row(1, 1)] })
cases << run("a large seller among other users", { users: [user_row(1), user_row(2), user_row(3)], large_sellers: [large_seller_row(1, 2)] })
cases << run("several large sellers", { users: [user_row(1), user_row(2)], large_sellers: [large_seller_row(1, 1), large_seller_row(2, 2)] })

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
