# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/pdf-unstampable-notifier-job.golden.json: PdfUnstampableNotifierJob run by the real app
# against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). A PDF whose stampability is unknown is what Node hands back
# to Rails (PdfStampingService reads the file from S3); those cases are recorded up to that check, which a marker exception stands in
# for. Run it like delete-wishlist-products-job.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/pdf-unstampable-notifier-job.rb   (env as in publish-scheduled-post.rb)
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/pdf-unstampable-notifier-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[links product_files].freeze
STAMP_ENABLED = 1 << 4

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

PdfStampingService.singleton_class.prepend(Module.new do
  def can_stamp_file?(*, **) = raise(HandBackMarker)
end)

def link_row(id, **overrides) = { id:, name: "Product #{id}", user_id: 1, unique_permalink: "p#{id}", price_currency_type: "usd", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def file_row(id, link_id: 1, **overrides)
  { id:, link_id:, url: "https://example.com/files/#{id}.pdf", filetype: "pdf", flags: STAMP_ENABLED, stampable_pdf: nil,
    created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, args, seed)
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "PdfUnstampableNotifierJob", args:) do
    PdfUnstampableNotifierJob.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

def seed(*files, link: link_row(1)) = { links: [link], product_files: files }

cases = []
cases << run("a product that does not exist", [9], seed)
cases << run("a product with no file", [1], seed)
cases << run("a product with a pdf whose stampability is unknown", [1], seed(file_row(1)))
cases << run("a product with the backfill flag set", [1, true], seed)
cases << run("a product with a pdf whose stampability is unknown and the backfill flag set", [1, true], seed(file_row(1)))
cases << run("a product id as a digit string", ["1"], seed)
cases << run("a pdf already known stampable", [1], seed(file_row(1, stampable_pdf: true)))
cases << run("a pdf already known unstampable", [1], seed(file_row(1, stampable_pdf: false)))
cases << run("a pdf without stamping enabled", [1], seed(file_row(1, flags: 0)))
cases << run("a file that is not a pdf", [1], seed(file_row(1, filetype: "zip")))
cases << run("a deleted pdf", [1], seed(file_row(1, deleted_at: SEEDED_AT)))
cases << run("a pdf of another product", [1], seed(file_row(1, link_id: 2)))
cases << run("several files, one of them a pdf to check", [1], seed(file_row(1, stampable_pdf: true), file_row(2, filetype: "zip"), file_row(3)))
cases << run("a product id of nil", [nil], seed(file_row(1)))
cases << run("a product id as a float", [1.0], seed)
cases << run("a product id as a word", ["one"], seed)

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
