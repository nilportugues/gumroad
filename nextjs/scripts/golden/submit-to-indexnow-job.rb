# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/submit-to-indexnow-job.golden.json: SubmitToIndexnowJob run by the real app against
# a scratch database as a Sidekiq job (support/sidekiq_executor.rb), with every outbound request captured and answered by WebMock
# (capture_http!). Run it like update-taxonomy-stats-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases
capture_http!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/submit-to-indexnow-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[links users].freeze
KEY = "0123456789abcdef0123456789abcdef"

Rails.logger = ActiveSupport::Logger.new(nil)

def user_row(id, **overrides) = { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, user_risk_state: "compliant", flags: 0, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def link_row(id, user_id: 1, **overrides) = { id:, name: "Product #{id}", user_id:, unique_permalink: "p#{id}", price_currency_type: "usd", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def with_key(key)
  previous = ENV["INDEXNOW_KEY"]
  key.nil? ? ENV.delete("INDEXNOW_KEY") : ENV["INDEXNOW_KEY"] = key
  yield
ensure
  previous.nil? ? ENV.delete("INDEXNOW_KEY") : ENV["INDEXNOW_KEY"] = previous
end

def run(name, args, seed: { users: [user_row(1)], links: [link_row(1)] }, key: KEY, responses: [])
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "SubmitToIndexnowJob", args:, http_responses: responses) do
    with_key(key) { SubmitToIndexnowJob.new.perform(*args) }
  end
  result.delete("rows")
  result.delete("seed")
  result
end

TWO_SELLERS = { users: [user_row(1), user_row(2, username: "second_seller")], links: [link_row(1), link_row(2, user_id: 2), link_row(3, user_id: 1)] }.freeze

cases = []
cases << run("a product of a seller with a username", [[1]])
cases << run("a bare id instead of a list", [1])
cases << run("no key configured", [[1]], key: nil)
cases << run("a blank key", [[1]], key: "")
cases << run("no ids", [[]])
cases << run("no argument value", [nil])
cases << run("an id that matches no product", [[99]])
cases << run("a product with a custom permalink", [[1]], seed: { users: [user_row(1)], links: [link_row(1, custom_permalink: "my-book")] })
cases << run("a seller without a username", [[1]], seed: { users: [user_row(1, username: nil)], links: [link_row(1)] })
cases << run("a username with underscores", [[1]], seed: { users: [user_row(1, username: "snake_case_seller")], links: [link_row(1)] })
cases << run("two sellers are submitted per host", [[1, 2, 3]], seed: TWO_SELLERS)
cases << run("duplicate ids are submitted once", [[1, 1, 3]], seed: TWO_SELLERS)
cases << run("an unpublished and a deleted product are submitted too", [[1, 2]], seed: { users: [user_row(1)], links: [link_row(1, purchase_disabled_at: SEEDED_AT), link_row(2, deleted_at: SEEDED_AT)] })
cases << run("a 204 answer", [[1]], responses: [{ status: 204 }])
cases << run("a 202 answer", [[1]], responses: [{ status: 202, body: "" }])
cases << run("a 429 answer raises", [[1]], responses: [{ status: 429 }])
cases << run("a 500 answer raises", [[1]], responses: [{ status: 500, body: "boom" }])
cases << run("a 400 answer raises", [[1]], responses: [{ status: 400 }])
cases << run("the second host failing after the first succeeded", [[1, 2]], seed: TWO_SELLERS, responses: [{ status: 200 }, { status: 403 }])
cases << run("string ids", [%w[1 3]], seed: TWO_SELLERS)
cases << run("a link whose user is missing", [[1]], seed: { users: [], links: [link_row(1)] })

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "key" => KEY, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
