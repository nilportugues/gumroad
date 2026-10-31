# frozen_string_literal: true

# Produces application-mailer.golden.json from the real application: it boots config/environment
# in production mode against a scratch MySQL database and a scratch Redis database, then runs
# ApplicationMailer, MailerInfo and the mailers and jobs ported to Node exactly as Sidekiq would,
# with only the SMTP socket replaced by a recorder. Nothing here re-implements Ruby behaviour.
#
#   mysql -uroot -e 'CREATE DATABASE gumroad_ws35'   # then load db/schema.rb's tables into it
#   USE_DB_WORKER_REPLICAS=true bundle exec ruby nextjs/src/server/mail/__fixtures__/generate-application-mailer-golden.rb
#
# The jobs run as production Sidekiq runs them (scripts/golden/support/sidekiq_executor.rb), so the
# query cache is on.
#
# Environment it needs (defaults shown): DATABASE_NAME=gumroad_ws35, REDIS_DB=6 (flushed). The
# remaining secrets come from .env.test; the SMTP credentials and the X-GUM header key are fixed
# below so the Node test can use the same values.
#
# Random values are pinned rather than normalised: Kernel.rand (the provider split) and the
# AES IVs of the Resend headers come from fixed sequences, recorded per case. Date, Message-ID
# and the MIME boundary stay random; the Node test reads them back from `encoded`.
require "fileutils"
require "json"

ROOT = File.expand_path("../../../../..", __dir__)
FIXTURES = __dir__
Dir.chdir(ROOT)

REDIS_DB = ENV.fetch("REDIS_DB", "6")
abort "Refusing to flush Redis db 0" if REDIS_DB == "0"

SMTP_SECRETS = {
  "SENDGRID_GUMROAD_TRANSACTIONS_API_KEY" => "sg-gumroad-key",
  "SENDGRID_GUMROAD_FOLLOWER_CONFIRMATION_API_KEY" => "sg-followers-key",
  "SENDGRID_GR_CREATORS_API_KEY" => "sg-creators-key",
  "SENDGRID_GR_CUSTOMERS_API_KEY" => "sg-customers-key",
  "SENDGRID_GR_CUSTOMERS_LEVEL_2_API_KEY" => "sg-customers-level-2-key",
  "RESEND_DEFAULT_API_KEY" => "re-gumroad-key",
  "RESEND_FOLLOWERS_API_KEY" => "re-followers-key",
  "RESEND_CREATORS_API_KEY" => "re-creators-key",
  "RESEND_CUSTOMERS_API_KEY" => "re-customers-key",
  "RESEND_CUSTOMERS_LEVEL_2_API_KEY" => "re-customers-level-2-key",
  "MAILER_HEADERS_ENCRYPTION_KEY_V1" => "ws35-golden-header-key",
}.freeze

ENV["RAILS_ENV"] = "production"
ENV["TZ"] = "UTC"
{
  "DATABASE_HOST" => "127.0.0.1", "DATABASE_PORT" => "3306", "DATABASE_NAME" => "gumroad_ws35",
  "DATABASE_USERNAME" => "root", "DATABASE_PASSWORD" => "password",
  "SECRET_KEY_BASE" => "x" * 64, "DEVISE_SECRET_KEY" => "d" * 64, "REVISION" => "ws35golden",
  "MEMCACHE_SERVERS" => "localhost:11211", "ELASTICSEARCH_HOST" => "http://localhost:9200",
}.each { |k, v| ENV[k] ||= v }
%w[REDIS_HOST SIDEKIQ_REDIS_HOST RPUSH_REDIS_HOST RACK_ATTACK_REDIS_HOST].each { |k| ENV[k] = "localhost:6379/#{REDIS_DB}" }
SMTP_SECRETS.each { |k, v| ENV[k] = v }
abort "Use a scratch database, not #{ENV["DATABASE_NAME"]}" if %w[gumroad_test gumroad_development gumroad_production].include?(ENV["DATABASE_NAME"])

require "dotenv"
Dotenv.parse(File.join(ROOT, ".env.test")).each { |k, v| ENV[k] ||= v }

# A production build's stylesheet: the manifest entry the layout links and the CSS premailer reads.
VITE_DIR = File.join(ROOT, "public/vite")
abort "public/vite exists; move it aside first" if File.exist?(VITE_DIR)
FileUtils.mkdir_p(File.join(VITE_DIR, ".vite"))
FileUtils.mkdir_p(File.join(VITE_DIR, "assets"))
File.write(File.join(VITE_DIR, ".vite/manifest.json"), JSON.generate({ "entrypoints/email.ts" => { "file" => "assets/email.js", "css" => ["assets/email-golden.css"] } }))
FileUtils.cp(File.join(FIXTURES, "email.css"), File.join(VITE_DIR, "assets/email-golden.css"))
at_exit { FileUtils.rm_rf(VITE_DIR) }

require File.join(ROOT, "config/environment")
Rails.logger = ActiveSupport::Logger.new(nil)
ActiveRecord::Base.logger = nil
ActionMailer::Base.logger = nil
ActiveJob::Base.logger = Logger.new(nil)

require "active_support/testing/time_helpers"
require File.join(ROOT, "nextjs/scripts/golden/support/sidekiq_executor")

# Message-IDs embed the host name; pin it so goldens don't record the machine they ran on.
require "socket"
Socket.singleton_class.prepend(Module.new { def gethostname = "mail-host.example" })
include ActiveSupport::Testing::TimeHelpers
FIXED_NOW = Time.utc(2026, 10, 31, 12, 0, 0)
travel_to(FIXED_NOW)

# --- pinned randomness -----------------------------------------------------------------------------
$rands = []
$rands_used = []
Kernel.singleton_class.prepend(Module.new do
  def rand(*args)
    return super unless args.empty?
    value = $rands.shift or raise "no pinned Kernel.rand left"
    $rands_used << value
    value
  end
end)

$iv_seq = 0
$ivs_used = []
OpenSSL::Cipher.prepend(Module.new do
  def random_iv
    $iv_seq += 1
    iv = format("ws35-iv-%08d", $iv_seq)
    $ivs_used << Base64.strict_encode64(iv)
    self.iv = iv
  end
end)

# --- SMTP recorder -----------------------------------------------------------------------------------
$delivered = []
# Errors the next deliveries raise instead of succeeding.
$smtp_failures = []
Mail::SMTP.prepend(Module.new do
  def deliver!(mail)
    failure = $smtp_failures.shift
    raise failure if failure
    envelope = Mail::SmtpEnvelope.new(mail)
    $delivered << {
      "settings" => settings.slice(:address, :port, :domain, :user_name, :password, :authentication, :enable_starttls_auto)
        .to_h { |k, v| [k.to_s, v.is_a?(Symbol) ? v.to_s : v] },
      "encoded" => mail.encoded,
      "envelope_from" => envelope.from,
      "envelope_to" => envelope.to,
    }
    mail
  end
end)

# --- SQL recorder (the shape worker/jobs/__fixtures__/sql-replay.ts replays) --------------------------
$sql = nil
module RecordStatements
  def perform_query(raw_connection, sql, *rest, **kwargs)
    result = super
    if $sql
      statement = { "sql" => sql.gsub(%r{\s*/\*.*?\*/}, "") }
      if result.respond_to?(:fields) && result.fields
        statement["result"] = { "fields" => result.fields, "rows" => result.to_a.map { |row| row.map { |v| encode_value(v) } } }
      elsif !%w[BEGIN COMMIT ROLLBACK].include?(sql)
        statement["result"] = { "affected" => raw_connection.affected_rows }
      end
      $sql << statement
    end
    result
  end

  def encode_value(value)
    case value
    when Time then { "$time" => value.utc.iso8601(6) }
    when BigDecimal then { "$decimal" => value.to_s("F") }
    else value
    end
  end
end
ActiveRecord::ConnectionAdapters::Mysql2Adapter.prepend(RecordStatements)

def capture_sql
  $sql = []
  yield
  $sql
ensure
  $sql = nil
end

# --- fixtures --------------------------------------------------------------------------------------
def reset!
  conn = ActiveRecord::Base.connection
  %w[users links invites marketing_actions].each { |t| conn.execute("DELETE FROM #{t}") }
  $redis.flushdb
  $rands.clear
  $rands_used.clear
  $iv_seq = 0
  $ivs_used.clear
  $delivered.clear
  $smtp_failures.clear
end

def insert_user(id:, **attrs)
  User.insert!({ id:, recommendation_type: "own_products", external_id: (8_000_000_000_000 + id).to_s, created_at: FIXED_NOW, updated_at: FIXED_NOW, **attrs })
end

def insert_link(id:, user_id:, **attrs)
  Link.insert!({ id:, user_id:, name: "Product #{id}", unique_permalink: "perm#{id}", price_cents: 100, created_at: FIXED_NOW, updated_at: FIXED_NOW, **attrs })
end

def insert_action(id:, user_id:, link_id:, **attrs)
  Marketing::Action.insert!({ id:, user_id:, link_id:, channel: "x", status: "approved", idempotency_key: "key-#{id}", copy: "Copy #{id}",
                              error_code: Marketing::Action::X_WRITE_PERMISSION_MISSING, created_at: FIXED_NOW, updated_at: FIXED_NOW, **attrs })
end

def table_rows(table)
  result = ActiveRecord::Base.connection.select_all("SELECT * FROM #{table} ORDER BY id")
  result.rows.map { |row| result.columns.zip(row.map { |v| v.is_a?(Time) ? v.utc.iso8601(6) : v }).to_h }
end

cases = {}

# --- MailerInfo units ------------------------------------------------------------------------------
cases["header_names"] = MailerInfo::FIELD_NAMES.to_h { [_1.to_s, MailerInfo.header_name(_1)] }

ARGS = [
  [],
  [42],
  [1, 2, nil, true, false],
  ["short", "exactly twenty chars", "twenty-one characters", "a string well over twenty characters long"],
  ["quote \" back\\slash", "tab\tnew\nline", "\e\a\b\v\f\r\u0001\u007f", "\#{interp} \#$g \#@i #plain"],
  ["<script>&amp;</script>"],
  [{ marketing_action_id: 5 }],
  [{ user_id: 1, email: "buyer@example.com", subject: "s", body: nil, if: 1, "x=": 2, a?: 3, B!: 4 }],
  [{ "string" => "key", 3 => [1, { nested: :sym }], nil => nil }],
  [[1, [2, [3]]], {}],
  [-12, 9_007_199_254_740_993],
  [:a, :b?, :C, :c!, :d=, :@iv, :"needs quotes"],
]
cases["sendgrid_headers"] = ARGS.map do |args|
  { "mailer_class" => "CreatorMailer", "mailer_method" => "marketing_x_reconnect", "args" => args.inspect,
    "headers" => MailerInfo.build_headers(mailer_class: "CreatorMailer", mailer_method: "marketing_x_reconnect", mailer_args: args, email_provider: "sendgrid") }
end
cases["sendgrid_headers"] << { "mailer_class" => "InviteMailer", "mailer_method" => "", "args" => "[1]",
                               "headers" => MailerInfo.build_headers(mailer_class: "InviteMailer", mailer_method: "", mailer_args: [1], email_provider: "sendgrid") }

cases["resend_headers"] = [[[7], "InviteMailer", "receiver_signed_up"], [[{ marketing_action_id: 5 }], "CreatorMailer", "marketing_x_reconnect"], [[], "InviteMailer", ""]].map do |args, klass, method|
  $iv_seq = 0
  $ivs_used.clear
  headers = MailerInfo.build_headers(mailer_class: klass, mailer_method: method, mailer_args: args, email_provider: "resend")
  { "mailer_class" => klass, "mailer_method" => method, "args" => args.inspect, "ivs" => $ivs_used.dup, "headers" => headers,
    "decrypted" => headers.transform_values { |v| v.start_with?("v1:") ? MailerInfo.decrypt(v) : v } }
end

cases["force_sendgrid"] = [
  nil, [], "a@web.de", "A@WEB.DE", "Name <user@gmx.net>", " Name <user@gmx.net> ", "user@sub.web.de", "user@gmail.com",
  ["a@example.com", "b@mail.com"], ["a@example.com", nil], "no-at-sign", "x@gmx.co.uk>", "", "user@gmx.de >",
].map { |recipients| { "recipients" => recipients, "result" => MailerInfo.force_sendgrid_for_recipients?(recipients) } }

SellerStub = Struct.new(:mailer_level) do
  def present? = true
end
cases["delivery_options"] = MailerInfo::DeliveryMethod::DOMAINS.product(%w[sendgrid resend]).map do |domain, provider|
  { "domain" => domain.to_s, "provider" => provider, "options" => MailerInfo::DeliveryMethod.options(domain:, email_provider: provider) }
end
%i[level_1 level_2].product(%w[sendgrid resend]).each do |level, provider|
  cases["delivery_options"] << { "domain" => "customers", "provider" => provider, "seller_level" => level.to_s,
                                 "options" => MailerInfo::DeliveryMethod.options(domain: :customers, email_provider: provider, seller: SellerStub.new(level)) }
end
cases["delivery_option_errors"] = [
  [:nope, "sendgrid", nil], [:gumroad, "sendgrid", SellerStub.new(:level_1)],
].map do |domain, provider, seller|
  MailerInfo::DeliveryMethod.options(domain:, email_provider: provider, seller:)
  raise "expected an error"
rescue ArgumentError => e
  { "domain" => domain.to_s, "seller" => !seller.nil?, "error" => e.message }
end

equivalents = MailerInfo::DeliveryMethod::DOMAINS.map { MailerInfo::DeliveryMethod.options(domain: _1, email_provider: "resend") }
equivalents += MailerInfo::DeliveryMethod::DOMAINS.map { MailerInfo::DeliveryMethod.options(domain: _1, email_provider: "sendgrid") }
equivalents << MailerInfo::DeliveryMethod.options(domain: :customers, email_provider: "resend", seller: SellerStub.new(:level_2))
equivalents << { address: RESEND_SMTP_ADDRESS, domain: "unknown.example.com", user_name: "resend", password: "x" }
equivalents << {}
cases["sendgrid_equivalent"] = equivalents.map { { "settings" => _1, "result" => MailerInfo::DeliveryMethod.sendgrid_equivalent_options(_1) } }

# Router: flags and counters as Redis holds them, Kernel.rand pinned.
ROUTER = [
  { "name" => "resend off", "features" => {}, "redis" => {}, "rands" => [] },
  { "name" => "forced", "features" => { "resend" => true, "force_resend" => true }, "redis" => {}, "rands" => [] },
  { "name" => "no counters", "features" => { "resend" => true }, "redis" => {}, "rands" => [] },
  { "name" => "under probability", "features" => { "resend" => true }, "redis" => { "probability" => "0.5", "max_count" => "10", "counter" => "3" }, "rands" => [0.5] },
  { "name" => "over probability", "features" => { "resend" => true }, "redis" => { "probability" => "0.5", "max_count" => "10" }, "rands" => [0.75] },
  { "name" => "max reached", "features" => { "resend" => true }, "redis" => { "probability" => "1", "max_count" => "4", "counter" => "4" }, "rands" => [] },
  { "name" => "lenient numbers", "features" => { "resend" => true }, "redis" => { "probability" => " .9x", "max_count" => "12abc", "counter" => "-2" }, "rands" => [0.25] },
  { "name" => "other day", "features" => { "resend" => true }, "redis" => { "probability" => "1", "max_count" => "10", "date" => "2026-10-30" }, "rands" => [] },
].freeze
cases["router"] = MailerInfo::DeliveryMethod::DOMAINS.flat_map do |domain|
  ROUTER.map do |c|
    reset!
    c["features"].each_key { Feature.activate(_1) }
    date = c["redis"].fetch("date", Date.current.to_s)
    $redis.set("mail_router:probability:#{domain}:#{date}", c["redis"]["probability"]) if c["redis"]["probability"]
    $redis.set("mail_router:max_count:#{domain}:#{date}", c["redis"]["max_count"]) if c["redis"]["max_count"]
    $redis.set("mail_router:counter:#{domain}:#{date}", c["redis"]["counter"]) if c["redis"]["counter"]
    $rands.replace(c["rands"])
    result = MailerInfo::Router.determine_email_provider(domain)
    keys = $redis.keys("mail_router:*").sort
    c.merge("domain" => domain.to_s, "today" => Date.current.to_s, "result" => result, "rands_used" => $rands_used.dup,
            "redis_after" => keys.to_h { [_1, $redis.get(_1)] })
  end
end

# Header folding as Mail 2.9 encodes unstructured fields.
FOLD = [
  ["Subject", "short"],
  ["Subject", "A subject that is long enough that the mail gem has to fold it onto a second line"],
  ["Subject", "x" * 100],
  ["Subject", "word " * 30],
  ["Subject", "two  spaces and\ttab and trailing   "],
  ["Subject", "  leading spaces then a long run of words that keeps going past the limit of the line"],
  ["X-SMTPAPI", { environment: "production", category: ["CreatorMailer", "CreatorMailer.marketing_x_reconnect"], unique_args: { mailer_class: "CreatorMailer", mailer_method: "marketing_x_reconnect", mailer_args: "[{marketing_action_id: 5}]" } }.to_json],
  ["X-GUM-Mailer-Args", "v1:#{"A" * 22}==:#{"B" * 64}"],
  ["X-Long-Name-For-A-Header-That-Eats-Most-Of-The-First-Line-By-Itself", "value one two"],
]
cases["fold"] = FOLD.map do |name, value|
  { "name" => name, "value" => value, "encoded" => Mail::Field.new(name, value).encoded }
end

# validate_from_email_domain! through the real after_action, with a mailer that exists only here.
class GoldenProbeMailer < ApplicationMailer
  def probe(from:, domain:, subject: "Probe")
    mail(from:, to: "buyer@example.com", subject:, delivery_method_options: MailerInfo::DeliveryMethod.options(domain:, email_provider: "sendgrid")) do |format|
      format.text { render plain: "probe" }
    end
  end
end
cases["from_domain"] = [
  ["noreply@gumroad.com", :gumroad, "Probe"],
  ["Gumroad <noreply@gumroad.com>", :gumroad, "Probe"],
  ["noreply@creators.gumroad.com", :gumroad, "Probe"],
  ["noreply@gumroad.com", :creators, "Probe"],
  ["noreply@gumroad.com", :creators, nil],
  ["Name <a@customers.gumroad.com>", :customers, "Probe"],
].map do |from, domain, subject|
  reset!
  GoldenProbeMailer.probe(from:, domain:, subject:).message
  { "from" => from, "domain" => domain.to_s, "subject" => subject, "error" => nil }
rescue RuntimeError => e
  { "from" => from, "domain" => domain.to_s, "subject" => subject, "error" => e.message }
end

# --- messages through the whole pipeline -----------------------------------------------------------
# `args` are the mailer arguments; `job_args` is how deliver_later serializes them.
def record_message(name, mailer, method, args, features: {}, redis: {}, rands: [])
  features.each_key { Feature.activate(_1) }
  redis.each { |k, v| $redis.set(k, v) }
  $rands.replace(rands)
  delivery = mailer.public_send(method, *args)
  rendered = nil
  statements = capture_sql do
    rendered = delivery.message.is_a?(ActionMailer::Base::NullMail) ? nil : delivery.message.body.raw_source.dup
  end
  result = delivery.deliver_now
  {
    "name" => name,
    "mailer" => mailer.name,
    "method" => method.to_s,
    "job_args" => ActiveJob::Arguments.serialize(args),
    "statements" => statements,
    "features" => features.keys,
    "redis_before" => redis,
    "rands_used" => $rands_used.dup,
    "ivs" => $ivs_used.dup,
    "rendered_html" => rendered,
    "returned_message" => result.is_a?(Mail::Message),
    "delivered" => $delivered.dup,
    "redis_after" => $redis.keys("mail_router:*").sort.to_h { [_1, $redis.get(_1)] },
  }
end

# Warm the schema cache so the recorded statements are the mailers' and jobs' own.
[User, Link, Marketing::Action, Invite].each { _1.columns; _1.first }
# Likewise open the job thread's replica and primary connections, which the pools then reuse.
SidekiqExecutor.perform { User.first; User.transaction { User.first } }

today = Date.current.to_s
messages = []

# InviteMailer#receiver_signed_up
[
  ["invite_sendgrid", { name: "Receiver Name", email: "receiver@example.com" }, { email: "sender@example.com", unconfirmed_email: "sender-new@example.com" }, {}, {}, []],
  ["invite_resend", { name: "Receiver Name", email: "receiver@example.com" }, { email: "sender@example.com" }, { "resend" => true, "force_resend" => true }, {}, []],
  ["invite_no_name", { name: nil, email: "receiver@example.com" }, { email: "sender@example.com" }, {}, {}, []],
  ["invite_blank_name_and_email", { name: " ", email: "" }, { email: "sender@example.com" }, {}, {}, []],
  ["invite_long_subject", { name: "A receiver whose name is long enough to push the subject past the fold", email: "r@example.com" }, { email: "sender@example.com" }, {}, {}, []],
  ["invite_blank_to", { name: "R", email: "r@example.com" }, { email: "" }, {}, {}, []],
  ["invite_html_name", { name: "<b>Tom & \"Jerry\"</b>", email: "r@example.com" }, { email: "sender@example.com" }, {}, {}, []],
  ["invite_router_resend", { name: "R", email: "r@example.com" }, { email: "sender@example.com" }, { "resend" => true },
   { "mail_router:probability:gumroad:#{today}" => "0.5", "mail_router:max_count:gumroad:#{today}" => "10" }, [0.1]],
  ["invite_united_internet", { name: "R", email: "r@example.com" }, { email: "sender@web.de" }, { "resend" => true, "force_resend" => true }, {}, []],
].each do |name, receiver, sender, features, redis, rands|
  reset!
  insert_user(id: 101, **sender)
  insert_user(id: 102, **receiver)
  Invite.insert!({ id: 7, sender_id: 101, receiver_id: 102, receiver_email: "r@example.com", invite_state: "signed_up", created_at: FIXED_NOW, updated_at: FIXED_NOW })
  messages << record_message(name, InviteMailer, :receiver_signed_up, [7], features:, redis:, rands:)
end

# CreatorMailer#marketing_x_reconnect
[
  ["reconnect_sendgrid", { email: "seller@example.com" }, {}, {}, {}],
  ["reconnect_resend", { email: "seller@example.com", unconfirmed_email: "seller-new@example.com" }, {}, { "resend" => true, "force_resend" => true }, {}],
  ["reconnect_gmx_redirected", { email: "seller@gmx.de" }, {}, { "resend" => true, "force_resend" => true }, {}],
  ["reconnect_invalid_email", { email: "not-an-email" }, {}, {}, {}],
  ["reconnect_not_awaiting", { email: "seller@example.com" }, { status: "posted" }, {}, {}],
  ["reconnect_other_error", { email: "seller@example.com" }, { error_code: "rate_limited" }, {}, {}],
  ["reconnect_product_html", { email: "seller@example.com" }, {}, {}, { name: "Tom & Jerry's <Guide>" }],
].each do |name, seller, action, features, link|
  reset!
  insert_user(id: 201, **seller)
  insert_link(id: 301, user_id: 201, **link)
  insert_action(id: 5, user_id: 201, link_id: 301, **action)
  messages << record_message(name, CreatorMailer, :marketing_x_reconnect, [Hash.ruby2_keywords_hash({ marketing_action_id: 5 })], features:)
end
reset!
messages << record_message("reconnect_missing_action", CreatorMailer, :marketing_x_reconnect, [Hash.ruby2_keywords_hash({ marketing_action_id: 99 })])
cases["messages"] = messages

# --- jobs ------------------------------------------------------------------------------------------
def run_job(name, klass, args)
  $delivered.clear
  error = nil
  statements = capture_sql do
    SidekiqExecutor.perform { klass.new.perform(*args) }
  rescue => e
    error = { "class" => e.class.name, "message" => e.message }
  end
  { "name" => name, "args" => args, "error" => error, "statements" => statements, "delivered" => $delivered.dup,
    "after" => { "marketing_actions" => table_rows("marketing_actions") } }
end

jobs = []
reset!
jobs << run_job("missing seller", SendMarketingXReconnectEmailJob, [404])
reset!
insert_user(id: 201, email: "seller@example.com")
insert_link(id: 301, user_id: 201)
insert_action(id: 5, user_id: 201, link_id: 301, reconnect_notified_at: FIXED_NOW - 1.day)
jobs << run_job("nothing pending", SendMarketingXReconnectEmailJob, [201])
reset!
insert_user(id: 201, email: "seller@example.com")
insert_user(id: 202, email: "other@example.com")
insert_link(id: 301, user_id: 201, name: "First product")
insert_link(id: 302, user_id: 201, name: "Second product")
insert_link(id: 303, user_id: 202)
insert_action(id: 5, user_id: 201, link_id: 301)
insert_action(id: 6, user_id: 201, link_id: 302)
insert_action(id: 7, user_id: 201, link_id: 301, status: "cancelled")
insert_action(id: 8, user_id: 202, link_id: 303)
jobs << run_job("two pending, one mail", SendMarketingXReconnectEmailJob, [201])
reset!
insert_user(id: 201, email: "not-an-email")
insert_link(id: 301, user_id: 201)
insert_action(id: 5, user_id: 201, link_id: 301)
jobs << run_job("every mail declined", SendMarketingXReconnectEmailJob, [201])
[
  ["first mail rejected by SMTP", Net::SMTPFatalError.new(Net::SMTP::Response.parse("550 5.7.1 rejected"))],
  ["SMTP timeout", Net::OpenTimeout.new("execution expired")],
].each do |name, failure|
  reset!
  insert_user(id: 201, email: "seller@example.com")
  insert_link(id: 301, user_id: 201)
  insert_link(id: 302, user_id: 201)
  insert_action(id: 5, user_id: 201, link_id: 301)
  insert_action(id: 6, user_id: 201, link_id: 302)
  $smtp_failures.replace([failure])
  jobs << run_job(name, SendMarketingXReconnectEmailJob, [201])
end
cases["jobs"] = jobs

# DisputeEvidenceDueSoonReminderJob only enqueues the Ruby mailer.
reset!
DisputeEvidenceDueSoonReminderJob.new.perform(77)
queued = Sidekiq.redis { |c| c.lrange("queue:default", 0, -1) }
cases["dispute_reminder"] = { "args" => [77], "queued" => queued, "now" => FIXED_NOW.to_f }

File.write(File.join(FIXTURES, "application-mailer.golden.json"), JSON.pretty_generate({ "now" => FIXED_NOW.iso8601, "secrets" => SMTP_SECRETS, "cases" => cases }) + "\n")
puts "wrote #{cases.keys.size} sections"
