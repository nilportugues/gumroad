# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/delete-product-files-worker.golden.json: DeleteProductFilesWorker run by the real app
# against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). The sales search goes to a local socket that answers
# the case's `es_bodies` (support/rails_cases.rb) and is recorded under `es`; a product with a file to delete runs the real
# ProductFile#delete! against it, so Node hands those cases back after the product's files are read. Run it like
# sync-watched-users-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases
capture_elasticsearch!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/delete-product-files-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[links product_files versions].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

def link_row(id, **overrides) = { id:, user_id: 1, name: "Product #{id}", unique_permalink: "p#{id}", deleted_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
def file_row(id, link: 1, **overrides) = { id:, link_id: link, url: "https://files.example.com/#{id}.pdf", filetype: "pdf", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
def sales(total, relation = "eq") = { "hits" => { "total" => { "value" => total, "relation" => relation }, "hits" => [] } }

def run(name, seed, args = [1], es_bodies: [])
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "DeleteProductFilesWorker", args:, es_bodies:) do
    DeleteProductFilesWorker.new.perform(*args)
  end
  result.delete("seed")
  result
end

cases = []
cases << run("a product that does not exist", {}, [99])
cases << run("a product id of nil", { links: [link_row(1)] }, [nil])
cases << run("a product whose deletion was undone", { links: [link_row(1, deleted_at: nil)], product_files: [file_row(1)] })
cases << run("a deleted product with sales", { links: [link_row(1)], product_files: [file_row(1)] }, es_bodies: [sales(3)])
cases << run("a deleted product with sales beyond the tracked total", { links: [link_row(1)], product_files: [file_row(1)] }, es_bodies: [sales(10_000, "gte")])
cases << run("a deleted product with no sales and no files", { links: [link_row(1)] }, es_bodies: [sales(0)])
cases << run("a deleted product with no sales and a file", { links: [link_row(1)], product_files: [file_row(1)] }, es_bodies: [sales(0)])
cases << run("a deleted product with no sales and two files", { links: [link_row(1)], product_files: [file_row(2), file_row(1)] }, es_bodies: [sales(0)])
cases << run("a deleted product with no sales and an already deleted file", { links: [link_row(1)], product_files: [file_row(1, deleted_at: SEEDED_AT)] }, es_bodies: [sales(0)])
cases << run("files of another product", { links: [link_row(1), link_row(2)], product_files: [file_row(1, link: 2)] }, es_bodies: [sales(0)])
cases << run("the second product", { links: [link_row(1), link_row(2)], product_files: [file_row(1, link: 1)] }, [2], es_bodies: [sales(0)])
cases << run("a product id given as a digit string", { links: [link_row(1)] }, ["1"], es_bodies: [sales(0)])
cases << run("a product id given as a float", { links: [link_row(1)] }, [1.0], es_bodies: [sales(0)])
cases << run("a product id given as a word", { links: [link_row(1)] }, ["abc"], es_bodies: [sales(0)])
cases << run("a search answer without a total", { links: [link_row(1)] }, es_bodies: [{ "hits" => { "hits" => [] } }])
cases << run("a search answer with a bare total", { links: [link_row(1)] }, es_bodies: [{ "hits" => { "total" => 5, "hits" => [] } }])
cases << run("a search answer with a null total value", { links: [link_row(1)] }, es_bodies: [{ "hits" => { "total" => { "value" => nil }, "hits" => [] } }])
cases << run("a search answer with a fractional total", { links: [link_row(1)] }, es_bodies: [{ "hits" => { "total" => { "value" => 0.5 }, "hits" => [] } }])
[["a string", "3"], ["true", true], ["false", false], ["an array", [1]], ["an object", { "a" => 1 }]].each do |label, value|
  cases << run("a search answer with #{label} as the total value", { links: [link_row(1)] }, es_bodies: [{ "hits" => { "total" => { "value" => value }, "hits" => [] } }])
end
cases << run("a search answer that is empty", { links: [link_row(1)] }, es_bodies: [{}])

File.write(OUT, JSON.pretty_generate({ "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
