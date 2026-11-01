# frozen_string_literal: true

# Produces team-mailer.golden.json from the real application: it boots config/environment
# in production mode against a scratch MySQL database and a scratch Redis database, then runs
# TeamMailer exactly as Sidekiq would,
# with only the SMTP socket replaced by a recorder. Nothing here re-implements Ruby behaviour.
#
#   mysql -uroot -e 'CREATE DATABASE gumroad_ws73'   # then load db/schema.rb's tables into it
#   USE_DB_WORKER_REPLICAS=true bundle exec ruby nextjs/src/server/mail/__fixtures__/generate-team-mailer-golden.rb
#
# The jobs run as production Sidekiq runs them (scripts/golden/support/sidekiq_executor.rb), so the
# query cache is on.
#
# Environment it needs (defaults shown): DATABASE_NAME=gumroad_ws73, REDIS_DB=10 (flushed). The
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
  "OBFUSCATE_IDS_CIPHER_KEY" => "ws40-golden-obfuscate-key",
  "OBFUSCATE_IDS_NUMERIC_CIPHER_KEY" => "123456789",
}.freeze

ENV["RAILS_ENV"] = "production"
ENV["TZ"] = "UTC"
{
  "DATABASE_HOST" => "127.0.0.1", "DATABASE_PORT" => "3306", "DATABASE_NAME" => "gumroad_ws73",
  "DATABASE_USERNAME" => "root", "DATABASE_PASSWORD" => "password",
  "SECRET_KEY_BASE" => "x" * 64, "DEVISE_SECRET_KEY" => "d" * 64, "REVISION" => "ws73golden",
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

# A mailer taking records, run as the Active Job delivery does: the GlobalID locate is part of the
# recorded statements, and the X-GUM mailer_args hold the located record's #inspect.
def record_job_message(name, mailer, method, records, features: {}, meta: {})
  $delivered.clear
  $iv_seq = 0
  $ivs_used.clear
  $rands_used.clear
  features.each_key { Feature.activate(_1) }
  serialized = ActiveJob::Arguments.serialize(records)
  delivery = nil
  rendered = nil
  statements = capture_sql do
    delivery = mailer.public_send(method, *ActiveJob::Arguments.deserialize(serialized))
    rendered = delivery.message.is_a?(ActionMailer::Base::NullMail) ? nil : delivery.message.body.raw_source.dup
  end
  result = delivery.deliver_now
  {
    **meta,
    "name" => name,
    "mailer" => mailer.name,
    "method" => method.to_s,
    "job_args" => serialized,
    "statements" => statements,
    "features" => features.keys,
    "redis_before" => {},
    "rands_used" => $rands_used.dup,
    "ivs" => $ivs_used.dup,
    "rendered_html" => rendered,
    "returned_message" => result.is_a?(Mail::Message),
    "delivered" => $delivered.dup,
    "redis_after" => $redis.keys("mail_router:*").sort.to_h { [_1, $redis.get(_1)] },
    "fallback_after" => $redis.keys("email_router_fallback:*").sort.to_h { [_1, [$redis.get(_1), $redis.ttl(_1)]] },
  }
end

TABLES = %w[users team_invitations team_memberships].freeze
def reset!
  conn = ActiveRecord::Base.connection
  TABLES.each { |t| conn.execute("DELETE FROM #{t}") }
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

def insert_invitation(id:, seller_id:, **attrs)
  TeamInvitation.insert!({ id:, seller_id:, email: "invitee@example.com", role: "admin", expires_at: FIXED_NOW + 7.days, created_at: FIXED_NOW, updated_at: FIXED_NOW, **attrs })
end

[TeamInvitation, User].each { _1.columns; _1.first }
SidekiqExecutor.perform { User.first; User.transaction { User.first } }

messages = []
errors = []

# TeamMailer#invite
[
  ["invite_default", {}, {}, {}],
  ["invite_support_role", {}, { role: "support" }, {}],
  ["invite_marketing_role", {}, { role: "marketing" }, {}],
  ["invite_expires_in_one_day", {}, { expires_at: FIXED_NOW + 1.day }, {}],
  ["invite_expires_later_today", {}, { expires_at: FIXED_NOW + 3.hours }, {}],
  ["invite_plus_address", {}, { email: "invitee+team@example.com" }, {}],
  ["invite_resend", {}, {}, { "resend" => true, "force_resend" => true }],
  ["invite_united_internet", {}, { email: "invitee@web.de" }, { "resend" => true, "force_resend" => true }],
  # Silent returns: the method calls `mail` for none of these.
  ["invite_suspended_seller", { user_risk_state: "suspended_for_fraud" }, {}, {}],
  ["invite_deleted_seller", { deleted_at: FIXED_NOW - 1.day }, {}, {}],
  ["invite_deleted", {}, { deleted_at: FIXED_NOW - 1.day }, {}],
  ["invite_accepted", {}, { accepted_at: FIXED_NOW - 1.day }, {}],
  ["invite_expired", {}, { expires_at: FIXED_NOW - 1.minute }, {}],
  ["invite_owner_email", {}, { email: "owner@example.com" }, {}],
  ["invite_two_addresses", {}, { email: "a@example.com, b@example.com" }, {}],
  ["invite_display_name", {}, { email: "Some One <invitee@example.com>" }, {}],
].each do |name, seller, invitation, features|
  reset!
  insert_user(id: 201, email: "owner@example.com", username: "seller", **seller)
  insert_invitation(id: 701, seller_id: 201, **invitation)
  messages << record_job_message(name, TeamMailer, :invite, [TeamInvitation.find(701)], features:)
end
reset!
insert_user(id: 201, email: "owner@example.com", username: "seller")
insert_invitation(id: 701, seller_id: 201)
record = TeamInvitation.find(701)
TeamInvitation.where(id: 701).delete_all
serialized = ActiveJob::Arguments.serialize([record])
error = nil
statements = capture_sql do
  ActiveJob::Arguments.deserialize(serialized)
rescue => e
  error = { "class" => e.class.name, "message" => e.message }
end
errors << { "name" => "invite_missing_invitation", "mailer" => "TeamMailer", "method" => "invite", "job_args" => serialized, "statements" => statements, "error" => error }

cases = { "messages" => messages, "errors" => errors }
File.write(File.join(FIXTURES, "team-mailer.golden.json"), JSON.pretty_generate({ "now" => FIXED_NOW.iso8601, "secrets" => SMTP_SECRETS, "cases" => cases }) + "\n")
puts "wrote #{messages.size} messages, #{errors.size} errors"
