# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/exports-sales-compile-chunks-worker.golden.json: Exports::Sales::CompileChunksWorker run
# by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). `SalesExport.find` is the only read before
# the chunks are compiled into a CSV, mailed and deleted; an export that is found is recorded up to the compile, which a marker
# exception stands in for and Node hands back. Run it like pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/exports-sales-compile-chunks-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users sales_exports sales_export_chunks].freeze
QUERY = "---\n:seller: 1\n"
IDS = "---\n- 1\n- 2\n"
DATA = "---\n- - Name\n  - Ada\n"

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

Exports::Sales::CompileChunksWorker.prepend(Module.new do
  private

  def generate_compiled_tempfile = raise(HandBackMarker)
end)

def user_row(id) = { id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, user_risk_state: "compliant", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }
def export_row(id, recipient_id: 1) = { id:, recipient_id:, query: QUERY, created_at: SEEDED_AT, updated_at: SEEDED_AT }
def chunk_row(id, export_id, **overrides) = { id:, export_id:, purchase_ids: IDS, custom_fields: "--- []\n", purchases_data: DATA, processed: true, revision: "1", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def run(name, args, exports, chunks = [])
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { users: [user_row(1), user_row(2)], sales_exports: exports, sales_export_chunks: chunks }, sidekiq: true, job: "Exports::Sales::CompileChunksWorker", args:) do
    Exports::Sales::CompileChunksWorker.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("an export with no chunks", [1], [export_row(1)])
cases << run("an export with processed chunks", [1], [export_row(1)], [chunk_row(1, 1), chunk_row(2, 1)])
cases << run("an export among others", [2], [export_row(1), export_row(2, recipient_id: 2), export_row(3)], [chunk_row(1, 1), chunk_row(2, 2)])
cases << run("an export with a chunk not processed", [1], [export_row(1)], [chunk_row(1, 1, processed: false, revision: nil)])
cases << run("an export that does not exist", [9], [export_row(1)])
cases << run("an export id of zero", [0], [export_row(1)])
cases << run("the export id as a digit string", ["2"], [export_row(1), export_row(2)])
cases << run("an export id of nil", [nil], [export_row(1)])
cases << run("an export id as a float", [1.0], [export_row(1)])
cases << run("an export id as a word", ["one"], [export_row(1)])
cases << run("no arguments", [], [export_row(1)])
cases << run("two arguments", [1, 2], [export_row(1)])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
