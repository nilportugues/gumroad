# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/moderate-products-job.golden.json: ModerateProductsJob run by the real app against a scratch
# database as a Sidekiq job (support/sidekiq_executor.rb). ContentModeration::ModerateRecordService.check (an LLM call and the moderation
# writes) is replaced by a recorder, so nothing leaves the machine; the golden keeps the product ids it was asked to check under `processed`.
# Run it like publish-scheduled-post.rb (env in its header).
require_relative "support/rails_cases"
include RailsCases
capture_http!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/moderate-products-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[links].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

$processed = []
ContentModeration::ModerateRecordService.singleton_class.prepend(Module.new do
  define_method(:check) { |record, kind| $processed << [record.id, kind.to_s]; nil }
end)

def product_row(id, **overrides) = { id:, user_id: 5, name: "Product #{id}", unique_permalink: "p#{id}", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def run(name, args, rows)
  $processed = []
  result = capture(name, now: NOW, tables: TABLES, seed: { links: rows }, sidekiq: true, job: "ModerateProductsJob", args:) do
    ModerateProductsJob.new.perform(*args)
  end
  result.delete("seed")
  result.delete("rows")
  result.merge("processed" => $processed.dup)
end

cases = []
cases << run("no product ids", [[]], [product_row(1)])
cases << run("a product id that does not exist", [[99]], [product_row(1)])
cases << run("a product that exists", [[1]], [product_row(1)])
cases << run("several products out of order", [[3, 1, 2]], [product_row(1), product_row(2), product_row(3)])
cases << run("an id repeated", [[1, 1]], [product_row(1)])
cases << run("some ids that do not exist", [[1, 99, 2]], [product_row(1), product_row(2)])
cases << run("a deleted product", [[1]], [product_row(1, deleted_at: SEEDED_AT)])
cases << run("a banned product", [[1]], [product_row(1, banned_at: SEEDED_AT)])
cases << run("a product id given as a digit string", [["1"]], [product_row(1)])
cases << run("a product id given as a word", [["abc"]], [product_row(1)])
cases << run("a product id of nil among others", [[nil, 1]], [product_row(1)])
cases << run("a single product id", [1], [product_row(1)])
cases << run("a product ids argument of nil", [nil], [product_row(1)])
cases << run("an id past 2**53", [[9_007_199_254_740_993]], [product_row(1)])
cases << run("a negative id", [[-1, 1]], [product_row(1)])
cases << run("a product id given as a float", [[1.0]], [product_row(1)])
cases << run("a thousand ids with one product", [(1..1000).to_a], [product_row(1)])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
