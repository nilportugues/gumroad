# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/rename-product-file-worker.golden.json: RenameProductFileWorker run by the real app
# against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). The storage copy (MultipartTransfer.transfer_to_s3) and the
# object's presigned url are replaced by recorders, so nothing reaches S3; each copy is recorded under `transfers`, and the save that
# follows it is in the statements. Run it like record-product-file-missing-from-storage-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/rename-product-file-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[product_files links installments users versions].freeze
GUID = "a" * 32

Rails.logger = ActiveSupport::Logger.new(nil)

$transfers = []
MultipartTransfer.singleton_class.prepend(Module.new do
  def transfer_to_s3(url, destination_filename:, existing_s3_object:, **)
    $transfers << [url, destination_filename]
    "renamed/#{destination_filename}"
  end
end)
ProductFile.prepend(Module.new do
  def s3_object
    return super unless s3?

    object = Object.new
    object.define_singleton_method(:presigned_url) { |*| "https://storage.example.com/signed" }
    object
  end
end)

def namespaced(name) = "#{S3_BASE_URL}attachments/ext/#{GUID}/original/#{name}"

def file_row(id, **overrides) = { id:, link_id: 1, url: namespaced("sample.pdf"), filetype: "pdf", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def run(name, args, rows)
  $transfers = []
  result = capture(name, now: NOW, tables: TABLES, seed: { product_files: rows }, sidekiq: true, job: "RenameProductFileWorker", args:) do
    RenameProductFileWorker.new.perform(*args)
  end
  result.delete("seed")
  result.merge("transfers" => $transfers.dup, "s3_base_url" => S3_BASE_URL)
end

cases = []
cases << run("a file that does not exist", [99], [])
cases << run("a file id of nil", [nil], [file_row(1)])
cases << run("a file already marked deleted from the cdn", [1], [file_row(1, display_name: "other", deleted_from_cdn_at: SEEDED_AT)])
cases << run("a file id given as a digit string", ["1"], [file_row(1, display_name: "sample")])
cases << run("a file id given as a float", [1.0], [file_row(1, display_name: "sample")])
cases << run("a file id given as a word", ["abc"], [file_row(1, display_name: "sample")])
cases << run("a file hosted elsewhere without a display name", [1], [file_row(1, url: "https://files.example.com/a.pdf")])
cases << run("a file hosted elsewhere with an empty display name", [1], [file_row(1, url: "https://files.example.com/a.pdf", display_name: "")])
cases << run("a file with no url and no display name", [1], [file_row(1, url: nil)])
cases << run("a file with an empty url and no display name", [1], [file_row(1, url: "")])
cases << run("a file hosted elsewhere with a display name", [1], [file_row(1, url: "https://files.example.com/a.pdf", display_name: "renamed")])
cases << run("a namespaced file whose display name matches", [1], [file_row(1, display_name: "sample")])
cases << run("a namespaced file whose display name differs", [1], [file_row(1, display_name: "renamed")])
cases << run("a namespaced file whose display name keeps the extension", [1], [file_row(1, display_name: "renamed.pdf")])
cases << run("a namespaced file without a display name", [1], [file_row(1)])
cases << run("a namespaced file with an empty display name", [1], [file_row(1, display_name: "")])
cases << run("a namespaced file whose display name differs in case", [1], [file_row(1, display_name: "Sample")])
cases << run("a namespaced file with no extension whose display name matches", [1], [file_row(1, url: namespaced("README"), display_name: "README")])
cases << run("a namespaced file with a dotfile name", [1], [file_row(1, url: namespaced(".hidden"), display_name: ".hidden")])
cases << run("a namespaced file with dots in its name", [1], [file_row(1, url: namespaced("a.b.tar.gz"), display_name: "a.b.tar")])
cases << run("a namespaced file with a trailing dot in its name", [1], [file_row(1, url: namespaced("file."), display_name: "file")])
cases << run("a namespaced file with a trailing dot and the full display name", [1], [file_row(1, url: namespaced("file."), display_name: "file.")])
cases << run("a namespaced file without a file type whose display name matches", [1], [file_row(1, filetype: nil, display_name: "sample")])
cases << run("a namespaced file without a file type or a display name", [1], [file_row(1, filetype: nil)])
cases << run("a file hosted elsewhere with a display name and no file type", [1], [file_row(1, url: "https://files.example.com/a.pdf", display_name: "renamed", filetype: nil)])
cases << run("a file hosted elsewhere with a display name and a blank file type", [1], [file_row(1, url: "https://files.example.com/a.pdf", display_name: "renamed", filetype: "")])
cases << run("a file without a url but with a display name", [1], [file_row(1, url: nil, display_name: "renamed")])
cases << run("a file whose url is the storage prefix", [1], [file_row(1, url: S3_BASE_URL, display_name: "x")])
cases << run("a namespaced file with a slash in its name", [1], [file_row(1, url: namespaced("dir/sample.pdf"), display_name: "dir/sample")])
cases << run("a namespaced file with a unicode name", [1], [file_row(1, url: namespaced("café.pdf"), display_name: "café")])
cases << run("a namespaced file under the storage prefix only", [1], [file_row(1, url: "#{S3_BASE_URL}attachments/ext/short/original/sample.pdf", display_name: "sample")])
cases << run("a file under the storage prefix that is not namespaced", [1], [file_row(1, url: "#{S3_BASE_URL}attachments/ext/original/sample.pdf", display_name: "sample")])
cases << run("a file under the storage prefix that is not namespaced and has no display name", [1], [file_row(1, url: "#{S3_BASE_URL}attachments/ext/original/sample.pdf")])
cases << run("another file is deleted from the cdn", [2], [file_row(1, deleted_from_cdn_at: SEEDED_AT, display_name: "x"), file_row(2, display_name: "sample")])

File.write(OUT, JSON.pretty_generate({ "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
