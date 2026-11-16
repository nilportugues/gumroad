# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/generate-product-files-archives-job.golden.json: GenerateProductFilesArchivesJob run by
# the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). A live product reaches `with_lock` and the
# archive rebuild, which Node hands back to Rails; those cases are recorded up to the rebuild, which a marker exception stands in for.
# Run it like pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/generate-product-files-archives-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[links].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

Link.prepend(Module.new do
  def generate_product_files_archives! = raise(HandBackMarker)
end)

def link_row(id, **overrides) = { id:, name: "Product #{id}", user_id: 1, unique_permalink: "p#{id}", price_currency_type: "usd", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def run(name, args, seed)
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "GenerateProductFilesArchivesJob", args:) do
    GenerateProductFilesArchivesJob.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

def seed(*links) = { links: }

cases = []
cases << run("a product that does not exist", [9], seed)
cases << run("a product that does not exist among others", [9], seed(link_row(1), link_row(2)))
cases << run("a deleted product", [1], seed(link_row(1, deleted_at: SEEDED_AT)))
cases << run("a deleted product among live ones", [2], seed(link_row(1), link_row(2, deleted_at: SEEDED_AT), link_row(3)))
cases << run("a live product", [1], seed(link_row(1)))
cases << run("a live product among others", [2], seed(link_row(1), link_row(2), link_row(3, deleted_at: SEEDED_AT)))
cases << run("a product id as a digit string", ["1"], seed(link_row(1, deleted_at: SEEDED_AT)))
cases << run("a live product id as a digit string", ["1"], seed(link_row(1)))
cases << run("a product id of nil", [nil], seed(link_row(1)))
cases << run("a product id as a float", [1.0], seed(link_row(1)))
cases << run("a product id as a word", ["one"], seed(link_row(1)))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
