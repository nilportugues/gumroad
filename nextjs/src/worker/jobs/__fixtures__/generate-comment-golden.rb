# frozen_string_literal: true

# Produces comment.golden.json: the real app/models/comment.rb (with Deletable, JsonData, ancestry
# 4.3.3 and paper_trail 17) and the jobs that write comments, on ActiveRecord 8.1's own
# Mysql2Adapter with only the driver faked (fake_mysql.rb), as generate-model-jobs-golden.rb does.
#
#   G=<scratchpad>; GEM_HOME=$G/gemhome GEM_PATH=$G/gemhome:$G/ws05-gems:$G/bd331:$G/ws32-gems \
#     REDIS_URL=redis://127.0.0.1:6379/8 ruby generate-comment-golden.rb
#
# ws32-gems holds ancestry 4.3.3 (Gemfile.lock). Neighbour models are bare classes over their tables.
gem "bigdecimal", "3.3.1"
gem "connection_pool", "2.5.5"
gem "json", "2.13.2"
gem "activerecord", "8.1.3.1"
gem "sidekiq", "7.3.4"
gem "sidekiq-unique-jobs", "8.0.10"
gem "paper_trail", "17.0.0"
gem "ancestry", "4.3.3"
ENV["TZ"] = "UTC"
require "json"
require "logger"
require "pathname"
require "active_record"
require "active_support/all"
require "flag_shih_tzu"
require "sidekiq"
require "sidekiq_unique_jobs"
require "fugit"
require "paper_trail"
require "paper_trail/frameworks/active_record"
require "ancestry"
require_relative "fake_mysql"
require_relative "../../../../scripts/golden/support/sidekiq_executor"

ROOT = File.expand_path("../../../../..", __dir__)
REDIS_URL = ENV.fetch("REDIS_URL", "redis://127.0.0.1:6379/12")
abort "Refusing to run against db 0" unless REDIS_URL.match?(%r{/\d+\z}) && !REDIS_URL.end_with?("/0")

# Whole milliseconds: JavaScript dates carry no microseconds (see models/README.md).
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
  def self.logger = (@logger ||= Logger.new(nil))
  def self.env = ActiveSupport::StringInquirer.new("test")
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
ActiveSupport::JSON::Encoding.time_precision = 0
ActiveSupport.escape_html_entities_in_json = true
ActiveSupport.escape_js_separators_in_json = true
PaperTrail.serializer = PaperTrail::Serializers::JSON
I18n.load_path += Dir[File.join(Gem.loaded_specs["ancestry"].full_gem_path, "lib/ancestry/locales/*.yml")]

schema = FakeMysql::SchemaCapture.load(File.join(ROOT, "db/schema.rb"))
FakeMysql.schema = schema.tables
FakeMysql.indexes = schema.indexes
ActiveRecord::Base.logger = nil
# Production Sidekiq's pools (USE_DB_WORKER_REPLICAS=true); every case runs as a job on them.
SidekiqExecutor.establish_proxy_connection(adapter: "mysql2", database: "gumroad_test", encoding: "utf8mb4", collation: "utf8mb4_unicode_ci")
ActiveRecord::ConnectionAdapters::Mysql2Adapter.class_eval { private def default_type(*) = :literal }

module ReplicaLagWatcher
  def self.watch = FakeMysql.log << { "sql" => "-- ReplicaLagWatcher.watch" }
end

Sidekiq.configure_client do |config|
  config.redis = { url: REDIS_URL }
  config.client_middleware { |chain| chain.add SidekiqUniqueJobs::Middleware::Client }
end
Sidekiq.default_job_options = { "backtrace" => true, "retry" => 25 }

def load_app(path) = load(File.join(ROOT, path))

%w[app/modules/deletable.rb app/modules/external_id.rb app/models/concerns/json_data.rb app/models/concerns/recurring_lock_ttl.rb].each { load_app(_1) }

class ApplicationRecord < ActiveRecord::Base
  self.abstract_class = true
end
SidekiqExecutor.connect_application_record!
class User < ApplicationRecord
  include FlagShihTzu
  # user.rb's bit for is_team_member; the other flags are not read here.
  has_flags 28 => :is_team_member, column: "flags", check_for_column: false
  has_many :comments, as: :commentable
  SYSTEM_PAYOUT_PAUSE_COMMENT_AUTHORS = File.read(File.join(ROOT, "app/modules/user/risk.rb"))[/SYSTEM_PAYOUT_PAUSE_COMMENT_AUTHORS = (\{.*?\})\.freeze/m, 1].then { eval(_1) } # rubocop:disable Security/Eval
end
class Link < ApplicationRecord; end
class Purchase < ApplicationRecord; end
class Installment < ApplicationRecord; end

# The methods DetectLegalEntityCountryDriftJob reads, lifted from their files so they are the real
# ones; loading the whole models would need Strongbox keys and half the app.
def ruby_method(path, name)
  source = File.read(File.join(ROOT, path))
  source[/^( +)def #{Regexp.escape(name)}(?=[\s(]).*?^\1end$/m] or raise "no #{name} in #{path}"
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
class MerchantAccount < ApplicationRecord
  include Deletable
  include JsonData
  include ChargeProcessable
  belongs_to :user, optional: true
  File.read(File.join(ROOT, "app/models/merchant_account.rb")).lines.grep(/\A  scope :(charge_processor_alive|stripe),/).each { class_eval(_1) }
  %w[is_a_stripe_connect_account? is_a_gumroad_managed_stripe_account?].each { class_eval(ruby_method("app/models/merchant_account.rb", _1)) }
end
class User
  has_many :merchant_accounts
  class_eval(ruby_method("app/models/user.rb", "stripe_account"))
end
class UserComplianceInfo < ApplicationRecord
  self.table_name = "user_compliance_info"
  belongs_to :user, optional: true
  class_eval(ruby_method("app/models/user_compliance_info.rb", "legal_entity_country_code"))
end

module ContentModeration; end
load_app("app/services/content_moderation/moderate_record_service.rb")
load_app("app/services/adult_keyword_detector.rb")

# CommentMailer is the mail workstream's; record what would be delivered.
class CommentMailer
  def self.deliveries = ($comment_deliveries ||= [])
  def self.notify_seller_of_new_comment(id) = Struct.new(:id) { def deliver_later = CommentMailer.deliveries << ["notify_seller_of_new_comment", id] }.new(id)
end

load_app("app/models/comment.rb")

def stub_job(class_name, path)
  options = File.read(File.join(ROOT, path)).lines.grep(/\A\s*(sidekiq_options|include RecurringLockTtl|recurring_lock_ttl)\b/)
  Object.const_set(class_name, Class.new { include Sidekiq::Job })
  Object.const_get(class_name).class_eval(options.join)
end
stub_job("ReleaseChargebackRatePayoutPauseForSellerJob", "app/sidekiq/release_chargeback_rate_payout_pause_for_seller_job.rb")

%w[content_moderation_admin_comment_job release_chargeback_rate_payout_pauses_job detect_legal_entity_country_drift_job].each { load_app("app/sidekiq/#{_1}.rb") }

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

def script(*rules)
  rules = rules.map { |pattern, answer| [pattern, answer.is_a?(Array) ? answer.dup : answer] }
  lambda do |sql|
    rule = rules.find { |pattern, _| pattern.is_a?(Regexp) ? pattern.match?(sql) : sql.start_with?(pattern) }
    next nil unless rule
    answer = rule[1].is_a?(Array) ? rule[1].shift : rule[1]
    answer.respond_to?(:call) ? answer.call(sql) : answer
  end
end

def capture(name, responder, args: nil, sidekiq: false)
  redis { |conn| conn.call("FLUSHDB") }
  $jid_seq = 0
  CommentMailer.deliveries.clear
  error = nil
  result = nil
  statements = FakeMysql.run(responder) do
    result = sidekiq ? SidekiqExecutor.perform { yield } : yield
  rescue StandardError => e
    error = { "class" => e.class.name, "message" => e.message }
  end
  { "name" => name, "args" => args, "error" => error, "result" => result, "statements" => statements, "redis" => snapshot, "deliveries" => CommentMailer.deliveries.dup }.compact
end

def outcome(comment, saved)
  { "saved" => saved, "errors" => comment.errors.details.transform_values { |list| list.map { _1[:error].to_s } }, "full_messages" => comment.errors.full_messages,
    "attributes" => comment.attributes.transform_values { _1.is_a?(Time) ? _1.utc.iso8601(6) : _1 } }
end

user_fields = %w[id flags name username]
user_row = ->(id, flags = 0) { rows(user_fields, [id, flags, "Seller #{id}", "seller#{id}"]) }
comment_fields = %w[id commentable_id commentable_type author_id author_name content comment_type json_data created_at updated_at deleted_at purchase_id ancestry ancestry_depth idempotency_key]
t = ->(string) { Time.utc(*string.scan(/\d+/).map(&:to_i)) }
exists = ->(table) { [/\ASELECT 1 AS one FROM `#{table}`/, rows(["one"], [1])] }

model_cases = []
build = ->(attributes) { Comment.new(attributes) }

model_cases << capture("note on a user, content trimmed", script(exists.("users"))) do
  comment = build.(commentable_type: "User", commentable_id: 5, author_name: "ContentModeration", comment_type: "note", content: "  first\n\n\n\nsecond\r\n\r\n\r\nthird \n")
  outcome(comment, comment.save)
end
model_cases << capture("note through user.comments.create!", script(["SELECT `users`.*", user_row.(5)], exists.("users"))) do
  user = User.find(5)
  comment = user.comments.create!(author_name: "admin", comment_type: "payout_note", content: "Scheduled payout")
  outcome(comment, true)
end
model_cases << capture("team member author may use adult keywords", script(["SELECT `users`.*", user_row.(9, 1 << 27)], exists.("links"))) do
  comment = build.(commentable_type: "Link", commentable_id: 3, author_id: 9, comment_type: "note", content: "nsfw review")
  outcome(comment, comment.save)
end
model_cases << capture("other authors may not", script(["SELECT `users`.*", user_row.(9)], exists.("purchases"))) do
  comment = build.(commentable_type: "Purchase", commentable_id: 3, author_id: 9, comment_type: "user_submitted", content: "nsfw review", ancestry: "11")
  outcome(comment, comment.save)
end
model_cases << capture("an author id that matches no user", script(exists.("installments"))) do
  comment = build.(commentable_type: "Installment", commentable_id: 3, author_id: 404, author_name: "ContentModeration", comment_type: "note", content: "lewd")
  outcome(comment, comment.save)
end
model_cases << capture("blank fields", script()) do
  comment = build.(content: " \n ")
  outcome(comment, comment.save)
end
model_cases << capture("unknown commentable type", script()) do
  comment = build.(commentable_type: "Wishlist", commentable_id: 1, author_name: "a", comment_type: "note", content: "x")
  outcome(comment, comment.save)
end
model_cases << capture("commentable that does not exist", script()) do
  comment = build.(commentable_type: "User", commentable_id: 77, author_name: "a", comment_type: "note", content: "x")
  outcome(comment, comment.save)
end
model_cases << capture("content over 10,000 characters", script(exists.("users"))) do
  comment = build.(commentable_type: "User", commentable_id: 5, author_name: "a", comment_type: "note", content: "é" * 10_001)
  outcome(comment, comment.save)
end
model_cases << capture("reply at the maximum depth", script(exists.("users"))) do
  comment = build.(commentable_type: "User", commentable_id: 5, author_name: "a", comment_type: "user_submitted", content: "deep", ancestry: "1/2/3/4")
  outcome(comment, comment.save)
end
model_cases << capture("reply past the maximum depth", script(exists.("users"))) do
  comment = build.(commentable_type: "User", commentable_id: 5, author_name: "a", comment_type: "user_submitted", content: "deeper", ancestry: "1/2/3/4/5")
  outcome(comment, comment.save)
end
model_cases << capture("malformed ancestry", script(exists.("users"))) do
  comment = build.(commentable_type: "User", commentable_id: 5, author_name: "a", comment_type: "note", content: "x", ancestry: "1/x")
  outcome(comment, comment.save)
end
stored = ->(overrides = {}) { [21, 5, "User", nil, "admin", "Original", "note", nil, t["2025-01-01 10:00:00"], t["2025-01-01 10:00:00"], nil, nil, nil, 0, nil].tap { |row| overrides.each { |i, v| row[comment_fields.index(i)] = v } } }
model_cases << capture("mark_deleted! on a stored comment", script(["SELECT `comments`.*", rows(comment_fields, stored.())])) do
  comment = Comment.find(21)
  comment.mark_deleted!
  outcome(comment, true)
end
model_cases << capture("content edit re-runs the content validations only", script(["SELECT `comments`.*", rows(comment_fields, stored.("author_id" => 9))], ["SELECT `users`.*", user_row.(9)])) do
  comment = Comment.find(21)
  comment.content = "\n\nEdited\n\n\n\n"
  outcome(comment, comment.save)
end
model_cases << capture("an edit that adds an adult keyword fails", script(["SELECT `comments`.*", rows(comment_fields, stored.("author_id" => 9))], ["SELECT `users`.*", user_row.(9)])) do
  comment = Comment.find(21)
  comment.content = "nsfw now"
  outcome(comment, comment.save)
end
model_cases << capture("saving without changes", script(["SELECT `comments`.*", rows(comment_fields, stored.())])) do
  comment = Comment.find(21)
  outcome(comment, comment.save)
end
model_cases << capture("stored depth is recomputed from the ancestry", script(["SELECT `comments`.*", rows(comment_fields, stored.("ancestry" => "3/4", "ancestry_depth" => 0))])) do
  comment = Comment.find(21)
  comment.comment_type = "flag_note"
  outcome(comment, comment.save)
end

job_cases = {}
job_cases["ContentModerationAdminCommentJob"] = [
  capture("user not found", script(), sidekiq: true, args: [5, "Blocked: nsfw"]) { ContentModerationAdminCommentJob.new.perform(5, "Blocked: nsfw") },
  capture("writes the note", script(["SELECT `users`.*", user_row.(5)], exists.("users")), sidekiq: true, args: [5, "Blocked: nsfw\n\n\n\nproduct"]) do
    ContentModerationAdminCommentJob.new.perform(5, "Blocked: nsfw\n\n\n\nproduct")
    nil
  end,
  capture("a note within the dedup window", script(["SELECT `users`.*", user_row.(5)], [/\ASELECT 1 AS one FROM `comments`/, rows(["one"], [1])]), sidekiq: true, args: [5, "Blocked"]) do
    ContentModerationAdminCommentJob.new.perform(5, "Blocked")
  end,
]
candidate_fields = %w[id commentable_id]
job_cases["ReleaseChargebackRatePayoutPausesJob"] = [
  capture("no candidates", script(), sidekiq: true, args: []) { ReleaseChargebackRatePayoutPausesJob.new.perform },
  capture("one job per seller across batches", script([/\ASELECT `comments`.`id`, `comments`.`commentable_id`/, [rows(candidate_fields, *(1..1000).map { [_1, 100 + (_1 % 3)] }), rows(candidate_fields, [1001, 100], [1002, 205])]]), sidekiq: true, args: []) do
    ReleaseChargebackRatePayoutPausesJob.new.perform
    nil
  end,
]

info_fields = %w[id user_id country_code business_country_code is_business]
info = ->(*row) { ["SELECT `user_compliance_info`.*", rows(info_fields, row)] }
account_fields = %w[id user_id charge_processor_id charge_processor_merchant_id country json_data deleted_at charge_processor_alive_at charge_processor_deleted_at]
alive_at = t["2025-01-01"]
managed = ->(id, country) { [id, 5, "stripe", "acct_#{id}", country, nil, nil, alive_at, nil] }
connect = ->(id, country) { [id, 5, "stripe", "acct_#{id}", country, '{"meta":{"stripe_connect":"true"}}', nil, alive_at, nil] }
accounts = ->(*list) { ["SELECT `merchant_accounts`.*", rows(account_fields, *list)] }
user_lookup = ["SELECT `users`.*", user_row.(5)]
drift = ->(name, responder, id = 3) { capture(name, responder, sidekiq: true, args: [id]) { DetectLegalEntityCountryDriftJob.new.perform(id); nil } }
job_cases["DetectLegalEntityCountryDriftJob"] = [
  drift.("compliance info not found", script()),
  drift.("no user on the compliance info", script(info.(3, nil, "DE", nil, false))),
  drift.("user missing", script(info.(3, 5, "DE", nil, false))),
  drift.("no derived country", script(info.(3, 5, nil, nil, false), user_lookup)),
  drift.("blank business country falls back to the individual one", script(info.(3, 5, "", "", true), user_lookup)),
  drift.("no stripe account", script(info.(3, 5, "DE", nil, false), user_lookup)),
  drift.("only a Stripe Connect account", script(info.(3, 5, "DE", nil, false), user_lookup, accounts.(connect.(40, "US")))),
  drift.("account country blank", script(info.(3, 5, "DE", nil, false), user_lookup, accounts.(managed.(41, nil)))),
  drift.("countries match", script(info.(3, 5, "DE", nil, false), user_lookup, accounts.(managed.(41, "DE")))),
  drift.("business country drifted", script(info.(3, 5, "DE", "FR", true), [/\ASELECT `users`.*/, [user_row.(5), user_row.(5)]], accounts.(connect.(40, "US"), managed.(41, "DE")), exists.("users"))),
  drift.("drift already noted", script(info.(3, 5, "DE", nil, false), [/\ASELECT `users`.*/, [user_row.(5), user_row.(5)]], accounts.(managed.(41, "US")), [/\ASELECT 1 AS one FROM `comments`/, rows(["one"], [1])])),
]

normalize = ["", "plain", "  padded  ", "\n\n\nlead", "a\n\n\nb", "a\n\nb", "a\r\n\r\n\r\nb", "a\r\n\nb", "a\r\n\n\nb", "a\n\r\n\r\nb", "a\u2028\u2028\u2028b",
             "a\v\f\rb", "a\u0085\u0085\u0085b", "\0 x \0", " \t x \t ", "a\n \n \nb", "a\n\n\n\n\n\nb\n\n\nc"]

File.write(File.join(__dir__, "comment.golden.json"), JSON.pretty_generate(
  "generated_with" => { "ruby" => RUBY_VERSION, "activerecord" => ActiveRecord.version.to_s, "ancestry" => Ancestry::VERSION, "paper_trail" => PaperTrail::VERSION::STRING },
  "now" => FIXED_NOW.to_f,
  "model" => model_cases,
  "jobs" => job_cases,
  "normalize_content" => normalize.map { [_1, Comment.normalize_content(_1)] },
) + "\n")
redis { |conn| conn.call("FLUSHDB") }
puts "wrote comment.golden.json"
