# frozen_string_literal: true

# Writes global-config.golden.json by running lib/utilities/global_config.rb itself against the
# credentials in credentials.golden.json and a series of ENV states.
#   GEM_HOME=<dir with activesupport 8.1.3.1> ruby global_config.rb > ../global-config.golden.json
require "active_support"
require "active_support/core_ext/object/blank"
require "active_support/encrypted_configuration"
require "tmpdir"
require "json"

fixture = JSON.parse(File.read(File.expand_path("../credentials.golden.json", __dir__)))
dir = Dir.mktmpdir
File.write("#{dir}/master.key", fixture["key"])
File.write("#{dir}/credentials.yml.enc", fixture["encrypted"])
CREDENTIALS = ActiveSupport::EncryptedConfiguration.new(
  config_path: "#{dir}/credentials.yml.enc", key_path: "#{dir}/master.key", env_key: "UNUSED_KEY", raise_if_missing_key: true
)

module Rails
  def self.application = Struct.new(:credentials).new(CREDENTIALS)
end

require_relative "../../../../../../lib/utilities/global_config"

NO_DEFAULT = :__no_default__

def run(env, call)
  saved = ENV.to_h
  ENV.replace(saved.merge(env))
  method, args, default = call
  value =
    if method == "dig"
      default == NO_DEFAULT ? GlobalConfig.dig(*args) : GlobalConfig.dig(*args, default:)
    else
      default == NO_DEFAULT ? GlobalConfig.get(args) : GlobalConfig.get(args, default)
    end
  { value: }
rescue StandardError => e
  { error: e.class.name }
ensure
  ENV.replace(saved)
end

cases = [
  [{ "GC_FOO" => "bar" }, ["get", "GC_FOO", NO_DEFAULT]],
  [{ "GC_FOO" => "bar" }, ["get", "GC_FOO", "d"]],
  [{ "GC_FOO" => "" }, ["get", "GC_FOO", NO_DEFAULT]],
  [{ "GC_FOO" => "" }, ["get", "GC_FOO", "d"]],
  [{ "GC_FOO" => "   " }, ["get", "GC_FOO", NO_DEFAULT]],
  [{ "GC_FOO" => "   " }, ["get", "GC_FOO", "d"]],
  [{}, ["get", "GC_MISSING", NO_DEFAULT]],
  [{}, ["get", "GC_MISSING", "d"]],
  [{}, ["get", "GC_MISSING", nil]],
  [{}, ["get", "SECRET_KEY_BASE", NO_DEFAULT]],
  [{}, ["get", "secret_key_base", NO_DEFAULT]],
  [{ "SECRET_KEY_BASE" => "from-env" }, ["get", "SECRET_KEY_BASE", NO_DEFAULT]],
  [{ "SECRET_KEY_BASE" => "" }, ["get", "SECRET_KEY_BASE", NO_DEFAULT]],
  [{ "SECRET_KEY_BASE" => "" }, ["get", "SECRET_KEY_BASE", "d"]],
  [{}, ["get", "AWS_ACCESS_KEY_ID", NO_DEFAULT]],
  [{}, ["get", "STRIPE__API_KEY", NO_DEFAULT]],
  [{}, ["get", "STRIPE__MAX_RETRIES", NO_DEFAULT]],
  [{}, ["get", "STRIPE__MISSING", NO_DEFAULT]],
  [{}, ["get", "STRIPE__MISSING", "d"]],
  [{}, ["get", "STRIPE", NO_DEFAULT]],
  [{}, ["get", "EMPTY_VALUE", NO_DEFAULT]],
  [{}, ["get", "EMPTY_VALUE", "d"]],
  [{}, ["get", "BLANK_VALUE", NO_DEFAULT]],
  [{}, ["get", "BLANK_VALUE", "d"]],
  [{}, ["get", "FALSE_VALUE", NO_DEFAULT]],
  [{}, ["get", "FALSE_VALUE", "d"]],
  [{}, ["get", "NUMBER_VALUE", NO_DEFAULT]],
  [{}, ["get", "UNICODE_VALUE", NO_DEFAULT]],
  [{}, ["get", "SECRET_KEY_BASE__NESTED", NO_DEFAULT]],
  [{}, ["get", "GC_MISSING__NESTED", NO_DEFAULT]],
  [{}, ["dig", ["stripe", "api_key"], NO_DEFAULT]],
  [{}, ["dig", ["Stripe", "Max_Retries"], NO_DEFAULT]],
  [{}, ["dig", ["stripe", "missing"], "d"]],
  [{ "STRIPE__API_KEY" => "env-wins" }, ["dig", ["stripe", "api_key"], NO_DEFAULT]],
]

puts JSON.pretty_generate(
  cases.map do |env, call|
    method, args, default = call
    entry = { env:, method:, args: }
    entry[:default] = default unless default == NO_DEFAULT
    entry.merge(run(env, call))
  end
)
