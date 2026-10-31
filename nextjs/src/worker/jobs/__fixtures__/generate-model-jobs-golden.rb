# frozen_string_literal: true

# Produces model-jobs.golden.json: runs the real job files and the real models they write
# (app/models/*.rb, loaded as-is) on ActiveRecord 8.1's own Mysql2Adapter, with only the mysql2
# driver faked (fake_mysql.rb). Each case records every statement ActiveRecord sent, the scripted
# answer it got, and the Redis state the real sidekiq/sidekiq-unique-jobs gems left in a scratch DB.
#
# The gem sets are the WS-02 and WS-05 golden scripts'; bigdecimal is pinned to Gemfile.lock, as
# BuildTaxRateCacheWorker writes BigDecimal#to_s (ActiveSupport's override) to Redis.
#
#   G=<scratchpad>; GEM_HOME=$G/gemhome GEM_PATH=$G/gemhome:$G/ws05-gems:$G/bd331 \
#     REDIS_URL=redis://127.0.0.1:6379/12 ruby generate-model-jobs-golden.rb
#
# Neighbour models a job only reads (User, Purchase, UrlRedirect, ProductFile, WishlistProduct) are
# bare classes over their tables: their own callbacks never run on these paths.
gem "bigdecimal", "3.3.1"
gem "connection_pool", "2.5.5"
gem "json", "2.13.2"
gem "activerecord", "8.1.3.1"
gem "sidekiq", "7.3.4"
gem "sidekiq-unique-jobs", "8.0.10"
ENV["TZ"] = "UTC"
require "json"
require "logger"
require "pathname"
require "yaml"
require "active_record"
require "active_support/all"
require "flag_shih_tzu"
require "sidekiq"
require "sidekiq_unique_jobs"
require "fugit"
require_relative "fake_mysql"

ROOT = File.expand_path("../../../../..", __dir__)
REDIS_URL = ENV.fetch("REDIS_URL", "redis://127.0.0.1:6379/12")
abort "Refusing to run against db 0" unless REDIS_URL.match?(%r{/\d+\z}) && !REDIS_URL.end_with?("/0")

# --- clock, ids ----------------------------------------------------------------------------------
# Whole milliseconds: JavaScript dates carry no microseconds (see models/README.md).
FIXED_NOW = Time.at(1_761_955_200, 123_000, :usec).utc
class Time
  class << self
    def now(...) = FIXED_NOW
  end
end
class Date
  class << self
    def today(...) = FIXED_NOW.to_date
  end
end
$jid_seq = 0
$uuid_seq = 0
module SecureRandom
  def self.hex(n = nil)
    return super unless n == 12
    $jid_seq += 1
    format("%024x", $jid_seq)
  end

  def self.uuid
    $uuid_seq += 1
    format("00000000-0000-4000-8000-%012d", $uuid_seq)
  end
end

# --- Rails surface the models touch --------------------------------------------------------------
module Rails
  def self.root = Pathname(ROOT)
  def self.logger = (@logger ||= Logger.new(nil))
  def self.env = ActiveSupport::StringInquirer.new("test")
end
ActiveRecord.default_timezone = :utc
Time.zone_default = Time.find_zone!("UTC")
Time.zone = "UTC"
# What load_defaults 8.1, config/application.rb and new_framework_defaults_7_1.rb leave set.
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
# A non-numeric column default needs a SHOW CREATE TABLE to tell a literal from a function; they
# are all literals in the tables used here.
ActiveRecord::ConnectionAdapters::Mysql2Adapter.class_eval { private def default_type(*) = :literal }

S3_BASE_URL = "https://s3.amazonaws.com/gumroad-specs/"
S3_BUCKET = "gumroad-specs"

module ReplicaLagWatcher
  def self.watch = FakeMysql.log << { "sql" => "-- ReplicaLagWatcher.watch" }
end

# after_commit_everywhere 1.4: runs after the outermost transaction commits, or at once outside one.
module AfterCommitEverywhere
  def self.after_commit(&) = ActiveRecord.after_all_transactions_commit(&)
end

Sidekiq.configure_client do |config|
  config.redis = { url: REDIS_URL }
  config.client_middleware { |chain| chain.add SidekiqUniqueJobs::Middleware::Client }
end
Sidekiq.default_job_options = { "backtrace" => true, "retry" => 25 }

def load_app(path) = load(File.join(ROOT, path))

%w[app/modules/deletable.rb app/modules/cdn_deletable.rb app/modules/external_id.rb app/modules/timestamp_scopes.rb
   app/modules/s3_retrievable.rb app/models/concerns/json_data.rb app/models/concerns/recurring_lock_ttl.rb].each { load_app(_1) }

class ApplicationRecord < ActiveRecord::Base
  self.abstract_class = true
end
class User < ApplicationRecord
  has_many :sales, class_name: "Purchase", foreign_key: :seller_id
end
class Purchase < ApplicationRecord; end
class Link < ApplicationRecord; end
class Community < ApplicationRecord; end
class UrlRedirect < ApplicationRecord; end
class ProductFile < ApplicationRecord; end
class Installment < ApplicationRecord; end
class Cart < ApplicationRecord; end
class Credit < ApplicationRecord; end
class BacktaxCollection < ApplicationRecord; end
class LastReadCommunityChatMessage < ApplicationRecord; end
class InstallmentEvent < ApplicationRecord; end
class WishlistProduct < ApplicationRecord
  include Deletable
end
module CurrencyHelper; end
class Wishlist < ApplicationRecord; end
load_app("app/models/concerns/wishlist/structured_data.rb")
module Radar; end

%w[platform_block community_chat_recap_run community_chat_recap community_chat_message large_seller stamped_pdf
   wishlist wishlist_follower workflow_installment_schedule_intent backtax_agreement
   sent_abandoned_cart_email zip_tax_rate event product_cached_value ping_delivery sent_email_info processed_stripe_event].each { load_app("app/models/#{_1}.rb") }
load_app("app/services/radar/value_list_sync_service.rb")
load_app("app/services/adult_keyword_detector.rb")

# Jobs the ported jobs enqueue, with only their sidekiq options: their bodies never run here.
def stub_job(class_name, path)
  options = File.read(File.join(ROOT, path)).lines.grep(/\A\s*(sidekiq_options|include RecurringLockTtl|recurring_lock_ttl)\b/)
  namespace, name = class_name.include?("::") ? [Object.const_get(class_name.split("::").first), class_name.split("::").last] : [Object, class_name]
  namespace.const_set(name, Class.new { include Sidekiq::Job })
  Object.const_get(class_name).class_eval(options.join)
end
stub_job("Radar::AddValueListItemJob", "app/sidekiq/radar/add_value_list_item_job.rb")
stub_job("Radar::RemoveValueListItemJob", "app/sidekiq/radar/remove_value_list_item_job.rb")
stub_job("RecoverAusBacktaxFromStripeAccountJob", "app/sidekiq/recover_aus_backtax_from_stripe_account_job.rb")
stub_job("InternalNotificationWorker", "app/sidekiq/internal_notification_worker.rb")
stub_job("ScheduleWorkflowInstallmentJob", "app/sidekiq/schedule_workflow_installment_job.rb")
stub_job("GenerateCommunityChatRecapJob", "app/sidekiq/generate_community_chat_recap_job.rb")
stub_job("SendCommunityChatRecapNotificationsJob", "app/sidekiq/send_community_chat_recap_notifications_job.rb")

# Records what BuildTaxRateCacheWorker hands to Redis::Namespace#set. redis-rb 5's #set sends
# `value.to_s`, so that is what reaches Redis.
module Redis
  class Namespace
    def self.writes = ($namespace_writes ||= [])
    def initialize(namespace, redis:) = @namespace = namespace
    def set(key, value) = Namespace.writes << ["#{@namespace}:#{key}", value.to_s]
  end
end
$redis = nil

%w[delete_old_sent_email_info_records_job delete_old_ping_deliveries_job delete_old_processed_stripe_events_job
   delete_processed_workflow_installment_schedule_intents_job delete_expired_product_cached_values_worker
   delete_old_unused_events_worker recover_aus_backtaxes_from_stripe_accounts_job alert_on_stalled_abandoned_cart_emails_job
   build_tax_rate_cache_worker block_object_worker block_email_domains_worker unblock_object_worker
   force_finish_long_running_community_chat_recap_runs_job trigger_community_chat_recap_run_job
   update_large_sellers_sales_count_job expire_stamped_pdfs_job recalculate_recent_wishlist_follower_count_job
   dispatch_pending_workflow_installment_schedule_intents_job].each { load_app("app/sidekiq/#{_1}.rb") }

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

def rows(fields, *rows) = FakeMysql::Rows.new(fields, rows)
def write(affected) = FakeMysql::Write.new(affected)
def dup_key(sql) = FakeMysqlFailure.new(1062, "Duplicate entry for key '#{sql[/INTO `([^`]+)`/, 1]}'")

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

def run(name, klass, args, responder)
  redis { |conn| conn.call("FLUSHDB") }
  $jid_seq = 0
  $uuid_seq = 0
  Redis::Namespace.writes.clear
  error = nil
  statements = FakeMysql.run(responder) do
    klass.new.perform(*args)
  rescue StandardError => e
    error = { "class" => e.class.name, "message" => e.message }
  end
  { "name" => name, "args" => args, "error" => error, "statements" => statements, "redis" => snapshot, "namespace_writes" => Redis::Namespace.writes.dup }
end

t = ->(string) { Time.utc(*string.scan(/\d+/).map(&:to_i)) }
d = ->(string) { BigDecimal(string) }

cases = {}

# --- deletions ------------------------------------------------------------------------------------
cases["DeleteOldSentEmailInfoRecordsJob"] = [
  run("empty table", DeleteOldSentEmailInfoRecordsJob, [], script(["SELECT 1 AS one", rows(["one"])])),
  run("deletes until a batch comes back empty", DeleteOldSentEmailInfoRecordsJob, [], script(["SELECT 1 AS one", rows(["one"], [1])], ["DELETE", [write(100), write(100), write(3), write(0)]])),
]
cases["DeleteOldPingDeliveriesJob"] = [
  run("nothing old", DeleteOldPingDeliveriesJob, [], script(["SELECT 1 AS one", rows(["one"])])),
  run("deletes until a batch comes back empty", DeleteOldPingDeliveriesJob, [], script(["SELECT 1 AS one", rows(["one"], [1])], ["DELETE", [write(1000), write(12), write(0)]])),
]
cases["DeleteOldProcessedStripeEventsJob"] = [
  run("nothing old", DeleteOldProcessedStripeEventsJob, [], script(["SELECT 1 AS one", rows(["one"])])),
  run("deletes until a batch comes back empty", DeleteOldProcessedStripeEventsJob, [], script(["SELECT 1 AS one", rows(["one"], [1])], ["DELETE", [write(100), write(0)]])),
]
cases["DeleteProcessedWorkflowInstallmentScheduleIntentsJob"] = [
  run("nothing processed long ago", DeleteProcessedWorkflowInstallmentScheduleIntentsJob, [], script()),
  run("deletes each batch of ids", DeleteProcessedWorkflowInstallmentScheduleIntentsJob, [], script(
    [/\ASELECT `workflow_installment_schedule_intents`.`id`/, [rows(["id"], *(1..1000).map { [_1] }), rows(["id"], [1005], [1007])]],
    ["DELETE", [write(1000), write(2)]],
  )),
]
cases["DeleteExpiredProductCachedValuesWorker"] = [
  run("nothing expired", DeleteExpiredProductCachedValuesWorker, [], script()),
  run("keeps the newest row per product", DeleteExpiredProductCachedValuesWorker, [], script(
    [/\ASELECT `product_cached_values`.`id` FROM/, [rows(["id"], [3], [9]), rows(["id"])]],
    [/\ASELECT DISTINCT/, rows(["product_id"], [10], [20])],
    [/\ASELECT MAX/, rows(%w[maximum_id product_cached_values_product_id], [11, 10], [25, 20])],
    ["DELETE", [write(100), write(40)]],
  )),
  run("walks the next group of products after a full batch", DeleteExpiredProductCachedValuesWorker, [], script(
    [/\ASELECT `product_cached_values`.`id` FROM/, [rows(["id"], *(1..200).map { [_1 * 2] }), rows(["id"], [401])]],
    [/\ASELECT DISTINCT/, [rows(["product_id"], [10]), rows(["product_id"], [30])]],
    [/\ASELECT MAX/, [rows(%w[maximum_id product_cached_values_product_id], [500, 10]), rows(%w[maximum_id product_cached_values_product_id], [600, 30])]],
    ["DELETE", [write(3), write(100), write(100), write(0)]],
  )),
]
event_rows = [[50, "purchase"], [51, "link_view"], [52, "post_view"], [53, "i_want_this"]]
cases["DeleteOldUnusedEventsWorker"] = [
  run("no events in the window", DeleteOldUnusedEventsWorker, [], script([/created_at >=/, rows(%w[id])], [/created_at <=/, rows(%w[id], [60])])),
  run("deletes events that are not permitted", DeleteOldUnusedEventsWorker, [], script(
    [/created_at >=/, rows(%w[id], [50])],
    [/created_at <=/, rows(%w[id], [53])],
    [/\ASELECT `events`.`id`, `events`.`event_name`/, [rows(%w[id event_name], *event_rows)]],
  )),
  run("skips the delete when every event is permitted", DeleteOldUnusedEventsWorker, [], script(
    [/created_at >=/, rows(%w[id], [50])],
    [/created_at <=/, rows(%w[id], [52])],
    [/\ASELECT `events`.`id`, `events`.`event_name`/, [rows(%w[id event_name], [50, "purchase"], [52, "post_view"])]],
  )),
  run("walks the id range in batches of 100", DeleteOldUnusedEventsWorker, [], script(
    [/created_at >=/, rows(%w[id], [1])],
    [/created_at <=/, rows(%w[id], [150])],
    [/\ASELECT `events`.`id`, `events`.`event_name`/, [rows(%w[id event_name], *(1..100).map { [_1, _1.even? ? "purchase" : nil] }), rows(%w[id event_name], [101, "link_view"], [150, "refund"])]],
  )),
]

# --- enqueue-only ---------------------------------------------------------------------------------
cases["RecoverAusBacktaxesFromStripeAccountsJob"] = [
  run("one job per distinct seller", RecoverAusBacktaxesFromStripeAccountsJob, [], script(["SELECT", rows(["user_id"], [7], [3], [7])])),
  run("no agreements", RecoverAusBacktaxesFromStripeAccountsJob, [], script()),
]
cases["AlertOnStalledAbandonedCartEmailsJob"] = [
  run("never sent", AlertOnStalledAbandonedCartEmailsJob, [], script(["SELECT", rows(["created_at"])])),
  run("sent recently", AlertOnStalledAbandonedCartEmailsJob, [], script(["SELECT", rows(["created_at"], [t["2025-10-31 06:00:00"]])])),
  run("stalled", AlertOnStalledAbandonedCartEmailsJob, [], script(["SELECT", rows(["created_at"], [t["2025-10-29 21:30:15"]])])),
  run("exactly at the threshold", AlertOnStalledAbandonedCartEmailsJob, [], script(["SELECT", rows(["created_at"], [FIXED_NOW - 24.hours])])),
]
cases["BuildTaxRateCacheWorker"] = [
  run("caches each state's highest rate", BuildTaxRateCacheWorker, [], script(["SELECT", rows(%w[maximum_combined_rate zip_tax_rates_state],
    [d["0.0725"], "CA"], [d["0.1"], "NY"], [d["0"], "OR"], [d["1.5"], "XX"], [nil, "NV"], [d["0.0000001"], "TX"])])),
]

# --- PlatformBlock ----------------------------------------------------------------------------------
block_row = ->(id, type, value, blocked_at = nil) { rows(%w[id object_type object_value blocked_at expires_at blocked_by created_at updated_at], [id, type, value, blocked_at, nil, nil, t["2025-01-01"], t["2025-01-01"]]) }
cases["BlockObjectWorker"] = [
  run("new email block", BlockObjectWorker, ["email", "buyer@example.com", 9], script()),
  run("existing email block", BlockObjectWorker, ["email", "buyer@example.com", 9], script(["INSERT", ->(sql) { dup_key(sql) }], ["SELECT", block_row.(5, "email", "buyer@example.com")])),
  run("already blocked keeps blocked_at moving", BlockObjectWorker, ["charge_processor_fingerprint", "fp_1", nil], script(["INSERT", ->(sql) { dup_key(sql) }], ["SELECT", block_row.(6, "charge_processor_fingerprint", "fp_1", t["2025-02-01"])])),
  run("ip address with an expiry", BlockObjectWorker, ["ip_address", "10.0.0.1", 9, 15_552_000], script()),
  run("ip address without an expiry", BlockObjectWorker, ["ip_address", "10.0.0.1", 9], script()),
  run("unknown type", BlockObjectWorker, ["nonsense", "x", 9], script()),
  run("browser guid", BlockObjectWorker, ["browser_guid", "guid-1", 9, 3600], script()),
]
cases["BlockEmailDomainsWorker"] = [
  run("each domain", BlockEmailDomainsWorker, [9, ["example.com", "example.org"]], script()),
  run("no domains", BlockEmailDomainsWorker, [9, []], script()),
]
cases["UnblockObjectWorker"] = [
  run("unblocks every type for the value", UnblockObjectWorker, ["buyer@example.com"], script(
    [/\ASELECT `platform_blocks`/, [rows(%w[id object_type object_value blocked_at expires_at blocked_by created_at updated_at],
      [5, "email", "buyer@example.com", t["2025-02-01"], t["2026-02-01"], 9, t["2025-01-01"], t["2025-01-01"]],
      [8, "email_domain", "buyer@example.com", nil, nil, nil, t["2025-01-01"], t["2025-01-01"]])]],
  )),
  run("nothing blocked", UnblockObjectWorker, ["x"], script()),
]

# --- community chat recaps ------------------------------------------------------------------------
run_fields = %w[id recap_frequency from_date to_date recaps_count finished_at notified_at created_at updated_at]
recap_fields = %w[id community_chat_recap_run_id community_id seller_id summarized_message_count summary status error_message input_token_count output_token_count created_at updated_at]
cases["ForceFinishLongRunningCommunityChatRecapRunsJob"] = [
  run("nothing running", ForceFinishLongRunningCommunityChatRecapRunsJob, [], script()),
  run("fails pending recaps and finishes the run", ForceFinishLongRunningCommunityChatRecapRunsJob, [], script(
    [/\ASELECT `community_chat_recap_runs`.\*/, [rows(run_fields,
      [4, "daily", t["2025-10-25"], t["2025-10-25 23:59:59.999999"], 2, nil, nil, t["2025-10-26"], t["2025-10-26"]],
      [5, "weekly", t["2025-10-19"], t["2025-10-25 23:59:59.999999"], 0, nil, t["2025-10-26 01:00:00"], t["2025-10-26"], t["2025-10-26"]])]],
    [/\ASELECT `community_chat_recaps`.\*/, [rows(recap_fields, [40, 4, 1, nil, 0, nil, "pending", nil, 0, 0, t["2025-10-26"], t["2025-10-26"]]), rows(recap_fields)]],
    [/\ASELECT 1 AS one FROM `community_chat_recap_runs`/, rows(["one"])],
  )),
]
cases["TriggerCommunityChatRecapRunJob"] = [
  run("rejects an unknown frequency", TriggerCommunityChatRecapRunJob, ["monthly"], script()),
  run("daily run already exists", TriggerCommunityChatRecapRunJob, ["daily"], script([/\ASELECT `community_chat_recap_runs`/, rows(run_fields, [4, "daily", t["2025-10-31"], t["2025-10-31 23:59:59.999999"], 0, nil, nil, t["2025-11-01"], t["2025-11-01"]])])),
  run("daily with communities", TriggerCommunityChatRecapRunJob, ["daily"], script([/\ASELECT `community_chat_messages`.`community_id`/, rows(["community_id"], [3], [1], [3])])),
  run("daily without messages finishes at once", TriggerCommunityChatRecapRunJob, ["daily"], script()),
  run("weekly from a given date", TriggerCommunityChatRecapRunJob, ["weekly", "2025-10-18"], script([/\ASELECT `community_chat_messages`.`community_id`/, rows(["community_id"], [2])])),
  run("weekly default window", TriggerCommunityChatRecapRunJob, ["weekly"], script()),
  run("a Saturday daily run with no messages chains the weekly run", TriggerCommunityChatRecapRunJob, ["daily", "2025-10-25"], script()),
  run("blank date means the default", TriggerCommunityChatRecapRunJob, ["daily", ""], script()),
]

# --- other model writes ---------------------------------------------------------------------------
seller_fields = %w[id user_id sales_count created_at updated_at]
cases["UpdateLargeSellersSalesCountJob"] = [
  run("updates changed counts and skips missing users", UpdateLargeSellersSalesCountJob, [], script(
    [/\ASELECT `large_sellers`/, [rows(seller_fields, [1, 10, 1500, t["2025-01-01"], t["2025-01-01"]], [2, 11, 2000, t["2025-01-01"], t["2025-01-01"]], [3, 12, 900, t["2025-01-01"], t["2025-01-01"]])]],
    [/\ASELECT `users`.\* FROM `users` WHERE `users`.`id` = 10/, rows(%w[id], [10])],
    [/\ASELECT `users`.\* FROM `users` WHERE `users`.`id` = 11/, rows(%w[id])],
    [/\ASELECT `users`.\* FROM `users` WHERE `users`.`id` = 12/, rows(%w[id], [12])],
    [/\ASELECT COUNT\(\*\) FROM `purchases` WHERE `purchases`.`seller_id` = 10/, rows(["COUNT(*)"], [1600])],
    [/\ASELECT COUNT\(\*\) FROM `purchases` WHERE `purchases`.`seller_id` = 12/, rows(["COUNT(*)"], [900])],
  )),
]
pdf_fields = %w[id url_redirect_id product_file_id url created_at updated_at deleted_at deleted_from_cdn_at]
cases["ExpireStampedPdfsJob"] = [
  run("marks old stamped PDFs deleted, batch by batch", ExpireStampedPdfsJob, [], script(
    [/\ASELECT `stamped_pdfs`/, [rows(pdf_fields, [1, 70, 80, "https://s3.amazonaws.com/gumroad-specs/a.pdf", t["2025-06-01"], t["2025-06-01"], nil, nil], [2, 71, 81, "https://s3.amazonaws.com/gumroad-specs/b.pdf", t["2025-06-02"], t["2025-06-02"], nil, nil]), rows(pdf_fields)]],
    [/\ASELECT `url_redirects`/, rows(%w[id], [70], [71])],
    [/\ASELECT `product_files`/, rows(%w[id], [80], [81])],
  )),
  run("a stamped PDF whose product file is gone fails validation", ExpireStampedPdfsJob, [], script(
    [/\ASELECT `stamped_pdfs`/, [rows(pdf_fields, [3, 72, 82, "https://s3.amazonaws.com/gumroad-specs/c.pdf", t["2025-06-01"], t["2025-06-01"], nil, nil])]],
    [/\ASELECT `url_redirects`/, rows(%w[id], [72])],
    [/\ASELECT `product_files`/, rows(%w[id])],
  )),
]
wishlist_fields = %w[id user_id name deleted_at created_at updated_at followers_last_contacted_at description flags recommendable follower_count recent_follower_count]
cases["RecalculateRecentWishlistFollowerCountJob"] = [
  run("sets each wishlist's recent follower count", RecalculateRecentWishlistFollowerCountJob, [], script(
    [/\ASELECT `wishlists`/, [rows(wishlist_fields,
      [1, 7, "Wishlist 1", nil, t["2025-01-01"], t["2025-01-01"], nil, nil, 0, 0, 3, 0],
      [2, 7, "Cool stuff", nil, t["2025-01-01"], t["2025-01-01"], nil, "Gifts", 0, 1, 3, 2],
      [3, 8, "Opted out", nil, t["2025-01-01"], t["2025-01-01"], nil, nil, 1, 0, 3, 5],
      [4, 8, "Lewd things", nil, t["2025-01-01"], t["2025-01-01"], nil, "Nice", 0, 0, 0, 0],
      [5, 9, "Brand new", nil, t["2025-01-01"], t["2025-01-01"], nil, "Some NSFW-Art", 0, 1, 1, 1])]],
    [/\ASELECT COUNT\(\*\)/, rows(%w[count_all wishlist_followers_wishlist_id], [2, 2], [4, 3], [1, 5])],
    [/\ASELECT `users`.\* FROM `users` WHERE `users`.`id` = (7|8)\b/, rows(%w[id], [7])],
    [/\ASELECT 1 AS one FROM `wishlist_products` WHERE `wishlist_products`.`wishlist_id` = 2/, rows(["one"], [1])],
    [/\ASELECT 1 AS one FROM `wishlist_products` WHERE `wishlist_products`.`wishlist_id` = 5/, rows(["one"], [1])],
  )),
]
intent_fields = %w[id token installment_id rule_version old_delayed_delivery_time cutoff_reference_time expected_published_at dispatch_token dispatch_expires_at fanout_token fanout_expires_at processed_at created_at updated_at]
intent = ->(id, token) { [id, token, 100 + id, 1, nil, t["2025-10-30"], nil, nil, nil, nil, nil, nil, t["2025-10-30"], t["2025-10-30"]] }
cases["DispatchPendingWorkflowInstallmentScheduleIntentsJob"] = [
  run("claims and enqueues each dispatchable intent", DispatchPendingWorkflowInstallmentScheduleIntentsJob, [], script(
    [/\ASELECT `workflow_installment_schedule_intents`.\* FROM `workflow_installment_schedule_intents` WHERE .* ORDER BY/, [rows(intent_fields, intent.(1, "tok-1"), intent.(2, "tok-2"), intent.(3, "tok-3"))]],
    [/FOR UPDATE\z/, [rows(intent_fields, intent.(1, "tok-1")), rows(intent_fields), rows(intent_fields, intent.(3, "tok-3"))]],
  )),
  run("a claim that fails is logged and skipped", DispatchPendingWorkflowInstallmentScheduleIntentsJob, [], script(
    [/\ASELECT `workflow_installment_schedule_intents`.\* FROM `workflow_installment_schedule_intents` WHERE .* ORDER BY/, [rows(intent_fields, intent.(1, "tok-1"), intent.(2, "tok-2"))]],
    [/FOR UPDATE\z/, [rows(intent_fields, intent.(1, "tok-1")), rows(intent_fields, intent.(2, "tok-2"))]],
    ["UPDATE", [FakeMysqlFailure.new(1205, "Lock wait timeout exceeded; try restarting transaction"), nil]],
  )),
  begin
    # perform_async returns nil when a client middleware drops the push.
    ScheduleWorkflowInstallmentJob.singleton_class.define_method(:perform_async) { |*| nil }
    run("an enqueue that is dropped releases the claim", DispatchPendingWorkflowInstallmentScheduleIntentsJob, [], script(
      [/\ASELECT `workflow_installment_schedule_intents`.\* FROM `workflow_installment_schedule_intents` WHERE .* ORDER BY/, [rows(intent_fields, intent.(1, "tok-1"))]],
      [/FOR UPDATE\z/, [rows(intent_fields, intent.(1, "tok-1"))]],
    ))
  ensure
    ScheduleWorkflowInstallmentJob.singleton_class.remove_method(:perform_async)
  end,
]

redis { |conn| conn.call("FLUSHDB") }

# BigDecimal#to_s and the AdultKeywordDetector are pure; record them directly.
decimals = %w[0 0.0725 0.1 1.5 0.0000001 1 10 123.456 -0.5 0.00001 100000000 1.23e-20 7.25]
adult_texts = ["Lewd things", "Some NSFW-Art", "nsfw", "NSFWArt", "Gifts", "kinky", "Kink", "BreastInflation", "breast inflation", "ABDL", "joi", "Joint", "pin-up", "Ahegao!", "", nil, "Ünïcode lewd", "FutaMilking", "fetish123"]
golden = {
  "generated_with" => { "ruby" => RUBY_VERSION, "activerecord" => ActiveRecord.version.to_s, "sidekiq" => Sidekiq::VERSION, "sidekiq_unique_jobs" => SidekiqUniqueJobs::VERSION },
  "now" => FIXED_NOW.to_f,
  "jobs" => cases,
  "big_decimal_to_s" => decimals.map { [_1, BigDecimal(_1).to_s] },
  "adult_keyword_detector" => adult_texts.map { [_1, AdultKeywordDetector.adult?(_1)] },
}
File.write(File.join(__dir__, "model-jobs.golden.json"), JSON.pretty_generate(golden) + "\n")
puts "wrote #{File.join(__dir__, "model-jobs.golden.json")}"
