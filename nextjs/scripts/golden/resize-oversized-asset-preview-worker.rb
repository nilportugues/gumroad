# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/resize-oversized-asset-preview-worker.golden.json: ResizeOversizedAssetPreviewWorker run by the real app
# against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). A live asset preview reaches
# AssetPreview#resize_oversized_image! (Active Storage reads, a resize and attach), which Node hands back to Rails; those cases are recorded up to it,
# which a marker exception stands in for. Run it like pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/resize-oversized-asset-preview-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[asset_previews].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

AssetPreview.prepend(Module.new do
  def resize_oversized_image! = raise(HandBackMarker)
end)

def preview_row(id, **overrides) = { id:, link_id: 1, guid: "guid#{id}", position: id, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def run(name, args, *previews)
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { asset_previews: previews }, sidekiq: true, job: "ResizeOversizedAssetPreviewWorker", args:) do
    ResizeOversizedAssetPreviewWorker.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("an asset preview that does not exist", [9])
cases << run("an asset preview that does not exist among others", [9], preview_row(1), preview_row(2))
cases << run("a live asset preview", [1], preview_row(1))
cases << run("a live asset preview among others", [2], preview_row(1), preview_row(2), preview_row(3, deleted_at: SEEDED_AT))
cases << run("a deleted asset preview", [1], preview_row(1, deleted_at: SEEDED_AT))
cases << run("a deleted asset preview among live ones", [2], preview_row(1), preview_row(2, deleted_at: SEEDED_AT), preview_row(3))
cases << run("an asset preview id as a digit string", ["1"], preview_row(1, deleted_at: SEEDED_AT))
cases << run("a live asset preview id as a digit string", ["1"], preview_row(1))
cases << run("an asset preview id of nil", [nil], preview_row(1))
cases << run("an asset preview id as a float", [1.0], preview_row(1))
cases << run("an asset preview id as a word", ["one"], preview_row(1))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
