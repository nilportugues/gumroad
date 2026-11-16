# frozen_string_literal: true

# Writes credentials.golden.json: a Rails encrypted credentials file produced by
# ActiveSupport::EncryptedConfiguration itself, with a throwaway key.
#   GEM_HOME=<dir with activesupport 8.1.3.1> ruby credentials.rb > ../credentials.golden.json
require "active_support"
require "active_support/encrypted_configuration"
require "tmpdir"
require "json"

dir = Dir.mktmpdir
key = "0123456789abcdef0123456789abcdef"
File.write("#{dir}/master.key", key)
config = ActiveSupport::EncryptedConfiguration.new(
  config_path: "#{dir}/credentials.yml.enc", key_path: "#{dir}/master.key", env_key: "UNUSED_KEY", raise_if_missing_key: true
)
config.write(<<~YAML)
  secret_key_base: abc123
  aws_access_key_id: AKIAFAKE
  stripe:
    api_key: sk_test_nested
    max_retries: 3
  empty_value: ""
  blank_value: "   "
  false_value: false
  number_value: 42
  unicode_value: "héllo"
YAML

puts JSON.pretty_generate(key:, encrypted: File.read("#{dir}/credentials.yml.enc"), config: config.config)
