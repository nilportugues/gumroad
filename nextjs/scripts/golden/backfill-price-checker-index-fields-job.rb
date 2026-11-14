# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/backfill-price-checker-index-fields-job.golden.json: BackfillPriceCheckerIndexFieldsJob
# run by the real app as a Sidekiq job (support/sidekiq_executor.rb) against an Elasticsearch stand-in that answers each request
# with the next of the case's `es_bodies`. Run it like refresh-closed-tier-discover-prices-job.rb (env as in its header).
require_relative "support/rails_cases"
include RailsCases
capture_elasticsearch!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/backfill-price-checker-index-fields-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)

Rails.logger = ActiveSupport::Logger.new(nil)

def page(ids, scroll_id: "scroll-1") = { "_scroll_id" => scroll_id, "hits" => { "hits" => ids.map { { "_id" => _1 } } } }

def run(name, *bodies)
  result = capture(name, now: NOW, tables: [], sidekiq: true, job: "BackfillPriceCheckerIndexFieldsJob", args: [], es_bodies: bodies) do
    BackfillPriceCheckerIndexFieldsJob.new.perform
  end
  result.delete("rows")
  result.delete("seed")
  result
end

cases = []
cases << run("no products indexed", page([]))
cases << run("one page of products", page(%w[1 2 3]), page([]))
cases << run("three pages of products", page(%w[1 2]), page(%w[3 4], scroll_id: "scroll-2"), page(%w[5], scroll_id: "scroll-3"), page([], scroll_id: "scroll-4"))
cases << run("ids that are not plain integers", page(["12abc", "x", " 7", "-3", ""]), page([]))
cases << run("an answer without hits", { "_scroll_id" => "scroll-1" })
cases << run("an answer with null hits", { "_scroll_id" => "scroll-1", "hits" => { "hits" => nil } })
cases << run("an answer without a scroll id", { "hits" => { "hits" => [{ "_id" => "1" }] } }, { "hits" => { "hits" => [] } })
cases << run("a scroll id that needs escaping", page(%w[1], scroll_id: "a/b c+d"), page([], scroll_id: "a/b c+d"))
cases << run("the same product twice in a page", page(%w[4 4]), page([]))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
