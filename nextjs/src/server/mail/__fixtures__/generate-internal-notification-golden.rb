# frozen_string_literal: true

# Produces internal-notification.golden.json from the real application: InternalNotificationWorker
# (and so InternalNotificationMailer#notify) run as production Sidekiq runs a job, in production mode
# against a scratch MySQL database and Redis database, with only the SMTP socket and S3 replaced by
# recorders. Nothing here re-implements Ruby behaviour.
#
#   USE_DB_WORKER_REPLICAS=true DATABASE_NAME=gumroad_ws42 REDIS_DB=13 \
#     bundle exec ruby nextjs/src/server/mail/__fixtures__/generate-internal-notification-golden.rb
#
# S3 is a local socket that serves the objects a case declares, so the requests Aws::S3::Object
# sends (HEAD for the size, then GET) are recorded. The Date, Message-ID and MIME boundary stay
# random; the Node test reads them back from `encoded`.
require "fileutils"
require "json"
require "socket"

ROOT = File.expand_path("../../../../..", __dir__)
FIXTURES = __dir__
Dir.chdir(ROOT)

REDIS_DB = ENV.fetch("REDIS_DB", "13")
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
  "MAILER_HEADERS_ENCRYPTION_KEY_V1" => "ws42-golden-header-key",
  "AWS_ACCESS_KEY_ID" => "minioadmin",
  "AWS_SECRET_ACCESS_KEY" => "minioadmin",
}.freeze

# VARIANT=config records a few rooms with the recipient settings overridden (internal-notification-config.golden.json).
VARIANT = ENV.fetch("VARIANT", "default")
CONFIG_OVERRIDES = { "INTERNAL_NOTIFICATION_EMAIL" => "ops@example.com", "PAYMENTS_NOTIFICATION_EMAIL" => "", "INTERNAL_NOTIFICATION_ALWAYS_CC" => "" }.freeze
CONFIG_OVERRIDES.each { |k, v| ENV[k] = v } if VARIANT == "config"

ENV["RAILS_ENV"] = "production"
ENV["TZ"] = "UTC"
{
  "DATABASE_HOST" => "127.0.0.1", "DATABASE_PORT" => "3306", "DATABASE_NAME" => "gumroad_ws42",
  "DATABASE_USERNAME" => "root", "DATABASE_PASSWORD" => "password",
  "SECRET_KEY_BASE" => "x" * 64, "DEVISE_SECRET_KEY" => "d" * 64, "REVISION" => "ws42golden",
  "MEMCACHE_SERVERS" => "localhost:11211", "ELASTICSEARCH_HOST" => "http://localhost:9200",
}.each { |k, v| ENV[k] ||= v }
%w[REDIS_HOST SIDEKIQ_REDIS_HOST RPUSH_REDIS_HOST RACK_ATTACK_REDIS_HOST].each { |k| ENV[k] = "localhost:6379/#{REDIS_DB}" }
SMTP_SECRETS.each { |k, v| ENV[k] = v }
abort "Use a scratch database, not #{ENV["DATABASE_NAME"]}" if %w[gumroad_test gumroad_development gumroad_production].include?(ENV["DATABASE_NAME"])

require "dotenv"
Dotenv.parse(File.join(ROOT, ".env.test")).each { |k, v| ENV[k] ||= v unless k.start_with?("AWS_") }

require File.join(ROOT, "config/environment")
Rails.logger = ActiveSupport::Logger.new(nil)
ActiveRecord::Base.logger = nil
ActionMailer::Base.logger = nil
ActiveJob::Base.logger = Logger.new(nil)

require "active_support/testing/time_helpers"
require File.join(ROOT, "nextjs/scripts/golden/support/sidekiq_executor")

# Message-IDs embed the host name; pin it so goldens don't record the machine they ran on.
Socket.singleton_class.prepend(Module.new { def gethostname = "mail-host.example" })
include ActiveSupport::Testing::TimeHelpers
FIXED_NOW = Time.utc(2026, 10, 31, 12, 0, 0)
travel_to(FIXED_NOW)

$iv_seq = 0
$ivs_used = []
OpenSSL::Cipher.prepend(Module.new do
  def random_iv
    $iv_seq += 1
    iv = format("ws42-iv-%08d", $iv_seq)
    $ivs_used << Base64.strict_encode64(iv)
    self.iv = iv
  end
end)

# --- SMTP recorder -----------------------------------------------------------------------------------
$delivered = []
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

# --- S3: a socket that serves declared objects and records every request --------------------------------
module S3Capture
  OBJECTS = {}
  REQUESTS = []
  IGNORED_HEADERS = %w[authorization x-amz-date x-amz-content-sha256 user-agent amz-sdk-invocation-id x-amz-security-token].freeze

  class << self
    def start
      server = TCPServer.new("127.0.0.1", 0)
      Thread.new { loop { Thread.new(server.accept) { |socket| serve(socket) } } }
      server.addr[1]
    end

    def serve(socket)
      method, target = socket.gets.split(" ")
      headers = {}
      while (line = socket.gets) && line != "\r\n"
        key, value = line.split(": ", 2)
        headers[key.downcase] = value.strip
      end
      path, query = target.split("?", 2)
      REQUESTS << { "method" => method, "path" => path, "query" => query, "headers" => headers.except(*IGNORED_HEADERS, "host") }
      body = OBJECTS[path]
      if body.nil?
        error = %(<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>)
        socket.write("HTTP/1.1 404 Not Found\r\nContent-Type: application/xml\r\nContent-Length: #{error.bytesize}\r\nConnection: close\r\n\r\n#{method == "HEAD" ? "" : error}")
      else
        socket.write("HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: #{body.bytesize}\r\nETag: \"etag\"\r\nConnection: close\r\n\r\n")
        socket.write(body) unless method == "HEAD"
      end
    ensure
      socket.close
    end
  end
end
S3_PORT = S3Capture.start
Aws.config.update(endpoint: "http://127.0.0.1:#{S3_PORT}", s3: { force_path_style: true }, retry_limit: 0)

def reset!
  $redis.flushdb
  $iv_seq = 0
  $ivs_used.clear
  $delivered.clear
  $smtp_failures.clear
  S3Capture::OBJECTS.clear
  S3Capture::REQUESTS.clear
end

CSV_BODY = "id,amount\n1,100\n2,250\n"
BIG = 7 * 1024 * 1024

# Each case is the job's `perform` arguments as Sidekiq hands them over (JSON), plus the objects S3 holds.
cases = [
  ["plain message", ["risk", "Iffy", "Everything is fine."], {}],
  ["payments room is finance plus the always-cc", ["payments", "VAT Rate Updater", "VAT rate has changed for DE from 0.19 to 0.2", "green"], {}],
  ["agent reports room is the always-cc itself", ["agent_reports", "Agent", "Nothing to cc twice."], {}],
  ["unknown room sends nothing", ["nowhere", "Agent", "Dropped."], {}],
  ["multi-paragraph markup", ["announcements", "Release <bot> & co", "Line one\nstill one\n\nSecond <b>paragraph</b> with a link https://example.com/a?b=1&c=2\n\n\n\nThird <script>alert(1)</script>"], {}],
  ["empty message", ["test", "Sender", ""], {}],
  ["attachments data", ["internals_log", "Reporter", "See details", "gray", { "attachments" => [
    { "fallback" => "Plain fallback", "text" => "Plain fallback" },
    { "fallback" => "Fallback only\nsecond line" },
    { "text" => "Text only <i>italic</i>" },
    { "fallback" => "One", "text" => "Two" },
    { "fallback" => "", "text" => "" },
    { "title" => "ignored" },
  ] }], {}],
  ["one s3 attachment", ["payments", "Reports", "Report ready", "green", { "s3_attachments" => [{ "bucket" => "gumroad-reporting", "key" => "reports/a.csv", "filename" => "a.csv" }] }],
   { "/gumroad-reporting/reports/a.csv" => CSV_BODY }],
  ["s3 attachment with a mime type", ["payments", "Reports", "Report ready", "green", { "s3_attachments" => [{ "bucket" => "gumroad-reporting", "key" => "reports/b.json", "filename" => "b.json", "mime_type" => "application/json" }] }],
   { "/gumroad-reporting/reports/b.json" => "{\"a\": 1}" }],
  ["s3 attachment with a blank mime type", ["payments", "Reports", "Report ready", "green", { "s3_attachments" => [{ "bucket" => "gumroad-reporting", "key" => "reports/c.csv", "filename" => "c.csv", "mime_type" => "  " }] }],
   { "/gumroad-reporting/reports/c.csv" => CSV_BODY }],
  ["several attachments and attachments data", ["payments", "Reports", "Two reports", "green", {
    "attachments" => [{ "fallback" => "Fallback" }],
    "s3_attachments" => [
      { "bucket" => "gumroad-reporting", "key" => "reports/a.csv", "filename" => "a.csv" },
      { "bucket" => "other-bucket", "key" => "deep/path with space/b.csv", "filename" => "b.csv", "mime_type" => "text/csv" },
    ],
  }], { "/gumroad-reporting/reports/a.csv" => CSV_BODY, "/other-bucket/deep/path%20with%20space/b.csv" => "x,y\n" }],
  ["utf-8 and binary content", ["payments", "Reports", "Content", "green", { "s3_attachments" => [
    { "bucket" => "gumroad-reporting", "key" => "k/utf8.csv", "filename" => "utf8.csv" },
    { "bucket" => "gumroad-reporting", "key" => "k/bin.bin", "filename" => "bin.bin", "mime_type" => "application/octet-stream" },
    { "bucket" => "gumroad-reporting", "key" => "k/empty.csv", "filename" => "empty.csv" },
  ] }], { "/gumroad-reporting/k/utf8.csv" => "name,city\nZoë,São Paulo\n".b, "/gumroad-reporting/k/bin.bin" => (0..255).map(&:chr).join.b * 3, "/gumroad-reporting/k/empty.csv" => "" }],
  ["long content and crlf lines", ["payments", "Reports", "Big", "green", { "s3_attachments" => [
    { "bucket" => "gumroad-reporting", "key" => "k/long.csv", "filename" => "long.csv" },
    { "bucket" => "gumroad-reporting", "key" => "k/crlf.csv", "filename" => "crlf.csv" },
  ] }], { "/gumroad-reporting/k/long.csv" => ("a,b,c,d,e,f,g,h\n" * 200), "/gumroad-reporting/k/crlf.csv" => "a,b\r\n1,2\r\n" }],
  ["oversized attachment is skipped", ["payments", "Reports", "Too big", "green", { "s3_attachments" => [
    { "bucket" => "gumroad-reporting", "key" => "k/huge.csv", "filename" => "huge.csv" },
    { "bucket" => "gumroad-reporting", "key" => "k/small.csv", "filename" => "small.csv" },
  ] }], { "/gumroad-reporting/k/huge.csv" => "x" * (BIG + 1), "/gumroad-reporting/k/small.csv" => CSV_BODY }],
  ["attachment exactly at the limit", ["payments", "Reports", "Edge", "green", { "s3_attachments" => [{ "bucket" => "gumroad-reporting", "key" => "k/edge.csv", "filename" => "edge.csv" }] }],
   { "/gumroad-reporting/k/edge.csv" => "x" * BIG }],
  ["missing object", ["payments", "Reports", "Gone", "green", { "s3_attachments" => [{ "bucket" => "gumroad-reporting", "key" => "k/missing.csv", "filename" => "missing.csv" }] }], {}],
  ["attachment without a filename", ["payments", "Reports", "No name", "green", { "s3_attachments" => [{ "bucket" => "gumroad-reporting", "key" => "k/a.csv" }] }], { "/gumroad-reporting/k/a.csv" => CSV_BODY }],
  ["attachments on a room that sends nothing", ["nowhere", "Reports", "Skipped", "green", { "s3_attachments" => [{ "bucket" => "gumroad-reporting", "key" => "k/a.csv", "filename" => "a.csv" }] }], { "/gumroad-reporting/k/a.csv" => CSV_BODY }],
  ["odd filenames", ["payments", "Reports", "Names", "green", { "s3_attachments" => [
    { "bucket" => "gumroad-reporting", "key" => "k/a.csv", "filename" => "report 2026 (final).csv" },
    { "bucket" => "gumroad-reporting", "key" => "k/a.csv", "filename" => "quo\"te.csv" },
    { "bucket" => "gumroad-reporting", "key" => "k/a.csv", "filename" => "a.csv" },
  ] }], { "/gumroad-reporting/k/a.csv" => CSV_BODY }],
  ["non-ascii filename", ["payments", "Reports", "Names", "green", { "s3_attachments" => [{ "bucket" => "gumroad-reporting", "key" => "k/a.csv", "filename" => "reporté.csv" }] }], { "/gumroad-reporting/k/a.csv" => CSV_BODY }],
  *%w[announcements awards internals_log migrations payments payouts risk test agent_reports].map { |room| ["room #{room}", [room, "Sender", "To #{room}"], {}] },
  ["token-like filenames", ["payments", "Reports", "Names", "green", { "s3_attachments" => [
    { "bucket" => "gumroad-reporting", "key" => "k/a.csv", "filename" => "VAT_report-Q1.2026.csv" },
    { "bucket" => "gumroad-reporting", "key" => "k/a.csv", "filename" => "fees-by-creator-location-report-2026-10-ab12cd34.csv" },
    { "bucket" => "gumroad-reporting", "key" => "k/a.csv", "filename" => "#{"very-long-" * 12}name.csv" },
    { "bucket" => "gumroad-reporting", "key" => "k/a.csv", "filename" => "2026" },
    { "bucket" => "gumroad-reporting", "key" => "k/a.csv", "filename" => "a_b-c.D" },
  ] }], { "/gumroad-reporting/k/a.csv" => CSV_BODY }],
  ["content types and charsets", ["payments", "Reports", "Types", "green", { "s3_attachments" => [
    { "bucket" => "gumroad-reporting", "key" => "k/json", "filename" => "j.json", "mime_type" => "application/json" },
    { "bucket" => "gumroad-reporting", "key" => "k/latin1", "filename" => "l.csv" },
    { "bucket" => "gumroad-reporting", "key" => "k/ascii", "filename" => "t.txt", "mime_type" => "text/plain" },
    { "bucket" => "gumroad-reporting", "key" => "k/ascii", "filename" => "x.xls", "mime_type" => "application/vnd.ms-excel" },
    { "bucket" => "gumroad-reporting", "key" => "k/ascii", "filename" => "u.csv", "mime_type" => "TEXT/CSV" },
    { "bucket" => "gumroad-reporting", "key" => "k/ascii", "filename" => "p.csv", "mime_type" => "text/csv; charset=latin1" },
    { "bucket" => "gumroad-reporting", "key" => "k/ascii", "filename" => "e.bin", "mime_type" => "application/octet-stream" },
    { "bucket" => "gumroad-reporting", "key" => "k/utf8", "filename" => "o.bin", "mime_type" => "application/octet-stream" },
    { "bucket" => "gumroad-reporting", "key" => "k/utf8", "filename" => "h.html", "mime_type" => "text/html" },
  ] }], { "/gumroad-reporting/k/json" => "{\"name\": \"Zoë\"}".b, "/gumroad-reporting/k/latin1" => "caf\xE9,1\n".b, "/gumroad-reporting/k/ascii" => CSV_BODY, "/gumroad-reporting/k/utf8" => "Zoë ☕\n<p>x</p>\n".b }],
  ["only an oversized attachment", ["payments", "Reports", "Too big", "green", { "s3_attachments" => [{ "bucket" => "gumroad-reporting", "key" => "k/huge.csv", "filename" => "huge.csv" }] }], { "/gumroad-reporting/k/huge.csv" => "x" * (BIG + 1) }],
  ["attachments data with an empty s3 list", ["risk", "Iffy", "Hi", "gray", { "attachments" => [{ "fallback" => "F" }], "s3_attachments" => [] }], {}],
  ["long subject",["payments", "A sender whose name is long enough to push the subject past the folding limit of the line", "Long"], {}],
  ["non-ascii sender", ["payments", "Zoë", "Hello"], {}],
  ["non-ascii message", ["payments", "Sender", "Café ☕ — naïve\n\nsecond"], {}],
  ["resend provider", ["payments", "Sender", "Hello"], {}, { "resend" => true, "force_resend" => true }],
  ["smtp rejects the message", ["payments", "Sender", "Hello"], {}, {}, Net::SMTPFatalError.new(Net::SMTP::Response.parse("550 5.7.1 rejected"))],
  ["smtp timeout", ["payments", "Sender", "Hello"], {}, {}, Net::OpenTimeout.new("execution expired")],
]

if VARIANT == "config"
  cases = [
    ["risk room uses the overridden recipient", ["risk", "Iffy", "Hi"], {}],
    ["payments room has a blank recipient and sends nothing", ["payments", "Iffy", "Hi"], {}],
    ["agent reports room has a blank recipient and sends nothing", ["agent_reports", "Iffy", "Hi"], {}],
  ]
end

# Warm connections so the recorded work is the job's own.
SidekiqExecutor.perform { User.first }

recorded = cases.map do |name, args, objects, features, failure|
  reset!
  (features || {}).each_key { Feature.activate(_1) }
  objects.each { |path, body| S3Capture::OBJECTS[path] = body }
  $smtp_failures.replace([failure].compact)
  error = nil
  begin
    SidekiqExecutor.perform { InternalNotificationWorker.new.perform(*JSON.parse(JSON.generate(args))) }
  rescue => e
    error = { "class" => e.class.name, "message" => e.message }
  end
  {
    "name" => name,
    "args" => args,
    "objects" => objects.to_h { |path, body| [path, { "size" => body.bytesize, "base64" => body.bytesize > 4096 ? nil : Base64.strict_encode64(body) }] },
    "features" => (features || {}).keys,
    "error" => error,
    "s3_requests" => S3Capture::REQUESTS.dup,
    "ivs" => $ivs_used.dup,
    "delivered" => $delivered.dup,
  }
end

output = VARIANT == "config" ? "internal-notification-config.golden.json" : "internal-notification.golden.json"
File.write(File.join(FIXTURES, output), JSON.pretty_generate({ "now" => FIXED_NOW.iso8601, "secrets" => SMTP_SECRETS, "overrides" => (VARIANT == "config" ? CONFIG_OVERRIDES : {}), "cases" => recorded }) + "\n")
puts "wrote #{recorded.size} cases"
