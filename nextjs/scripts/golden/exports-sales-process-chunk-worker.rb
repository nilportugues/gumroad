# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/exports-sales-process-chunk-worker.golden.json: Exports::Sales::ProcessChunkWorker run by
# the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). `SalesExportChunk.find` and the load of its
# export are the only reads before the purchases are exported and the chunk is updated; a chunk that is found is recorded up to
# `Exports::PurchaseExportService.new`, which a marker exception stands in for and Node hands back. Run it like
# pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/exports-sales-process-chunk-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users sales_exports sales_export_chunks].freeze
QUERY = "---\n:seller: 1\n"
IDS = "---\n- 1\n- 2\n"

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

Exports::PurchaseExportService.singleton_class.prepend(Module.new do
  def new(*, **) = raise(HandBackMarker)
end)

def user_row(id) = { id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, user_risk_state: "compliant", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }
def export_row(id, recipient_id: 1) = { id:, recipient_id:, query: QUERY, created_at: SEEDED_AT, updated_at: SEEDED_AT }
def chunk_row(id, export_id, **overrides) = { id:, export_id:, purchase_ids: IDS, custom_fields: nil, purchases_data: nil, processed: false, revision: nil, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def run(name, args, exports, chunks)
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { users: [user_row(1), user_row(2)], sales_exports: exports, sales_export_chunks: chunks }, sidekiq: true, job: "Exports::Sales::ProcessChunkWorker", args:) do
    Exports::Sales::ProcessChunkWorker.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("a chunk not processed", [1], [export_row(1)], [chunk_row(1, 1)])
cases << run("a chunk processed with an old revision", [1], [export_row(1)], [chunk_row(1, 1, processed: true, revision: "0", custom_fields: "--- []\n", purchases_data: "--- []\n")])
cases << run("a chunk among others", [2], [export_row(1), export_row(2, recipient_id: 2)], [chunk_row(1, 1), chunk_row(2, 2), chunk_row(3, 2)])
cases << run("a chunk with no purchases", [1], [export_row(1)], [chunk_row(1, 1, purchase_ids: "--- []\n")])
cases << run("a chunk whose export is gone", [1], [export_row(1)], [chunk_row(1, 7)])
cases << run("a chunk that does not exist", [9], [export_row(1)], [chunk_row(1, 1)])
cases << run("a chunk id of zero", [0], [export_row(1)], [chunk_row(1, 1)])
cases << run("the chunk id as a digit string", ["2"], [export_row(1)], [chunk_row(1, 1), chunk_row(2, 1)])
cases << run("a chunk id of nil", [nil], [export_row(1)], [chunk_row(1, 1)])
cases << run("a chunk id as a float", [1.0], [export_row(1)], [chunk_row(1, 1)])
cases << run("a chunk id as a word", ["one"], [export_row(1)], [chunk_row(1, 1)])
cases << run("no arguments", [], [export_row(1)], [chunk_row(1, 1)])
cases << run("two arguments", [1, 2], [export_row(1)], [chunk_row(1, 1)])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
