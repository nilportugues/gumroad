# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/duplicate-product-worker.golden.json: DuplicateProductWorker run by the real app against a
# scratch database as a Sidekiq job (support/sidekiq_executor.rb). Node reads the product and hands the job back, so each case is recorded
# up to the duplication (`ProductDuplicatorService#duplicate`) or the Sentry report of a missing product, where a marker exception stands
# in; the statements of the `ensure` after it are cut off. Run it like publish-scheduled-post.rb (env as there):
#
#   bundle exec rails runner nextjs/scripts/golden/duplicate-product-worker.rb
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/duplicate-product-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[links].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

$statements_at_marker = nil
mark = -> { $statements_at_marker = RailsRecorder.log&.size; raise HandBackMarker }
ProductDuplicatorService.prepend(Module.new { define_method(:duplicate) { mark.call } })
ErrorNotifier.singleton_class.prepend(Module.new { define_method(:notify) { |*, **| mark.call } })

def link_row(id, **overrides) = { id:, name: "Product #{id}", user_id: 1, unique_permalink: "p#{id}", price_currency_type: "usd", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def run(name, args, *links)
  hands_back = false
  $statements_at_marker = nil
  result = capture(name, now: NOW, tables: TABLES, seed: { links: }, sidekiq: true, job: "DuplicateProductWorker", args:) do
    DuplicateProductWorker.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result["statements"] = result["statements"].first($statements_at_marker) if $statements_at_marker
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back || !$statements_at_marker.nil?)
end

cases = []
cases << run("a product", [1], link_row(1))
cases << run("a product among others", [2], link_row(1), link_row(2))
cases << run("a deleted product", [1], link_row(1, deleted_at: SEEDED_AT))
cases << run("a product that is already being duplicated", [1], link_row(1, flags: 1 << 3))
cases << run("a product that does not exist", [9])
cases << run("a product id as a digit string", ["1"], link_row(1))
cases << run("a product id of nil", [nil], link_row(1))
cases << run("a product id as a float", [1.0], link_row(1))
cases << run("a product id as a word", ["one"], link_row(1))
cases << run("a product id of zero", [0], link_row(1))
cases << run("a negative product id", [-1], link_row(1))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
