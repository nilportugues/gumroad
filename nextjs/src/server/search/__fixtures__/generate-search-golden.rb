# frozen_string_literal: true

# Produces search.golden.json: the Elasticsearch requests, SQL statements and Sidekiq pushes the
# real indexing code makes. Loaded as-is: Purchase::Searchable, Installment::Searchable,
# AudienceMember::Searchable, SearchIndexModelCommon, ElasticsearchModelAsyncCallbacks,
# ElasticsearchIndexerWorker, ReindexSubscriptionCurrentEmailWorker,
# BackfillMerchantAccountRecommendationEligibilityJob, ReindexRecommendableProductsWorker,
# lib/utilities/referrer.rb and the purchase.rb / subscription.rb / user.rb / link.rb declarations
# and methods the documents read (cut out with Prism, never retyped). The models run on
# ActiveRecord 8.1's Mysql2Adapter over the fake driver (../../../worker/jobs/__fixtures__/fake_mysql.rb),
# EsClient on elasticsearch 7.11.2 against a local socket that records each request and answers
# from the case's script, and Sidekiq/unique-jobs against a scratch Redis.
#
#   G=<scratchpad>; GEM_HOME=$G/gemhome GEM_PATH=$G/gemhome:$G/es-gems:$G/ws05-gems:$G/bd331:$G/gems \
#     REDIS_URL=redis://127.0.0.1:6379/6 ruby generate-search-golden.rb
#
# es-gems holds Gemfile.lock's elasticsearch 7.11.2 family, faraday 1.10.5, multi_json 1.15.0,
# hashie 5.0.0, nokogiri 1.19.3, loofah 2.25.1 and activerecord-mysql-index-hint 0.0.4.
gem "bigdecimal", "3.3.1"
gem "connection_pool", "2.5.5"
gem "json", "2.13.2"
gem "activerecord", "8.1.3.1"
gem "activesupport", "8.1.3.1"
gem "sidekiq", "7.3.4"
gem "sidekiq-unique-jobs", "8.0.10"
gem "elasticsearch", "7.11.2"
gem "elasticsearch-model", "7.1.1"
gem "faraday", "1.10.5"
gem "nokogiri", "1.19.3"
gem "loofah", "2.25.1"
ENV["TZ"] = "UTC"
require "English"
require "json"
require "logger"
require "pathname"
require "socket"
require "active_record"
require "active_support/all"
require "flag_shih_tzu"
require "sidekiq"
require "sidekiq_unique_jobs"
require "elasticsearch"
require "elasticsearch/model"
require "loofah"
require "prism"
require "activerecord-mysql-index-hint"
require_relative "../../../worker/jobs/__fixtures__/fake_mysql"

ROOT = File.expand_path("../../../../..", __dir__)
REDIS_URL = ENV.fetch("REDIS_URL", "redis://127.0.0.1:6379/6")
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
# rand(72.hours) in the update_by_query paths; Node's tests inject the same value.
FIXED_RAND = 1234
module Kernel
  def rand(*) = FIXED_RAND
end

module Rails
  def self.root = Pathname(ROOT)
  def self.logger = (@logger ||= Logger.new(nil))
  def self.env = ActiveSupport::StringInquirer.new("test")
end
ActiveRecord.default_timezone = :utc
Time.zone_default = Time.find_zone!("UTC")
Time.zone = "UTC"
ActiveSupport::JSON::Encoding.time_precision = 0 # config/initializers/json_time_precision.rb
ActiveRecord.run_after_transaction_callbacks_in_order_defined = false
ActiveRecord::Base.run_commit_callbacks_on_first_saved_instances_in_transaction = true
ActiveRecord::Base.belongs_to_required_by_default = true
ActiveRecord.belongs_to_required_validates_foreign_key = true
ActiveRecord::Base.partial_inserts = false
ActiveRecord::Base.automatic_scope_inversing = true
ActiveRecord.before_committed_on_all_records = true

schema = FakeMysql::SchemaCapture.load(File.join(ROOT, "db/schema.rb"))
FakeMysql.schema = schema.tables
FakeMysql.indexes = schema.indexes
ActiveRecord::Base.logger = nil
ActiveRecord::Base.establish_connection(adapter: "mysql2", database: "gumroad_test", encoding: "utf8mb4", collation: "utf8mb4_unicode_ci")
ActiveRecord::ConnectionAdapters::Mysql2Adapter.class_eval { private def default_type(*) = :literal }

# --- Elasticsearch: a socket that records requests and answers from a script ---------------------
module EsCapture
  class << self
    attr_accessor :responses
    def requests = (@requests ||= [])

    def start
      server = TCPServer.new("127.0.0.1", 0)
      Thread.new { loop { serve(server.accept) } }
      server.addr[1]
    end

    def serve(socket)
      method, target = socket.gets.split(" ")
      headers = {}
      while (line = socket.gets) && line != "\r\n"
        key, value = line.split(": ", 2)
        headers[key.downcase] = value.strip
      end
      body = headers["content-length"] ? socket.read(headers["content-length"].to_i) : nil
      path, query = target.split("?", 2)
      requests << { "method" => method, "path" => path, "query" => query, "body" => body }
      status, payload = (responses || []).shift || [200, {}]
      text = payload.is_a?(String) ? payload : JSON.generate(payload)
      socket.write("HTTP/1.1 #{status} X\r\nContent-Type: application/json\r\nContent-Length: #{text.bytesize}\r\nConnection: close\r\n\r\n#{text}")
    ensure
      socket.close
    end
  end
end
ES_PORT = EsCapture.start
EsClient = Elasticsearch::Model.client = Elasticsearch::Client.new(
  host: "http://127.0.0.1:#{ES_PORT}", retry_on_failure: 5, transport_options: { request: { timeout: 15 } }
)
USE_ES_ALIASES = false

# --- Redis / Sidekiq ------------------------------------------------------------------------------
Sidekiq.configure_client do |config|
  config.redis = { url: REDIS_URL }
  config.client_middleware { |chain| chain.add SidekiqUniqueJobs::Middleware::Client }
end
Sidekiq.default_job_options = { "backtrace" => true, "retry" => 25 }
require "redis-client"
class FakeRedisRb
  def initialize = @client = RedisClient.new(url: REDIS_URL)
  def smembers(key) = @client.call("SMEMBERS", key)
end
$redis = FakeRedisRb.new
module RedisKey
  def self.elasticsearch_indexer_worker_ignore_404_errors_on_indices = "elasticsearch_indexer_worker_ignore_404_errors_on_indices"
end
module Feature
  class << self
    attr_accessor :enabled
    def active?(name) = (enabled || []).include?(name)
  end
end

# --- app code -------------------------------------------------------------------------------------
def load_app(path) = load(File.join(ROOT, path))
def source(path) = File.read(File.join(ROOT, path))

def find_nodes(node, &block)
  found = []
  stack = [node]
  until stack.empty?
    current = stack.shift
    found << current if block.call(current)
    stack.concat(current.compact_child_nodes)
  end
  found
end

# The `def`s of `names` in `path`, in source order of `names`.
def defs(path, *names)
  program = Prism.parse(source(path)).value
  names.map do |name|
    node = find_nodes(program) { _1.is_a?(Prism::DefNode) && _1.name == name }.first or raise "def #{name} not found in #{path}"
    node.slice
  end.join("\n")
end

# Top-level calls in the class body (`has_one :license`, `scope :by_email, ...`) whose first
# argument is one of `names`.
def declarations(path, call, *names)
  program = Prism.parse(source(path)).value
  klass = find_nodes(program) { _1.is_a?(Prism::ClassNode) }.first
  names.map do |name|
    node = klass.body.body.find { _1.is_a?(Prism::CallNode) && _1.name == call && _1.arguments&.arguments&.first.respond_to?(:unescaped) && _1.arguments.arguments.first.unescaped == name.to_s }
    node or raise "#{call} :#{name} not found in #{path}"
    node.slice
  end.join("\n")
end

def has_flags_source(path)
  program = Prism.parse(source(path)).value
  klass = find_nodes(program) { _1.is_a?(Prism::ClassNode) }.first
  klass.body.body.find { _1.is_a?(Prism::CallNode) && _1.name == :has_flags }.slice
end

eval(source("config/initializers/004_constants.rb")[/^REFERRER_DOMAIN_FOR_GUMROAD_RECOMMENDED_PRODUCTS = .*$/])
load_app("lib/utilities/referrer.rb")
load_app("lib/utilities/card_type.rb")
load_app("app/models/concerns/transactional_attribute_change_tracker.rb")
load_app("app/models/concerns/search_index_model_common.rb")
load_app("app/modules/elasticsearch_model_async_callbacks.rb")

class ApplicationRecord < ActiveRecord::Base
  self.abstract_class = true
end

module BasePrice
  module Recurrence; end
end
load_app("app/modules/base_price/recurrence.rb")

class User < ApplicationRecord
  has_many :sales, class_name: "Purchase", foreign_key: :seller_id
  has_many :subscriptions
  has_many :products, class_name: "Link"
  class_eval(defs("app/models/user.rb", :form_email))
end
class Link < ApplicationRecord
  class_eval(defs("app/models/link.rb", :plaintext_description))
end
class Price < ApplicationRecord; end
class PaymentOption < ApplicationRecord
  belongs_to :price
end
class License < ApplicationRecord; end
class BaseVariant < ApplicationRecord
  self.inheritance_column = nil
end
class AffiliatePartialRefund < ApplicationRecord; end
class AffiliateCredit < ApplicationRecord
  has_many :affiliate_partial_refunds
  class_eval(defs("app/models/affiliate_credit.rb", :amount_partially_refunded_cents, :fee_partially_refunded_cents))
end
class Gift < ApplicationRecord; end
class Refund < ApplicationRecord
  TERMINAL_FAILURE_STATUSES = %w(failed canceled).freeze
  class_eval(declarations("app/models/refund.rb", :scope, :effective))
end
class Subscription < ApplicationRecord
  class_eval(declarations("app/models/subscription.rb", :belongs_to, :link, :user, :last_payment_option))
  class_eval(declarations("app/models/subscription.rb", :has_many, :purchases))
  class_eval(declarations("app/models/subscription.rb", :has_one, :original_purchase, :true_original_purchase))
  class_eval(defs("app/models/subscription.rb", :email, :gift?))
end
class Purchase < ApplicationRecord
  include FlagShihTzu
  class_eval(has_flags_source("app/models/purchase.rb"))
  class_eval(declarations("app/models/purchase.rb", :belongs_to, :link, :purchaser, :seller, :subscription))
  class_eval(declarations("app/models/purchase.rb", :has_one, :license, :affiliate_credit, :direct_affiliate_credit, :gift_given, :gift_received))
  class_eval(declarations("app/models/purchase.rb", :has_many, :refunds))
  class_eval(declarations("app/models/purchase.rb", :has_and_belongs_to_many, :variant_attributes))
  class_eval(declarations("app/models/purchase.rb", :scope, :by_email, :successful))
  class_eval(defs("app/models/purchase.rb", :country_or_ip_country, :amount_refunded_cents, :fee_refunded_cents, :tax_refunded_cents, :license, :is_recurring_subscription_charge, :gift, :giftee_email))
  load_app("app/models/concerns/purchase/searchable.rb")
  include Purchase::Searchable
end
class Installment < ApplicationRecord
  include FlagShihTzu
  class_eval(has_flags_source("app/models/installment.rb"))
  load_app("app/models/concerns/installment/searchable.rb")
  include Installment::Searchable
end
class AudienceMember < ApplicationRecord
  load_app("app/models/concerns/audience_member/searchable.rb")
  include AudienceMember::Searchable
end
load_app("app/models/confirmed_follower_event.rb")
load_app("app/models/product_page_view.rb")

# One database here, so `connected_to(role: :writing)` only runs its block.
def ApplicationRecord.connected_to(**) = yield
$slept = []
module Kernel
  def sleep(seconds) = $slept << seconds
end
load_app("app/sidekiq/elasticsearch_indexer_worker.rb")

# --- running a case -------------------------------------------------------------------------------
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

# `rules` are [pattern, answer] pairs; an answer that is an Array is consumed one per match.
def script(*rules)
  rules = rules.map { |pattern, answer| [pattern, answer.is_a?(Array) ? answer.dup : answer] }
  lambda do |sql|
    rule = rules.find { |pattern, _| pattern.is_a?(Regexp) ? pattern.match?(sql) : sql.start_with?(pattern) }
    next nil unless rule
    answer = rule[1].is_a?(Array) ? rule[1].shift : rule[1]
    answer.respond_to?(:call) ? answer.call(sql) : answer
  end
end

# Runs `block` with fresh Redis, SQL log and ES log; `es` scripts the ES answers in order.
def run(name, responder, es: [], ignore_404: [], features: [], args: nil, &block)
  redis { |conn| conn.call("FLUSHDB") }
  ignore_404.each { |index| redis { |conn| conn.call("SADD", RedisKey.elasticsearch_indexer_worker_ignore_404_errors_on_indices, index) } }
  Feature.enabled = features
  $slept.clear
  $jid_seq = 0
  EsCapture.requests.clear
  EsCapture.responses = es.dup
  error = nil
  result = nil
  statements = FakeMysql.run(responder) do
    result = block.call
  rescue StandardError => e
    error = { "class" => e.class.name, "message" => e.message }; warn e.backtrace.first(6) if ENV["SCRATCH"]
  end
  {
    "name" => name, "args" => args, "error" => error, "result" => result, "statements" => statements, "es" => EsCapture.requests.dup,
    "es_responses" => es, "features" => features.map(&:to_s), "ignore_404" => ignore_404, "slept" => $slept.dup, "redis" => snapshot.except(RedisKey.elasticsearch_indexer_worker_ignore_404_errors_on_indices),
  }
end

def t(string) = Time.utc(*string.scan(/\d+/).map(&:to_i))

# A `SELECT table.*` answer: every column of db/schema.rb in order, nil unless given.
def table_rows(table, *records)
  columns = FakeMysql.schema.fetch(table).map(&:first)
  records.each { |r| (r.keys.map(&:to_s) - columns).then { raise "#{table} has no #{_1}" if _1.any? } }
  FakeMysql::Rows.new(columns, records.map { |r| columns.map { |c| r.fetch(c.to_sym, nil) } })
end

def purchase_flags(*names) = names.sum { |name| Purchase.flag_mapping["flags"].fetch(name) }

def sql_rule(table, pattern = nil) = /\ASELECT `#{table}`\.\* FROM `#{table}`#{pattern ? ".*#{pattern}" : ""}/
def sum_rule(table, column, answer) = [/\ASELECT SUM\(`#{table}`\.`#{column}`\)/, rows(["SUM(`#{table}`.`#{column}`)"], [answer])]

golden = { "now" => FIXED_NOW.to_f, "rand" => FIXED_RAND }

# --- documents ------------------------------------------------------------------------------------
golden["search_fields"] = {
  "Purchase" => Purchase.search_fields,
  "Installment" => Installment.search_fields,
  "AudienceMember" => AudienceMember.search_fields,
}
golden["attribute_to_search_fields"] = {
  "Purchase" => Purchase::ATTRIBUTE_TO_SEARCH_FIELDS,
  "Installment" => Installment::ATTRIBUTE_TO_SEARCH_FIELDS,
  "AudienceMember" => AudienceMember::ATTRIBUTE_TO_SEARCH_FIELDS,
}

SELLER = { id: 4, email: "s@example.com", name: "Seller" }.freeze
PRODUCT = { id: 3, user_id: 4, unique_permalink: "abc", name: "Prod <b>&", description: "<h2>What you get</h2><p>Fish &amp; Chips<br>daily</p><!-- hidden --><ul><li>one</li><li>two</li></ul>", taxonomy_id: 12 }.freeze

ORIGINAL = {
  id: 1, link_id: 3, seller_id: 4, purchaser_id: 5, subscription_id: 7, email: "Buyer@Example.COM", price_cents: 1000, fee_cents: 120, tax_cents: 0,
  created_at: t("2025-01-02 03:04:05.678"), purchase_state: "successful", flags: purchase_flags(:is_original_subscription_purchase, :was_purchase_taxable),
  referrer: "https://www.Google.com/search?q=%E2%9C%93", card_type: "paypal", card_visual: "PP@Example.com", full_name: "Buyer Name", can_contact: true,
  country: "", ip_country: "United States", ip_state: "CA", stripe_refunded: false
}.freeze

purchase_cases = []
purchase_cases << run("original subscription purchase", script(
  [sql_rule("purchases", "`purchases`.`id` = 1 "), table_rows("purchases", ORIGINAL)],
  [sql_rule("subscriptions"), table_rows("subscriptions", { id: 7, user_id: 5, last_payment_option_id: 9, link_id: 3, seller_id: 4, cancelled_at: t("2025-03-01 00:00:00") })],
  [sql_rule("users", "= 5"), table_rows("users", { id: 5, email: "Member@Example.com", unconfirmed_email: "  " })],
  [sql_rule("users", "= 4"), table_rows("users", SELLER)],
  [sql_rule("links"), table_rows("links", PRODUCT)],
  [sql_rule("payment_options"), table_rows("payment_options", { id: 9, price_id: 11 })],
  [sql_rule("prices"), table_rows("prices", { id: 11, recurrence: "quarterly" })],
  [/\ASELECT `created_at` FROM `purchases` FORCE INDEX/, rows(["created_at"], [t("2025-04-02 03:04:05")])],
  sum_rule("refunds", "amount_cents", 300), sum_rule("refunds", "fee_cents", nil), sum_rule("refunds", "creator_tax_cents", 7),
  [sql_rule("licenses"), table_rows("licenses", { id: 30, purchase_id: 1, serial: "ABC-123", uses: 4 })],
  [/\ASELECT `base_variants`.`id`/, rows(["id"], [21], [22])],
  [/\ASELECT distinct link_id/, rows(["link_id"], [3], [8])],
  [/\Aselect distinct base_variant_id/, rows(["base_variant_id"], [21], [22], [23])],
  [sql_rule("affiliate_credits", "FALSE"), table_rows("affiliate_credits", { id: 40, purchase_id: 1, affiliate_user_id: 6, amount_cents: 200, fee_cents: 20, basis_points: 1000, created_at: t("2025-01-02"), updated_at: t("2025-01-02") })],
  [sql_rule("affiliate_credits", "TRUE"), table_rows("affiliate_credits", { id: 41, purchase_id: 1, affiliate_user_id: 9, amount_cents: 50, fee_cents: 5, is_direct_affiliate_credit: true, basis_points: 500, created_at: t("2025-01-02"), updated_at: t("2025-01-02") })],
  sum_rule("affiliate_partial_refunds", "amount_cents", 10), sum_rule("affiliate_partial_refunds", "fee_cents", 1),
)) { Purchase.find(1).as_indexed_json }

purchase_cases << run("recurring charge of a recommended, chargeback-reversed sale", script(
  [sql_rule("purchases", "`purchases`.`id` = 2 "), table_rows("purchases", ORIGINAL.merge(id: 2, flags: purchase_flags(:was_product_recommended, :chargeback_reversed), chargeback_date: t("2025-02-01 10:00:00"), country: "Germany", card_type: "visa", purchaser_id: nil, email: nil, stripe_refunded: true, preorder_id: 3))],
  [sql_rule("subscriptions"), table_rows("subscriptions", { id: 7, user_id: 5, last_payment_option_id: 9, link_id: 3, seller_id: 4, deactivated_at: t("2025-05-01 00:00:00") })],
  [sql_rule("purchases", "subscription_id"), table_rows("purchases", ORIGINAL)],
  [sql_rule("licenses", "= 1 "), table_rows("licenses", { id: 30, purchase_id: 1, serial: "ABC-123", uses: 4 })],
  [sql_rule("users", "= 4"), table_rows("users", SELLER)],
  [sql_rule("links"), table_rows("links", PRODUCT.merge(description: "  "))],
)) { Purchase.find(2).as_indexed_json }

purchase_cases << run("gift subscription whose member has no account", script(
  [sql_rule("purchases", "`purchases`.`id` = 3 "), table_rows("purchases", ORIGINAL.merge(id: 3, subscription_id: 8, flags: purchase_flags(:is_original_subscription_purchase, :is_gift_sender_purchase, :is_archived_original_subscription_purchase), referrer: "direct"))],
  [sql_rule("subscriptions"), table_rows("subscriptions", { id: 8, user_id: nil, last_payment_option_id: 10, link_id: 3, seller_id: 4 })],
  [sql_rule("purchases", "ORDER BY"), table_rows("purchases", ORIGINAL.merge(id: 3, subscription_id: 8, flags: purchase_flags(:is_original_subscription_purchase, :is_gift_sender_purchase)))],
  [sql_rule("gifts"), table_rows("gifts", { id: 50, gifter_purchase_id: 3, giftee_email: "Giftee@Example.ORG" })],
  [sql_rule("payment_options"), table_rows("payment_options", { id: 10, price_id: 12 })],
  [sql_rule("prices"), table_rows("prices", { id: 12, recurrence: "yearly" })],
  [sql_rule("users", "= 4"), table_rows("users", SELLER)],
  [sql_rule("links"), table_rows("links", PRODUCT)],
)) { Purchase.find(3).as_indexed_json }

purchase_cases << run("plain sale with no email", script(
  [sql_rule("purchases", "`purchases`.`id` = 4 "), table_rows("purchases", ORIGINAL.merge(id: 4, subscription_id: nil, flags: 0, email: nil, referrer: "not a url", card_type: nil, can_contact: nil, stripe_refunded: nil))],
  [sql_rule("users", "= 4"), table_rows("users", SELLER)],
  [sql_rule("users", "= 5"), table_rows("users", { id: 5, email: "b@example.com" })],
  [sql_rule("links"), table_rows("links", PRODUCT.merge(description: nil, taxonomy_id: nil))],
)) { Purchase.find(4).as_indexed_json }

purchase_cases << run("missing product", script(
  [sql_rule("purchases", "`purchases`.`id` = 5 "), table_rows("purchases", ORIGINAL.merge(id: 5, subscription_id: nil, flags: 0, link_id: 99))],
  [sql_rule("users", "= 4"), table_rows("users", SELLER)],
)) { Purchase.find(5).as_indexed_json }

purchase_cases << run("only some fields", script(
  [sql_rule("purchases", "`purchases`.`id` = 1 "), table_rows("purchases", ORIGINAL)],
  [sql_rule("subscriptions"), table_rows("subscriptions", { id: 7, user_id: 5, last_payment_option_id: 9, link_id: 3, seller_id: 4 })],
  [sql_rule("users", "= 5"), table_rows("users", { id: 5, email: "x@example.com", unconfirmed_email: "New@Example.com" })],
)) { Purchase.find(1).as_indexed_json(only: %w[email subscription_current_email subscription_current_email_domain variant_ids subscription_cancelled_at]) }
golden["purchase_documents"] = purchase_cases

INSTALLMENT = {
  id: 60, seller_id: 4, workflow_id: nil, name: "Hello <world>", message: "<p>Body &amp; more</p>", created_at: t("2025-01-01 00:00:00.5"),
  deleted_at: nil, published_at: t("2025-01-03 10:00:00"), flags: Installment.flag_mapping["flags"].values_at(:send_emails, :allow_comments, :DEPRECATED_stream_only).sum
}.freeze
golden["installment_documents"] = [
  run("installment", script([sql_rule("installments"), table_rows("installments", INSTALLMENT)])) { Installment.find(60).as_indexed_json },
  run("installment fields", script([sql_rule("installments"), table_rows("installments", INSTALLMENT)])) { Installment.find(60).as_indexed_json(only: %w[selected_flags name]) },
]

DETAILS = {
  "purchases" => [
    { "id" => 1, "product_id" => 3, "variant_ids" => [21], "price_cents" => 1000, "created_at" => "2025-01-02T03:04:05Z", "country" => "US", "subscription_cancelled" => false, "license_uses" => 2, "extra" => "dropped" },
    { "id" => 2, "product_id" => 8, "price_cents" => 0, "created_at" => "2025-01-03T03:04:05Z" },
  ],
  "follower" => { "id" => 70, "created_at" => "2025-01-01T00:00:00Z" },
  "affiliates" => [{ "id" => 80, "product_id" => 3, "created_at" => "2025-01-04T00:00:00Z", "other" => 1 }],
}.freeze
AUDIENCE_MEMBER = {
  id: 90, seller_id: 4, email: "fan@example.com", details: JSON.generate(DETAILS), created_at: t("2025-01-01"), updated_at: t("2025-01-05"),
  customer: true, follower: true, affiliate: false, min_paid_cents: 0, max_paid_cents: 1000, min_created_at: t("2025-01-01"), max_created_at: t("2025-01-04"),
  min_purchase_created_at: t("2025-01-02 03:04:05"), max_purchase_created_at: t("2025-01-03 03:04:05"), follower_created_at: t("2025-01-01"),
  min_affiliate_created_at: t("2025-01-04"), max_affiliate_created_at: t("2025-01-04")
}.freeze
golden["audience_member_documents"] = [
  run("audience member", script([sql_rule("audience_members"), table_rows("audience_members", AUDIENCE_MEMBER)])) { AudienceMember.find(90).as_indexed_json },
  run("audience member without details", script([sql_rule("audience_members"), table_rows("audience_members", AUDIENCE_MEMBER.merge(details: nil))])) { AudienceMember.find(90).as_indexed_json },
]

# --- jobs -----------------------------------------------------------------------------------------
def job(name, klass, args, responder = script, **options) = run(name, responder, args:, **options) { klass.new.perform(*args) }

PURCHASE_1 = script(
  [sql_rule("purchases", "`purchases`.`id` = 1 "), table_rows("purchases", ORIGINAL.merge(subscription_id: nil, flags: 0))],
  [sql_rule("users", "= 4"), table_rows("users", SELLER)],
  [sql_rule("users", "= 5"), table_rows("users", { id: 5, email: "b@example.com" })],
  [sql_rule("links"), table_rows("links", PRODUCT)],
  [/\ASELECT distinct link_id/, rows(["link_id"], [3])],
  [/\Aselect distinct base_variant_id/, rows(["base_variant_id"], [21])],
)
EVENT_BODY = { "follower_id" => 7, "followed_user_id" => 4, "follower_user_id" => nil, "email" => "f@example.com", "name" => "added", "timestamp" => "2025-11-01T00:00:00Z" }.freeze
UBQ_QUERY = { "bool" => { "filter" => [{ "term" => { "seller_id" => 4 } }, { "term" => { "email.raw" => "<b>@example.com" } }], "must_not" => [{ "term" => { "id" => 1 } }] } }.freeze
UBQ_PARAMS = { "source_record_id" => 1, "query" => UBQ_QUERY, "class_name" => "Purchase", "fields" => %w[product_ids_from_same_seller_purchased_by_purchaser variant_ids_from_same_seller_purchased_by_purchaser] }.freeze
def hits(*ids, scroll_id: "c2Nyb2xsPT0=") = [200, { "_scroll_id" => scroll_id, "hits" => { "hits" => ids.map { { "_id" => _1.to_s } } } }]
CONFLICT = [409, { "error" => { "type" => "version_conflict_engine_exception" }, "status" => 409 }].freeze

golden["jobs"] = {}
golden["jobs"]["ElasticsearchIndexerWorker"] = [
  job("index a purchase", ElasticsearchIndexerWorker, ["index", { "record_id" => 1, "class_name" => "Purchase" }], PURCHASE_1, es: [[201, { "result" => "created" }]]),
  job("update purchase fields on an index that ignores 404s", ElasticsearchIndexerWorker, ["update", { "record_id" => 1, "class_name" => "Purchase", "fields" => %w[email referrer_domain product_name] }], PURCHASE_1, ignore_404: %w[purchases other], es: [[404, { "error" => "document_missing_exception" }]]),
  job("update raises on a 404 elsewhere", ElasticsearchIndexerWorker, ["update", { "record_id" => 60, "class_name" => "Installment", "fields" => %w[name] }], script([sql_rule("installments"), table_rows("installments", INSTALLMENT)]), ignore_404: %w[purchases], es: [[404, { "error" => "document_missing_exception" }]]),
  job("delete ignores a missing document", ElasticsearchIndexerWorker, ["delete", { "record_id" => 60, "class_name" => "Installment" }], es: [[404, { "result" => "not_found" }]]),
  job("delete raises on a server error", ElasticsearchIndexerWorker, ["delete", { "record_id" => 60, "class_name" => "Installment" }], es: [[500, { "error" => "boom" }]]),
  job("index an audience member body the caller built", ElasticsearchIndexerWorker, ["index", { "record_id" => 90, "class_name" => "AudienceMember", "body" => { "seller_id" => 4, "email" => "x&y@example.com" } }]),
  job("index a confirmed follower event", ElasticsearchIndexerWorker, ["index", { "class_name" => "ConfirmedFollowerEvent", "id" => "00000000-0000-4000-8000-000000000001", "body" => EVENT_BODY }]),
  job("index a product page view", ElasticsearchIndexerWorker, ["index", { "class_name" => "ProductPageView", "id" => "pv1", "body" => { "product_id" => 3, "timestamp" => "2025-10-31T23:59:59Z", "url" => "https://example.com/l/abc?x=<1>" } }]),
  job("index an installment", ElasticsearchIndexerWorker, ["index", { "record_id" => 60, "class_name" => "Installment" }], script([sql_rule("installments"), table_rows("installments", INSTALLMENT)])),
  job("update an audience member", ElasticsearchIndexerWorker, ["update", { "record_id" => 90, "class_name" => "AudienceMember", "fields" => %w[purchases follower_id affiliates email] }], script([sql_rule("audience_members"), table_rows("audience_members", AUDIENCE_MEMBER)])),
  job("drops retired Balance jobs", ElasticsearchIndexerWorker, ["update", { "record_id" => 1, "class_name" => "Balance", "fields" => ["amount_cents"] }]),
  job("unknown operation does nothing", ElasticsearchIndexerWorker, ["reindex", { "record_id" => 1, "class_name" => "Purchase" }]),
  job("unknown class", ElasticsearchIndexerWorker, ["index", { "record_id" => 1, "class_name" => "Nope" }]),
  job("missing id", ElasticsearchIndexerWorker, ["delete", { "class_name" => "Purchase" }]),
  job("missing purchase keeps its retries", ElasticsearchIndexerWorker, ["update", { "record_id" => 77, "class_name" => "Purchase", "fields" => ["email"] }]),
  job("deleted audience member is done", ElasticsearchIndexerWorker, ["index", { "record_id" => 91, "class_name" => "AudienceMember" }]),
  job("audience member on a lagging replica retries", ElasticsearchIndexerWorker, ["update", { "record_id" => 91, "class_name" => "AudienceMember", "fields" => ["email"] }], script(["SELECT `audience_members`.*", rows([])], ["SELECT 1 AS one", rows(["one"], [1])])),
  job("update_by_query waits when delayed", ElasticsearchIndexerWorker, ["update_by_query", UBQ_PARAMS], features: [:esiw_delay_ubqs]),
  job("update_by_query", ElasticsearchIndexerWorker, ["update_by_query", UBQ_PARAMS], PURCHASE_1, es: [[200, { "updated" => 2 }]]),
  job("update_by_query scrolls after a conflict", ElasticsearchIndexerWorker, ["update_by_query", UBQ_PARAMS.merge("fields" => ["taxonomy_id"])], PURCHASE_1,
      es: [CONFLICT, hits(*1..100), CONFLICT, [200, {}], hits(101, 102, scroll_id: "c2Vjb25k"), [200, {}], [200, {}]]),
  job("update_by_query with nothing to scroll", ElasticsearchIndexerWorker, ["update_by_query", UBQ_PARAMS.merge("fields" => ["taxonomy_id"])], PURCHASE_1, es: [CONFLICT, hits, [200, {}]]),
  job("update_by_query gives up after ten conflicts", ElasticsearchIndexerWorker, ["update_by_query", UBQ_PARAMS.merge("fields" => ["taxonomy_id"])], PURCHASE_1, es: [CONFLICT, hits(5), *Array.new(10) { CONFLICT }]),
  job("update_by_query refuses nested fields", ElasticsearchIndexerWorker, ["update_by_query", UBQ_PARAMS.merge("fields" => %w[taxonomy_id a.b])], PURCHASE_1),
  job("update_by_query raises other errors", ElasticsearchIndexerWorker, ["update_by_query", UBQ_PARAMS.merge("fields" => ["taxonomy_id"])], PURCHASE_1, es: [[400, { "error" => "parsing_exception" }]]),
]

# --- pure helpers ---------------------------------------------------------------------------------
REFERRERS = [
  nil, "", "  ", "direct", "https://www.google.com/x", "http://WWW.Example.COM:8080/a?b#c", "https://t.co", "google.com", "//cdn.example.com/x",
  "https://user:pw@sub.example.co.uk/p", "http://[::1]:3000/", "http://192.168.0.1/", "https://ex ample.com/ x", "https://%65xample.com",
  "https://exämple.com/", "https://www./", "android-app://com.google.android.gm/", "mailto:a@example.com", "javascript:alert(1)",
  "https://example.com/%zz", "http://a_b.example.com", "ftp://files.example.com/a;type=a", "ldap://ldap.example.com/dc=x?a?b?c",
  "https://example.com/path with spaces", "HTTPS://WWW.EXAMPLE.COM", "https://www.", "https://", "http://exa%20mple.com/",
  "https://example.com:abc/", "https://[v1.fe]/", "https://example.com/é ", "file:///etc/passwd", "https://xn--bcher-kva.example/",
]
golden["referrer_domains"] = REFERRERS.map do |url|
  [url, begin
    Referrer.extract_domain(url)
  rescue StandardError => e
    { "error" => e.class.name, "message" => e.message }
  end]
end

DESCRIPTIONS = [
  nil, "", "   ", "plain text", "<p>One</p><p>Two</p>", "<h2>What you get</h2><p>A 25-page guide</p>", "Fish &amp; Chips &lt;3 &nbsp;x",
  "a<br>b<br/>c", "<ul><li>one</li><li>two</li></ul>", "<div>a<span>b</span>c</div>d", "<!-- c -->text<!-- d -->",
  "<table><tr><td>a</td><td>b</td></tr></table>", "<script>var x = 1;</script>after", "<style>p{}</style>styled",
  "&copy; 2025 &mdash; &hellip; &#169; &#x1F600;", "line\nbreak\ttab", "<p>unclosed <b>bold", "&unknown; &amp",
  "<pre>  keep   spaces  </pre>", "&#150;|&#0;|&#xD800;|&#12345678;|&#x41|&AMP;|&amp;amp;|&a.b;|&;|& x|&#;|&#x;|&#abc|&lang;|&check;|&apos;",
  "<script>a &amp; b</script>|<style>&lt;</style>|<textarea>&lt;x&gt;</textarea>|<title>&amp;</title>", "<noscript><p>ns</p></noscript>",
  "\uE000 sentinel &amp; \uE001", "&#x1F600;&#128512;&#x10FFFF;&#x110000;", "<p>&nbsp;</p>", "a&nbsp;&nbsp;b", "<blockquote>q</blockquote><figure><figcaption>cap</figcaption></figure>",
  "text with nbsp", "<p>a</p>\n\n\n<p>b</p>", "<h1>T</h1>text<hr>more", "<a href=\"x\">link</a> and <img src=x alt=y> image",
]
golden["plaintext_descriptions"] = DESCRIPTIONS.map { |d| [d, Link.new(description: d).plaintext_description] }
# Every name libxml2's html40EntitiesTable decodes, for plaintext.ts.
HTML4_NAMES = %w[quot amp apos lt gt nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml OElig oelig Scaron scaron Yuml fnof circ tilde Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho Sigma Tau Upsilon Phi Chi Psi Omega alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigmaf sigma tau upsilon phi chi psi omega thetasym upsih piv ensp emsp thinsp zwnj zwj lrm rlm ndash mdash lsquo rsquo sbquo ldquo rdquo bdquo dagger Dagger bull hellip permil prime Prime lsaquo rsaquo oline frasl euro image weierp real trade alefsym larr uarr rarr darr harr crarr lArr uArr rArr dArr hArr forall part exist empty nabla isin notin ni prod sum minus lowast radic prop infin ang and or cap cup int there4 sim cong asymp ne equiv le ge sub sup nsub sube supe oplus otimes perp sdot lceil rceil lfloor rfloor lang rang loz spades clubs hearts diams]
entities = HTML4_NAMES.to_h { |name| [name, Nokogiri::HTML4::NamedCharacters.get(name)&.value || raise("libxml2 does not know &#{name};")] }
File.write(File.join(__dir__, "../html4-entities.generated.ts"), <<~TS)
  // Generated by __fixtures__/generate-search-golden.rb from Nokogiri::HTML4::NamedCharacters
  // (libxml2 #{Nokogiri::VERSION_INFO.dig("libxml", "loaded")}): the entity names its HTML parser decodes. Do not edit.
  export const HTML4_ENTITIES: Readonly<Record<string, number>> = {
  #{entities.map { |name, value| "  #{name}: #{value}," }.join("\n")}
  };
TS
golden["html4_entity_count"] = entities.size
golden["nokogiri_libxml"] = Nokogiri::VERSION_INFO.dig("libxml", "loaded")

File.write(File.join(__dir__, "search.golden.json"), JSON.pretty_generate(golden) + "\n")
puts "wrote search.golden.json"

