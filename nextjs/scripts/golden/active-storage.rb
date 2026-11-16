# frozen_string_literal: true

# Produces nextjs/src/server/infra/__fixtures__/active-storage.golden.json: what User#avatar_url's
# Active Storage and CDN pieces compute, from the real code.
#
#   digests  ActiveStorage::Variation#digest of `blob.variant(resize_to_limit: [400, 400])`, which keys the
#            variant record (filename and content type decide the default format)
#   thumbnail_digests  the same for the 1280x720 thumbnail variants of ProductFile and VideoFile
#   signed_ids  ActiveStorage::Blob#signed_id (verifier "ActiveStorage", purpose "blob_id") under this run's secret_key_base
#   cdn      CdnUrlHelper#cdn_url_for under each environment's CDN_URL_MAP (config/initializers/cdn_url_map.rb
#            re-evaluated with that environment's constants)
#   urls     the public S3 service's URL for a key: the test service for real, and Aws::S3::Object#public_url
#            configured as the production service is (config/storage.yml `amazon`)
#
# Run from the repository root under the test environment:
#
#   RAILS_ENV=test bundle exec rails runner nextjs/scripts/golden/active-storage.rb
require "json"
require "aws-sdk-s3"

OUT = Rails.root.join("nextjs/src/server/infra/__fixtures__/active-storage.golden.json")

DIGEST_CASES = [
  ["avatar.png", "image/png"],
  ["avatar.PNG", "image/png"],
  ["photo.jpg", "image/jpeg"],
  ["photo.jpeg", "image/jpeg"],
  ["LEAVES.JPG", "image/jpeg"],
  ["photo.jfif", "image/jpeg"],
  ["photo.png", "image/jpeg"],
  ["photo", "image/jpeg"],
  [".hidden", "image/png"],
  ["archive.tar.gif", "image/gif"],
  ["trailing.", "image/gif"],
  ["picture.webp", "image/webp"],
  ["picture.heic", "image/heic"],
  ["scan.tiff", "image/tiff"],
  ["résumé.png", "image/png"],
].freeze

digests = DIGEST_CASES.map do |filename, content_type|
  blob = ActiveStorage::Blob.new(filename:, content_type:)
  { "filename" => filename, "content_type" => content_type, "digest" => blob.variant(resize_to_limit: [400, 400]).variation.digest }
end

thumbnail_digests = DIGEST_CASES.map do |filename, content_type|
  blob = ActiveStorage::Blob.new(filename:, content_type:)
  { "filename" => filename, "content_type" => content_type, "digest" => blob.variant(resize_to_limit: [1280, 720]).variation.digest }
end

signed_ids = {
  "secret_key_base" => Rails.application.secret_key_base,
  "results" => [1, 42, 123456].map { |id| [id, ActiveStorage::Blob.signed_id_verifier.generate(id, purpose: "blob_id")] },
}

variable = %w[image/png image/jpeg image/gif image/webp image/tiff image/heic application/pdf video/mp4 text/plain].to_h do |type|
  [type, ActiveStorage::Blob.new(filename: "x", content_type: type).variable?]
end

CDN_ENVIRONMENTS = {
  "production" => "https://s3.amazonaws.com",
  "staging" => "https://s3.amazonaws.com",
  "development" => "http://localhost:9010",
  "test" => "http://localhost:9010",
}.freeze

def with_environment(name, endpoint)
  originals = { env: Rails.env, endpoint: AWS_S3_ENDPOINT }
  %i[CDN_URL_MAP CDN_S3_PROXY_HOST PUBLIC_STORAGE_CDN_S3_PROXY_HOST AWS_S3_ENDPOINT].each { Object.send(:remove_const, _1) if Object.const_defined?(_1) }
  Object.const_set(:AWS_S3_ENDPOINT, endpoint)
  Rails.singleton_class.alias_method(:__env_before_golden, :env)
  Rails.singleton_class.define_method(:env) { ActiveSupport::StringInquirer.new(name) }
  load Rails.root.join("config/initializers/cdn_url_map.rb").to_s
  yield
ensure
  Rails.singleton_class.alias_method(:env, :__env_before_golden)
  %i[CDN_URL_MAP CDN_S3_PROXY_HOST PUBLIC_STORAGE_CDN_S3_PROXY_HOST AWS_S3_ENDPOINT].each { Object.send(:remove_const, _1) if Object.const_defined?(_1) }
  Object.const_set(:AWS_S3_ENDPOINT, originals[:endpoint])
  load Rails.root.join("config/initializers/cdn_url_map.rb").to_s
end

helper = Object.new.extend(CdnUrlHelper)
cdn = CDN_ENVIRONMENTS.map do |name, endpoint|
  with_environment(name, endpoint) do
    urls = [
      "#{endpoint}/gumroad/attachments/abc/photo.png",
      "#{endpoint}/gumroad-staging/attachments/abc/photo.png",
      "#{endpoint}/gumroad_dev/attachments/abc/photo.png",
      "#{endpoint}/gumroad-specs/ji0xpo3kwg79igdkpdpb04q3srje",
      "https://gumroad-public-storage.s3.amazonaws.com/variants/key/digest",
      "https://gumroad-dev-public-storage.s3.amazonaws.com/variants/key/digest",
      "#{endpoint}/gumroad/a #{endpoint}/gumroad/b",
      "https://example.com/avatar.png",
      "",
      "   ",
    ]
    { "env" => name, "endpoint" => endpoint, "results" => urls.map { |url| [url, helper.cdn_url_for(url)] } }
  end
end

keys = ["ji0xpo3kwg79igdkpdpb04q3srje", "variants/abc/def", "odd key/with space+plus&amp;/é.png"]

test_service = ActiveStorage::Blob.service
test_urls = keys.map { |key| [key, test_service.url(key, expires_in: 300, disposition: :inline, filename: ActiveStorage::Filename.new("a.png"), content_type: "image/png")] }

# aws.rb points the test environment's SDK at MinIO; production has no endpoint and virtual-hosted buckets.
Aws.config.delete(:endpoint)
Aws.config[:s3] = {}
credentials = Aws::Credentials.new("key", "secret")
production_client = Aws::S3::Client.new(region: "us-east-1", credentials:)
production_urls = keys.map { |key| [key, Aws::S3::Object.new("gumroad-public-storage", key, client: production_client).public_url] }

File.write(OUT, JSON.pretty_generate(
  "digests" => digests, "thumbnail_digests" => thumbnail_digests, "signed_ids" => signed_ids, "variable" => variable, "cdn" => cdn,
  "urls" => { "test" => { "endpoint" => AWS_S3_ENDPOINT, "bucket" => PUBLIC_STORAGE_S3_BUCKET, "results" => test_urls },
              "production" => { "bucket" => "gumroad-public-storage", "results" => production_urls } },
) + "\n")
puts "wrote #{OUT}"
