# frozen_string_literal: true

# Writes secure-headers.golden.json: the headers secure_headers 7.3.0 emits under the real
# config/domain.rb, config/initializers/aws.rb and config/initializers/secure_headers.rb, per Rails
# env. Each scenario runs in its own process because those files define constants at load time.
#   GEM_HOME=<gems> ruby secure_headers.rb > ../secure-headers.golden.json
require "json"
require "rbconfig"

ROOT = File.expand_path("../../../../../..", __dir__)
FIXED_NONCE = "FIXEDNONCEFIXEDNONCEFIXEDNONCEFIXEDNONCE000="

SCENARIOS = {
  "production" => { "RAILS_ENV" => "production" },
  "staging" => { "RAILS_ENV" => "staging" },
  "development" => { "RAILS_ENV" => "development", "AWS_S3_ENDPOINT" => "http://localhost:9000", "VITE_RUBY_PORT" => "3037" },
  "development_https" => {
    "RAILS_ENV" => "development", "AWS_S3_ENDPOINT" => "http://localhost:9000", "CUSTOM_PROTOCOL" => "https",
    "CUSTOM_DOMAIN" => "gumroad.dev", "ANYCABLE_PORT" => "9090", "DEV_LANE_PORT" => "3100"
  },
  "test" => { "RAILS_ENV" => "test" },
}.freeze

CLEARED = %w[
  RAILS_ENV RACK_ENV AWS_S3_ENDPOINT VITE_RUBY_PORT CUSTOM_PROTOCOL CUSTOM_DOMAIN ANYCABLE_PORT DEV_LANE_PORT
  ASSET_DOMAIN FILE_DOWNLOAD_DISTRIBUTION_URL_PROD FILE_DOWNLOAD_DISTRIBUTION_URL_DEV HLS_DISTRIBUTION_URL_PROD
  HLS_DISTRIBUTION_URL_DEV CLOUDFRONT_PRIVATE_KEY
].freeze

def child
  require "active_support"
  require "active_support/core_ext"
  require "active_support/environment_inquirer"
  require "aws-sdk-s3"
  require "rack"
  require "rack/mock_request"
  require "secure_headers"
  require "securerandom"

  env = ENV.fetch("RAILS_ENV")
  app_config = Struct.new(:asset_host).new(nil)
  Object.const_set(:Rails, Module.new)
  Rails.define_singleton_method(:env) { ActiveSupport::EnvironmentInquirer.new(env) }
  Rails.define_singleton_method(:application) { Struct.new(:config, :credentials).new(app_config, {}) }

  require File.join(ROOT, "lib/utilities/global_config")
  require File.join(ROOT, "config/domain")
  app_config.asset_host = "#{PROTOCOL}://#{ASSET_DOMAIN}" unless env == "test" # config/environments/*.rb
  require File.join(ROOT, "config/initializers/aws")
  require File.join(ROOT, "config/initializers/secure_headers")

  def SecureRandom.base64(*) = FIXED_NONCE

  new_request = -> { Rack::Request.new(Rack::MockRequest.env_for("https://example.com/")) }
  headers = lambda do |setup = nil|
    request = new_request.call
    setup&.call(request)
    SecureHeaders.header_hash_for(request)
  end

  epub_assets = [Rails.application.config.asset_host].compact_blank
  {
    default: headers.call,
    script_nonce: headers.call(->(r) { SecureHeaders.content_security_policy_script_nonce(r) }),
    script_and_style_nonce: headers.call(lambda do |r|
      SecureHeaders.content_security_policy_script_nonce(r)
      SecureHeaders.content_security_policy_style_nonce(r)
    end),
    flipper_ui: headers.call(lambda do |r|
      SecureHeaders.append_content_security_policy_directives(r, { script_src: %w(code.jquery.com cdnjs.cloudflare.com cdn.jsdelivr.net), style_src: %w(cdn.jsdelivr.net) })
    end),
    sidekiq_web: headers.call(->(r) { SecureHeaders.append_content_security_policy_directives(r, { script_src: %w('unsafe-inline') }) }),
    append_unset_directive: headers.call(->(r) { SecureHeaders.append_content_security_policy_directives(r, { manifest_src: %w(example.com), form_action: %w(example.org) }) }),
    epub_reader: headers.call(lambda do |r|
      SecureHeaders.override_content_security_policy_directives(r, {
        child_src: ["'self'", "data:", "blob:"],
        font_src: ["'self'", "data:", "blob:", *epub_assets],
        frame_src: ["'self'", "data:", "blob:"],
        img_src: ["'self'", "data:", "blob:"],
        media_src: ["'self'", "data:", "blob:"],
        object_src: ["'self'", "data:", "blob:"],
        style_src: ["'self'", "'unsafe-inline'", "blob:", *epub_assets],
      })
    end),
    opt_out: headers.call(->(r) { SecureHeaders.opt_out_of_header(r, :csp) }),
  }
end

if ENV["SECURE_HEADERS_CHILD"]
  puts JSON.generate(child)
else
  result = SCENARIOS.to_h do |name, env|
    child_env = CLEARED.to_h { |key| [key, nil] }.merge(env, "SECURE_HEADERS_CHILD" => "1")
    output = IO.popen(child_env, [RbConfig.ruby, __FILE__], &:read)
    raise "#{name} failed" unless $?.success?
    [name, { env:, nonce: FIXED_NONCE, headers: JSON.parse(output) }]
  end
  puts JSON.pretty_generate(result)
end
