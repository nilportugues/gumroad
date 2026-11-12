# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/product-build-unpack-job.golden.json: ProductBuildUnpackJob run by the real app against a
# scratch database as a Sidekiq job (support/sidekiq_executor.rb). `ProductBuild.find_by(id:)` is the only read before the unpack
# (object storage); a missing build returns, a build reaches `ProductBuilds::UnpackSiteService.perform`, which Node hands back,
# recorded up to there with a marker exception (`hands_back`). Run it like pdf-unstampable-notifier-job.rb (env as in
# publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/product-build-unpack-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[product_builds].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

ProductBuilds::UnpackSiteService.singleton_class.prepend(Module.new do
  def perform(*, **) = raise(HandBackMarker)
end)

def build_row(id, **overrides)
  { id:, product_id: 1, public_id: "build#{id}", number: id, status: "uploaded", source_url: "https://example.com/#{id}.zip", storage_key: "builds/#{id}",
    byte_size: 10, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, args, *builds)
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { product_builds: builds }, sidekiq: true, job: "ProductBuildUnpackJob", args:) do
    ProductBuildUnpackJob.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("a build that does not exist", [9])
cases << run("a build that does not exist among others", [9], build_row(1), build_row(2))
cases << run("a build", [1], build_row(1))
cases << run("a build among others", [2], build_row(1), build_row(2), build_row(3))
%w[promoted failed].each { |status| cases << run("a #{status} build", [1], build_row(1, status:)) }
cases << run("a build id as a digit string", ["1"], build_row(1))
cases << run("a build id of nil", [nil], build_row(1))
cases << run("a build id as a float", [1.0], build_row(1))
cases << run("a build id as a word", ["one"], build_row(1))
cases << run("no arguments", [], build_row(1))
cases << run("one argument too many", [1, 1], build_row(1))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
