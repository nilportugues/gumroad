# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/exports-sales-create-and-enqueue-chunks-worker.golden.json:
# Exports::Sales::CreateAndEnqueueChunksWorker run by the real app against a scratch database as a Sidekiq job
# (support/sidekiq_executor.rb). Everything after the export is found is the stale-chunk delete, the Elasticsearch scroll and the
# chunk inserts, which Node hands back whole; those cases are recorded up to the first Elasticsearch call, which a marker exception
# stands in for, so nothing leaves the machine. Run it like send-workflow-email-to-opened-non-clicker-job.rb (USE_DB_WORKER_REPLICAS=true).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/exports-sales-create-and-enqueue-chunks-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[sales_exports sales_export_chunks].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

EsClient.singleton_class.prepend(Module.new do
  def search(*, **) = raise(HandBackMarker)
end)

def export_row(id, **overrides) = { id:, recipient_id: 5, query: { bool: { filter: [{ term: { seller_id: 1 } }] } }.to_yaml, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def chunk_row(id, export_id: 1, **overrides) = { id:, export_id:, purchase_ids: [id].to_yaml, processed: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def run(name, args = [1], exports: [export_row(1)], chunks: [])
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { sales_exports: exports, sales_export_chunks: chunks }, sidekiq: true, job: "Exports::Sales::CreateAndEnqueueChunksWorker", args:) do
    Exports::Sales::CreateAndEnqueueChunksWorker.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("an export with no chunks")
cases << run("an export with a stale chunk", chunks: [chunk_row(1)])
cases << run("an export with three stale chunks", chunks: [chunk_row(1), chunk_row(2), chunk_row(3)])
cases << run("an export whose chunks belong to another export", exports: [export_row(1), export_row(2)], chunks: [chunk_row(1, export_id: 2)])
cases << run("the second of two exports", [2], exports: [export_row(1), export_row(2)], chunks: [chunk_row(1, export_id: 1), chunk_row(2, export_id: 2)])
cases << run("an export that does not exist", [99], exports: [])
cases << run("an export of zero", [0])
cases << run("an export id given as a String", ["1"], chunks: [chunk_row(1)])
cases << run("an export id given as a String that does not exist", ["99"])
cases << run("an export id given as digits past the id range", ["99999999999999999999"])
cases << run("an export id that is nil", [nil])
cases << run("an export id that is not digits", ["abc"])
cases << run("an export id with digits and letters", ["1abc"])
cases << run("an export id given as a Float", [1.0])
cases << run("an export id given as an Array", [[1]])
cases << run("an export id given as a Hash", [{ "id" => 1 }])
cases << run("an export id that is negative", [-1])
cases << run("an export with a blank query", exports: [export_row(1, query: nil)])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
