# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/reindex-seller-offer-codes-job.golden.json: ReindexSellerOfferCodesJob and
# ReindexSellerOfferCodesRecoveryJob (perform, and the sidekiq_retries_exhausted block of each) run by the real app as Sidekiq jobs
# (support/sidekiq_executor.rb). ProductOfferCodeIndexingService (the Elasticsearch writes) is replaced by a recorder, so a run that
# reaches it records the product ids under `indexed` and nothing leaves the machine. The Redis the case starts from is set in `setup`
# and comes back as `redis_before`. Run it like refresh-custom-domain-routability-worker.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/reindex-seller-offer-codes-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[links].freeze
SELLER = 7
KEY = "offer_code_index:#{SELLER}"

Rails.logger = ActiveSupport::Logger.new(nil)

$indexed = []
recorder = Class.new do
  def initialize(products) = @products = products
  def perform
    $indexed << @products.map(&:id)
    @products.each { yield if block_given? }
  end
end
ProductOfferCodeIndexingService.singleton_class.prepend(Module.new do
  define_method(:new) { |products| recorder.new(products) }
end)
abort "indexing service is not stubbed" unless ProductOfferCodeIndexingService.new([]).is_a?(recorder)

def link_row(id, **overrides) = { id:, name: "Product #{id}", user_id: SELLER, unique_permalink: "p#{id}", price_currency_type: "usd", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def run(name, state = {}, links: [], job: ReindexSellerOfferCodesJob, args: [SELLER], **inline_state)
  state = state.merge(inline_state)
  $indexed = []
  setup = lambda do
    state.fetch(:strings, {}).each { |key, value| redis.set("#{KEY}:#{key}", value) }
    state.fetch(:zset, {}).each { |id, score| redis.zadd("#{KEY}:products", score, id) }
    state.fetch(:hash, {}).each { |id, version| redis.hset("#{KEY}:product_versions", id, version) }
  end
  result = capture(name, now: NOW, tables: TABLES, seed: { links: }, setup:, sidekiq: true, job: job.name, args:) do
    job.new.perform(*args)
  end
  result.delete("seed")
  result.delete("rows")
  result.merge("indexed" => $indexed.dup)
end

def exhausted(name, job, args)
  result = capture(name, now: NOW, tables: [], sidekiq: true, job: job.name, args:, hook: true) do
    job.sidekiq_retries_exhausted_block.call({ "args" => args }, StandardError.new("boom"))
  end
  result.delete("seed")
  result.delete("rows")
  result.merge("indexed" => [])
end

FUTURE = (NOW.to_f + 3).to_s
PAST = (NOW.to_f - 3).to_s

cases = []
cases << run("nothing pending")
cases << run("a lock held by another run", strings: { lock: "other-token" })
cases << run("a lock held by another run with a cooldown", strings: { lock: "other-token", cooldown: FUTURE })
cases << run("a cooldown in the future", strings: { cooldown: FUTURE })
cases << run("a cooldown in the future with work pending", { strings: { cooldown: FUTURE, version: "1" }, zset: { "11" => 1 }, hash: { "11" => "1" } }, links: [link_row(11)])
cases << run("a cooldown in the past", strings: { cooldown: PAST })
cases << run("a cooldown exactly now", strings: { cooldown: NOW.to_f.to_s })
cases << run("a cooldown that is not a number", strings: { cooldown: "soon" })
cases << run("a cooldown given as an integer in the future", strings: { cooldown: (NOW.to_i + 60).to_s })
cases << run("a cooldown in exponent form", strings: { cooldown: "1e10" })
cases << run("a cooldown with trailing text", strings: { cooldown: "9999999999abc" })
cases << run("a cooldown that is negative", strings: { cooldown: "-5" })
cases << run("a cooldown that is empty", strings: { cooldown: "" })
cases << run("a seller id of nil", args: [nil])
cases << run("a seller id given as a string", args: ["7"], strings: { cooldown: FUTURE })
cases << run("a seller id given as a float", args: [7.0], strings: { cooldown: FUTURE })
cases << run("a catalogue pass pending", { strings: { version: "3" } }, links: [link_row(11), link_row(12)])
cases << run("a catalogue pass resumed from a cursor", { strings: { version: "3", cursor: "11", scan_version: "2" } }, links: [link_row(11), link_row(12)])
cases << run("targeted products pending", { zset: { "11" => 1, "12" => 2 }, hash: { "11" => "1", "12" => "2" } }, links: [link_row(11), link_row(12)])
cases << run("targeted products pending after a targeted batch", { strings: { version: "3", last_batch: "targeted" }, zset: { "11" => 1 }, hash: { "11" => "1" } }, links: [link_row(11)])
cases << run("targeted products pending after a catalogue batch", { strings: { version: "3", last_batch: "catalogue" }, zset: { "11" => 1 }, hash: { "11" => "1" } }, links: [link_row(11)])
cases << run("targeted products with no catalogue pass after a targeted batch", { strings: { last_batch: "targeted" }, zset: { "11" => 1 }, hash: { "11" => "1" } }, links: [link_row(11)])
cases << run("a recovery run with nothing pending", job: ReindexSellerOfferCodesRecoveryJob)
cases << run("a recovery run behind a lock", { strings: { lock: "other-token" } }, job: ReindexSellerOfferCodesRecoveryJob)
cases << run("a recovery run with a catalogue pass pending", { strings: { version: "3" } }, links: [link_row(11)], job: ReindexSellerOfferCodesRecoveryJob)
cases << exhausted("retries of the reindex job exhausted", ReindexSellerOfferCodesJob, [SELLER])
cases << exhausted("retries of the recovery job exhausted", ReindexSellerOfferCodesRecoveryJob, [SELLER])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
