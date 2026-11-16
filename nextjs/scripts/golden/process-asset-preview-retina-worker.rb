# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/process-asset-preview-retina-worker.golden.json: ProcessAssetPreviewRetinaWorker run by
# the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). AssetPreview#generate_retina_variant! (ImageMagick
# and S3) is replaced by a recorder, so nothing leaves the machine; the golden keeps the preview ids it was asked to process under
# `processed`. Run it like publish-scheduled-post.rb (env in its header).
require_relative "support/rails_cases"
include RailsCases
capture_http!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/process-asset-preview-retina-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[asset_previews].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

$processed = []
AssetPreview.prepend(Module.new do
  define_method(:generate_retina_variant!) { $processed << id; nil }
end)

def preview_row(id, **overrides) = { id:, link_id: 7, guid: "guid#{id}", position: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def run(name, args, rows)
  $processed = []
  result = capture(name, now: NOW, tables: TABLES, seed: { asset_previews: rows }, sidekiq: true, job: "ProcessAssetPreviewRetinaWorker", args:) do
    ProcessAssetPreviewRetinaWorker.new.perform(*args)
  end
  result.delete("seed")
  result.delete("rows")
  result.merge("processed" => $processed.dup)
end

cases = []
cases << run("a preview that does not exist", [99], [])
cases << run("a preview id of nil", [nil], [preview_row(1)])
cases << run("a live preview", [1], [preview_row(1)])
cases << run("a deleted preview", [1], [preview_row(1, deleted_at: SEEDED_AT)])
cases << run("another preview is live", [2], [preview_row(1), preview_row(2, deleted_at: SEEDED_AT)])
cases << run("a preview id given as a digit string", ["1"], [preview_row(1)])
cases << run("a preview id given as a float", [1.0], [preview_row(1)])
cases << run("a preview id given as a word", ["abc"], [preview_row(1)])
cases << run("a preview of no product", [1], [preview_row(1, link_id: nil)])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
