# frozen_string_literal: true

# Produces stripe-jobs.golden.json: the real Stripe-facing jobs from app/sidekiq on ActiveRecord
# 8.1's own Mysql2Adapter with only the driver faked (fake_mysql.rb), and the real stripe gem
# (12.5.0, configured as config/initializers/003_stripe.rb) talking to a local recording server
# (../../../server/stripe/__fixtures__/capture_server.rb). Each case records the SQL, the Stripe
# requests, the Sidekiq state and what the job raised.
#
#   G=<scratchpad>; GEM_HOME=$G/gemhome GEM_PATH=$G/gemhome:$G/ws05-gems:$G/bd331:$G/stripe-gems \
#     REDIS_URL=redis://127.0.0.1:6379/7 ruby generate-stripe-jobs-golden.rb
gem "bigdecimal", "3.3.1"
gem "connection_pool", "2.5.5"
gem "json", "2.13.2"
gem "activerecord", "8.1.3.1"
gem "sidekiq", "7.3.4"
gem "sidekiq-unique-jobs", "8.0.10"
gem "stripe", "12.5.0"
ENV["TZ"] = "UTC"
# The jobs run as in production: CreateStripeApplePayDomainWorker returns early in test.
ENV["RAILS_ENV"] = "production"
require "json"
require "logger"
require "pathname"
require "active_record"
require "active_support/all"
require "flag_shih_tzu"
require "sidekiq"
require "sidekiq_unique_jobs"
require "stripe"
require_relative "fake_mysql"
require_relative "../../../server/stripe/__fixtures__/capture_server"

ROOT = File.expand_path("../../../../..", __dir__)
REDIS_URL = ENV.fetch("REDIS_URL", "redis://127.0.0.1:6379/7")
abort "Refusing to run against db 0" unless REDIS_URL.match?(%r{/\d+\z}) && !REDIS_URL.end_with?("/0")

FIXED_NOW = Time.at(1_761_955_200, 123_000, :usec).utc
class Time
  class << self
    def now(...) = FIXED_NOW
  end
end
$jid_seq = 0
module SecureRandom
  def self.hex(n = nil)
    return super unless n == 12
    $jid_seq += 1
    format("%024x", $jid_seq)
  end
end

module Rails
  def self.root = Pathname(ROOT)
  def self.logger = (@logger ||= Logger.new($log_io = StringIO.new))
  def self.env = ActiveSupport::StringInquirer.new("production")
end
ActiveRecord.default_timezone = :utc
Time.zone_default = Time.find_zone!("UTC")
Time.zone = "UTC"
ActiveRecord.run_after_transaction_callbacks_in_order_defined = false
ActiveRecord::Base.run_commit_callbacks_on_first_saved_instances_in_transaction = true
ActiveRecord::Base.belongs_to_required_by_default = true
ActiveRecord.belongs_to_required_validates_foreign_key = true
ActiveRecord::Base.partial_inserts = false
ActiveRecord::Base.automatic_scope_inversing = true
ActiveRecord.before_committed_on_all_records = true
ActiveRecord.raise_on_assign_to_attr_readonly = true

schema = FakeMysql::SchemaCapture.load(File.join(ROOT, "db/schema.rb"))
FakeMysql.schema = schema.tables
FakeMysql.indexes = schema.indexes
ActiveRecord::Base.logger = nil
ActiveRecord::Base.establish_connection(adapter: "mysql2", database: "gumroad_test", encoding: "utf8mb4", collation: "utf8mb4_unicode_ci")
ActiveRecord::ConnectionAdapters::Mysql2Adapter.class_eval { private def default_type(*) = :literal }

# A statement fails as MySQL would fail it (1062 is a duplicate key).
class FakeMysqlFailure < Mysql2::Error
  def initialize(number, message) = (super(message); @number = number)
  def error_number = @number
end
FakeMysql.singleton_class.prepend(Module.new do
  def query(sql)
    response = super
    raise FakeMysql.log.last["result"].delete("raise") if FakeMysql.log.last&.dig("result", "raise").is_a?(Exception)
    response
  end

  def encode(response)
    return { "error" => { "number" => response.error_number, "message" => response.message }, "raise" => response } if response.is_a?(FakeMysqlFailure)
    super
  end
end)

Sidekiq.configure_client do |config|
  config.redis = { url: REDIS_URL }
  config.client_middleware { |chain| chain.add SidekiqUniqueJobs::Middleware::Client }
end
Sidekiq.default_job_options = { "backtrace" => true, "retry" => 25 }

server = CaptureServer.new
Stripe.api_version = "2023-10-16; risk_in_requirements_beta=v1; retrieve_tax_forms_beta=v1;"
Stripe.max_network_retries = 3
Stripe.api_key = "sk_test_golden"
Stripe.api_base = "http://127.0.0.1:#{server.port}"
$sleeps = []
Stripe::StripeClient.prepend(Module.new { def sleep(seconds) = $sleeps << seconds })

def load_app(path) = load(File.join(ROOT, path))
load_app("config/domain.rb")
DENYLIST = File.read(File.join(ROOT, "config/initializers/004_constants.rb"))[/^DENYLIST = (%w\[.*?\])/m, 1].then { eval(_1) } # rubocop:disable Security/Eval

%w[app/modules/deletable.rb app/models/concerns/json_data.rb app/modules/subdomain.rb].each { load_app(_1) }

# ErrorNotifier.notify: recorded instead of sent.
module ErrorNotifier
  def self.notifications = ($notifications ||= [])
  def self.notify(error, **context) = notifications << [error.is_a?(Exception) ? error.message : error, context.transform_keys(&:to_s)]
end

def ruby_method(path, name)
  source = File.read(File.join(ROOT, path))
  source[/^( +)def #{Regexp.escape(name)}(?=[\s(]).*?^\1end$/m] or raise "no #{name} in #{path}"
end

class ApplicationRecord < ActiveRecord::Base
  self.abstract_class = true
end
module StripeChargeProcessor
  def self.charge_processor_id = "stripe"
end
module PaypalChargeProcessor
  def self.charge_processor_id = "paypal"
end
module BraintreeChargeProcessor
  def self.charge_processor_id = "braintree"
end
load_app("app/models/concerns/charge_processable.rb")
class User < ApplicationRecord
  include Deletable
  has_many :merchant_accounts
  %w[username stripe_account subdomain subdomain_with_protocol profile_url].each { class_eval(ruby_method("app/models/user.rb", _1)) }
  alias_method :business_profile_url, :profile_url
end
class MerchantAccount < ApplicationRecord
  include Deletable
  include JsonData
  include ChargeProcessable
  belongs_to :user, optional: true
  File.read(File.join(ROOT, "app/models/merchant_account.rb")).lines.grep(/\A  scope :(charge_processor_alive|stripe),/).each { class_eval(_1) }
  %w[is_a_stripe_connect_account? is_a_gumroad_managed_stripe_account?].each { class_eval(ruby_method("app/models/merchant_account.rb", _1)) }
end
load_app("app/models/stripe_apple_pay_domain.rb")

%w[sync_stripe_business_profile_url_job delete_stripe_apple_pay_domain_worker create_stripe_apple_pay_domain_worker].each { load_app("app/sidekiq/#{_1}.rb") }

def redis(&) = Sidekiq.redis(&)

def snapshot
  redis do |conn|
    conn.call("KEYS", "*").sort.to_h do |key|
      type = conn.call("TYPE", key)
      value =
        case type
        when "string" then conn.call("GET", key)
        when "list" then conn.call("LRANGE", key, 0, -1)
        when "set" then conn.call("SMEMBERS", key).sort
        when "hash" then conn.call("HGETALL", key)
        when "zset" then conn.call("ZRANGE", key, 0, -1, "WITHSCORES").flatten.each_slice(2).map { |m, score| [m, score.to_f] }
        end
      next [key, { "type" => type, "count" => value.size, "expires" => conn.call("PTTL", key).positive? }] if key == "uniquejobs:changelog"
      [key, { "type" => type, "value" => value, "expires" => conn.call("PTTL", key).positive? }]
    end
  end
end

def rows(fields, *rows) = FakeMysql::Rows.new(fields, rows)
def write(affected) = FakeMysql::Write.new(affected)
def dup_key(sql) = FakeMysqlFailure.new(1062, "Duplicate entry for key '#{sql[/INTO `([^`]+)`/, 1]}'")

def script(*rules)
  rules = rules.map { |pattern, answer| [pattern, answer.is_a?(Array) ? answer.dup : answer] }
  lambda do |sql|
    rule = rules.find { |pattern, _| pattern.is_a?(Regexp) ? pattern.match?(sql) : sql.start_with?(pattern) }
    next nil unless rule
    answer = rule[1].is_a?(Array) ? rule[1].shift : rule[1]
    answer.respond_to?(:call) ? answer.call(sql) : answer
  end
end

def ok(body) = [200, { "Request-Id" => "req_ok", "Content-Type" => "application/json" }, JSON.generate(body)]
def stripe_error(status, error) = [status, { "Request-Id" => "req_err", "Content-Type" => "application/json" }, JSON.generate({ error: })]

$server = server
def capture(name, responder, stripe: [], args: nil)
  redis { |conn| conn.call("FLUSHDB") }
  $jid_seq = 0
  $sleeps = []
  ErrorNotifier.notifications.clear
  Stripe::StripeClient.current_thread_context.default_client = nil
  $server.requests.clear
  $server.responses = stripe.map { |status, headers, body| [status, headers.dup, body] }
  $log_io&.truncate(0)
  $log_io&.rewind
  error = nil
  statements = FakeMysql.run(responder) do
    yield
  rescue StandardError => e
    error = { "class" => e.class.name, "message" => e.message }
  end
  {
    "name" => name, "args" => args, "error" => error, "statements" => statements, "redis" => snapshot,
    "stripe" => { "responses" => stripe, "requests" => $server.requests.dup }, "retries" => $sleeps.size,
    "notifications" => ErrorNotifier.notifications.dup, "log" => $log_io&.string.to_s.lines.map { _1.sub(/\A.*? -- : /, "").chomp },
  }.compact
end

t = ->(string) { Time.utc(*string.scan(/\d+/).map(&:to_i)) }
user_fields = %w[id username external_id deleted_at flags]
user_row = ->(id, username: "seller#{id}", external_id: "48213", deleted_at: nil) { rows(user_fields, [id, username, external_id, deleted_at, 0]) }
account_fields = %w[id user_id charge_processor_id charge_processor_merchant_id country json_data deleted_at charge_processor_alive_at charge_processor_deleted_at]
alive_at = t["2025-01-01"]
managed = ->(id) { [id, 5, "stripe", "acct_#{id}", "US", nil, nil, alive_at, nil] }
connect = ->(id) { [id, 5, "stripe", "acct_#{id}", "US", '{"meta":{"stripe_connect":"true"}}', nil, alive_at, nil] }
accounts = ->(*list) { ["SELECT `merchant_accounts`.*", rows(account_fields, *list)] }
stripe_account = ->(url) { ok({ id: "acct_41", object: "account", business_profile: { url: } }) }
updated = ok({ id: "acct_41", object: "account" })

jobs = {}

sync = ->(name, responder, stripe = []) { capture(name, responder, stripe:, args: [5]) { SyncStripeBusinessProfileUrlJob.new.perform(5); nil } }
seller = ["SELECT `users`.*", user_row.(5)]
jobs["SyncStripeBusinessProfileUrlJob"] = [
  sync.("user missing", script()),
  sync.("deleted user", script(["SELECT `users`.*", user_row.(5, deleted_at: t["2025-02-01"])], accounts.(managed.(41)))),
  sync.("no username or external id", script(["SELECT `users`.*", user_row.(5, username: nil, external_id: nil)], accounts.(managed.(41)))),
  sync.("blank username falls back to the external id", script(["SELECT `users`.*", user_row.(5, username: "")], accounts.(managed.(41))), [stripe_account.("https://seller5.gumroad.com"), updated]),
  sync.("only a Stripe Connect account", script(seller, accounts.(connect.(40)))),
  sync.("stale seller subdomain is replaced", script(seller, accounts.(connect.(40), managed.(41))), [stripe_account.("https://oldname.gumroad.com"), updated]),
  sync.("stale subdomain without a scheme", script(seller, accounts.(managed.(41))), [stripe_account.("  OldName.gumroad.com/x "), updated]),
  sync.("current subdomain is left alone", script(seller, accounts.(managed.(41))), [stripe_account.("https://seller5.gumroad.com")]),
  sync.("underscore username maps to a hyphen subdomain", script(["SELECT `users`.*", user_row.(5, username: "my_shop")], accounts.(managed.(41))), [stripe_account.("http://my-shop.gumroad.com")]),
  sync.("custom domain is left alone", script(seller, accounts.(managed.(41))), [stripe_account.("https://example.com")]),
  sync.("nested gumroad host is left alone", script(seller, accounts.(managed.(41))), [stripe_account.("https://a.b.gumroad.com")]),
  sync.("denylisted subdomain is left alone", script(seller, accounts.(managed.(41))), [stripe_account.("https://app.gumroad.com")]),
  sync.("blank url", script(seller, accounts.(managed.(41))), [stripe_account.(nil)]),
  sync.("unparseable url", script(seller, accounts.(managed.(41))), [stripe_account.("https://bad host.gumroad.com")]),
  sync.("missing account is logged and skipped", script(seller, accounts.(managed.(41))),
        [stripe_error(404, { type: "invalid_request_error", code: "resource_missing", message: "No such account: 'acct_41'" })]),
  sync.("inaccessible account is logged and skipped", script(seller, accounts.(managed.(41))), [stripe_account.("https://oldname.gumroad.com"),
                                                                                              stripe_error(403, { type: "invalid_request_error", message: "No access" })]),
  sync.("a Stripe outage raises after retries", script(seller, accounts.(managed.(41))), Array.new(4) { stripe_error(500, { type: "api_error", message: "Down" }) }),
]

domain_fields = %w[id user_id domain stripe_id created_at updated_at]
domain_row = ->(id, user_id, domain = "seller5.gumroad.com") { [id, user_id, domain, "apwc_#{id}", t["2025-01-01"], t["2025-01-01"]] }
locked = ->(*list) { [/\ASELECT `stripe_apple_pay_domains`.\*.* FOR UPDATE\z/, rows(domain_fields, *list)] }
delete = ->(name, responder, stripe = []) { capture(name, responder, stripe:, args: [5, "seller5.gumroad.com"]) { DeleteStripeApplePayDomainWorker.new.perform(5, "seller5.gumroad.com"); nil } }
jobs["DeleteStripeApplePayDomainWorker"] = [
  delete.("no registration", script(locked.())),
  delete.("registration held by another user", script(locked.(domain_row.(7, 6)))),
  delete.("deleted on Stripe", script(locked.(domain_row.(7, 5))), [ok({ id: "apwc_7", object: "apple_pay_domain", deleted: true })]),
  delete.("Stripe did not delete it", script(locked.(domain_row.(7, 5))), [ok({ id: "apwc_7", object: "apple_pay_domain", deleted: false })]),
  delete.("already gone on Stripe", script(locked.(domain_row.(7, 5))), [stripe_error(404, { type: "invalid_request_error", code: "resource_missing", message: "No such domain" })]),
]

create = ->(name, responder, stripe = [], args: [5]) { capture(name, responder, stripe:, args:) { CreateStripeApplePayDomainWorker.new.perform(*args); nil } }
users_any = [/\ASELECT `users`.\*/, user_row.(5)]
created = ok({ id: "apwc_9", object: "apple_pay_domain", domain_name: "seller5.gumroad.com" })
jobs["CreateStripeApplePayDomainWorker"] = [
  create.("user missing", script()),
  create.("no username or external id", script(["SELECT `users`.*", user_row.(5, username: nil, external_id: nil)])),
  create.("already registered to this user", script(users_any, locked.(domain_row.(7, 5)))),
  create.("registers a new domain", script(users_any, locked.()), [created]),
  create.("registers an explicit domain", script(users_any, locked.()), [ok({ id: "apwc_9", object: "apple_pay_domain" })], args: [5, "shop.example.com"]),
  create.("takes over a registration Stripe still has", script(users_any, locked.(domain_row.(7, 6))), [ok({ id: "apwc_7", object: "apple_pay_domain" })]),
  create.("replaces a registration Stripe lost", script(users_any, [/FOR UPDATE\z/, [rows(domain_fields, domain_row.(7, 6)), rows(domain_fields)]]),
          [stripe_error(404, { type: "invalid_request_error", code: "resource_missing", message: "No such apple pay domain" }), created]),
  create.("a lookup error other than missing raises", script(users_any, locked.(domain_row.(7, 6))),
          [stripe_error(400, { type: "invalid_request_error", code: "parameter_invalid", message: "Bad id" })]),
  create.("a concurrent insert of the same domain is claimed", script(users_any, [/FOR UPDATE\z/, [rows(domain_fields), rows(domain_fields, domain_row.(8, 5))]], [/\AINSERT INTO `stripe_apple_pay_domains`/, ->(sql) { dup_key(sql) }]), [created]),
  create.("a concurrent insert that vanished raises", script(users_any, [/FOR UPDATE\z/, [rows(domain_fields), rows(domain_fields)]], [/\AINSERT INTO `stripe_apple_pay_domains`/, ->(sql) { dup_key(sql) }]), [created]),
]

exhausted = [[5, "seller5.gumroad.com"], [5]].map do |args|
  ErrorNotifier.notifications.clear
  CreateStripeApplePayDomainWorker.sidekiq_retries_exhausted_block.call({ "args" => args }, StandardError.new("boom"))
  { "args" => args, "notifications" => ErrorNotifier.notifications.dup }
end

File.write(File.join(__dir__, "stripe-jobs.golden.json"), JSON.pretty_generate(
  "generated_with" => { "ruby" => RUBY_VERSION, "activerecord" => ActiveRecord.version.to_s, "stripe" => Stripe::VERSION },
  "now" => FIXED_NOW.to_f,
  "jobs" => jobs,
  "retries_exhausted" => { "CreateStripeApplePayDomainWorker" => exhausted },
) + "\n")
redis { |conn| conn.call("FLUSHDB") }
puts "wrote stripe-jobs.golden.json"
