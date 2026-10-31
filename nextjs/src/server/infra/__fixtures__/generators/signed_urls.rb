# frozen_string_literal: true

# Writes signed-urls.golden.json by running app/helpers/signed_url_helper.rb with aws-sdk-s3 1.157.0
# (stubbed responses, fake keys) and a frozen clock.
#   GEM_HOME=<gems> ruby signed_urls.rb <fake-rsa.pem> <actionpack-8.1.3.1 dir> > ../signed-urls.golden.json
gem "aws-sdk-core", "3.201.4"
gem "aws-sigv4", "1.9.1"
gem "aws-partitions", "1.963.0"
require "active_support"
require "active_support/core_ext/object/blank"
require "active_support/core_ext/numeric/time"
require "active_support/core_ext/integer/time"
require "aws-sdk-s3"
require "cgi"
require "i18n"
require "json"
require "openssl"
require "uri"
require File.join(ARGV.fetch(1), "lib/action_dispatch/http/content_disposition")

I18n.available_locales = [:en]
NOW = Time.utc(2026, 10, 31, 12, 0, 0)
class Time
  def self.current = NOW
end

module Rails
  CACHE = Object.new.tap { |cache| def cache.fetch(_key) = yield }
  def self.cache = CACHE
end
module GlobalConfig
  def self.get(name) = { "CLOUDFLARE_HMAC_KEY" => "fake-cloudflare-hmac-key" }.fetch(name)
end
module RedisKey
  def self.cf_cache_invalidated_extensions_and_cache_keys = "cf_cache_invalidated_extensions_and_cache_keys"
end
REDIS_OVERRIDES = { ".mp3" => "mp3-override-key", ".zip" => "zip-override-key" }.freeze
$redis = Object.new.tap { |redis| def redis.hgetall(_key) = REDIS_OVERRIDES }

PEM = File.read(ARGV.fetch(0))
CLOUDFRONT_PRIVATE_KEY = OpenSSL::PKey::RSA.new(PEM)
CLOUDFRONT_KEYPAIR_ID = "APKAFAKEKEYPAIR"
CLOUDFLARE_CACHE_LIMIT = 8_000_000_000
S3_BUCKET = "gumroad"
FILE_DOWNLOAD_DISTRIBUTION_URL = "https://files.gumroad.com/"
CLOUDFRONT_DOWNLOAD_DISTRIBUTION_URL = "https://d2dw6lv4z9w0e2.cloudfront.net/"
USING_MINIO = false

require_relative "../../../../../../app/helpers/signed_url_helper"
helper = Object.new.extend(SignedUrlHelper)

credentials = Aws::Credentials.new("AKIAFAKEACCESSKEY", "fake/secret/access/key")
Aws.config.update(region: "us-east-1", credentials:)

def stub_content_length(length)
  Aws.config[:s3] = { stub_responses: { head_object: { content_length: length } } }
end

# Durations keep their calendar parts: Time + 10.years advances the date, it does not add seconds.
def duration_json(value) = value.is_a?(ActiveSupport::Duration) ? value.parts : value

out = { now: NOW.to_i, private_key_pem: PEM, key_pair_id: CLOUDFRONT_KEYPAIR_ID, cloudflare_hmac_key: "fake-cloudflare-hmac-key", redis_cache_key_overrides: REDIS_OVERRIDES }

out[:cloudfront] = [
  ["https://d1bdh6c3ceakz5.cloudfront.net/attachments/abc/original/video.m3u8", {}],
  ["https://d1bdh6c3ceakz5.cloudfront.net/attachments/abc/original/video.m3u8", { is_video: true }],
  ["https://d2dw6lv4z9w0e2.cloudfront.net/attachments/x/file.pdf?response-content-disposition=attachment", { expires_in: 3.hours }],
  ["attachments/relative/path.mp4", { is_video: true, expires_in: 60 }],
].map { |url, opts| { url:, is_video: opts[:is_video] || false, expires_in: duration_json(opts[:expires_in]), result: helper.signed_cloudfront_url(url, **opts) } }

out[:cloudflare] = [
  ["https://files.gumroad.com/attachments/abc/file.pdf?response-content-disposition=attachment", 600],
  ["https://files.gumroad.com/attachments/a%20b/caf%C3%A9.zip?cache_group=x&response-content-disposition=attachment", 10_800],
].map { |url, expires_in| { url:, expires_in:, result: helper.send(:signed_cloudflare_url, url, expires_in.seconds) } }

out[:validity] = [nil, 0, 1_024, 1_000_000, 50_000_000, 600_000_000, 10_000_000_000].map do |size|
  { file_size: size, seconds: helper.send(:signed_url_validity_time_for_file_size, size).to_i }
end

disposition_cases = [
  ["attachments/1/original/file.pdf", "file.pdf"],
  ["attachments/1/original/file", "My File.pdf"],
  ["attachments/1/original/file", ""],
  ["attachments/1/original/file", nil],
  ["attachments/1/original/file", "Café crème; \"quoted\".epub"],
  ["attachments/1/original/file", "日本語のファイル.zip"],
  ["attachments/1/original/file", "Straße & Øre (1)/[2] 100%.mp3"],
  ["attachments/1/original/file.ZIP", "file.zip"],
]
out[:content_disposition] = disposition_cases.map do |key, name|
  { s3_key: key, s3_filename: name, result: helper.send(:content_disposition_param, key, name) }
end

out[:cache_keys] = ["a.JPG", "b.mp3", "c.zip", "d.pdf", "", nil].map { |name| { s3_filename: name, result: (helper.send(:cf_cache_key, name) if name) } }

download_cases = [
  ["attachments/123/original/file.pdf", "file.pdf", 1_000_000, {}],
  ["attachments/123/original/my file (1).zip", "my file (1).zip", 600_000_000, {}],
  ["attachments/123/original/café", "café.epub", 2_000, { cache_group: "read & watch" }],
  ["attachments/123/original/movie.mp4", "movie.mp4", 9_000_000_000, { is_video: true }],
  ["attachments/123/original/huge.bin", "huge.bin", 9_000_000_000, {}],
  ["attachments/123/original/doc", "doc.pdf", 5_000, { expires_in: 10.years }],
]
out[:download] = download_cases.map do |key, name, length, opts|
  stub_content_length(length)
  { s3_key: key, s3_filename: name, content_length: length, is_video: opts[:is_video] || false, cache_group: opts[:cache_group],
    expires_in: duration_json(opts[:expires_in]), public_url: Aws::S3::Resource.new.bucket(S3_BUCKET).object(key).public_url,
    result: helper.signed_download_url_for_s3_key_and_filename(key, name, **opts) }
end

# Local MinIO: aws.rb points the SDK at AWS_S3_ENDPOINT with path-style addressing.
Aws.config[:s3] = { force_path_style: true, stub_responses: { head_object: { content_length: 2_048_000 } } }
Aws.config.update(endpoint: "http://localhost:9000")
Object.send(:remove_const, :USING_MINIO)
USING_MINIO = true
Object.send(:remove_const, :S3_BUCKET)
S3_BUCKET = "gumroad-dev"
module Aws
  module S3
    class Presigner
      prepend(Module.new do
        def presigned_url(method, params = {}) = super(method, params.merge(time: NOW))
      end)
    end
  end
end
out[:minio] = [
  ["attachments/1/original/file.pdf", "file.pdf", {}],
  ["attachments/1/original/my file+1 é.mp4", "my \"file\" é.mp4", { is_video: true }],
].map do |key, name, opts|
  { s3_key: key, s3_filename: name, content_length: 2_048_000, is_video: opts[:is_video] || false,
    public_url: Aws::S3::Resource.new.bucket(S3_BUCKET).object(key).public_url,
    result: helper.signed_download_url_for_s3_key_and_filename(key, name, **opts) }
end

puts JSON.pretty_generate(out)
