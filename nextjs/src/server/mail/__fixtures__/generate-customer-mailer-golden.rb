# frozen_string_literal: true

# Produces customer-mailer.golden.json from the real application: it boots config/environment
# in production mode against a scratch MySQL database and a scratch Redis database, then runs
# CustomerMailer exactly as Sidekiq would,
# with only the SMTP socket replaced by a recorder. Nothing here re-implements Ruby behaviour.
#
#   mysql -uroot -e 'CREATE DATABASE gumroad_ws60'   # then load db/schema.rb's tables into it
#   USE_DB_WORKER_REPLICAS=true bundle exec ruby nextjs/src/server/mail/__fixtures__/generate-customer-mailer-golden.rb
#
# The jobs run as production Sidekiq runs them (scripts/golden/support/sidekiq_executor.rb), so the
# query cache is on.
#
# Environment it needs (defaults shown): DATABASE_NAME=gumroad_ws60, REDIS_DB=10 (flushed). The
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

REDIS_DB = ENV.fetch("REDIS_DB", "10")
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
  "DATABASE_HOST" => "127.0.0.1", "DATABASE_PORT" => "3306", "DATABASE_NAME" => "gumroad_ws60",
  "DATABASE_USERNAME" => "root", "DATABASE_PASSWORD" => "password",
  "SECRET_KEY_BASE" => "x" * 64, "DEVISE_SECRET_KEY" => "d" * 64, "REVISION" => "ws60golden",
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


def record_message(name, mailer, method, args, features: {}, redis: {}, rands: [], meta: {})
  $delivered.clear
  $iv_seq = 0
  $ivs_used.clear
  features.each_key { Feature.activate(_1) }
  redis.each { |k, v| $redis.set(k, v) }
  $rands.replace(rands)
  delivery = mailer.public_send(method, *args)
  rendered = nil
  statements = capture_sql do
    rendered = delivery.message.is_a?(ActionMailer::Base::NullMail) ? nil : delivery.message.body.raw_source.dup
  end
  result = nil
  delivery_statements = capture_sql { result = delivery.deliver_now }
  {
    **meta,
    "name" => name,
    "mailer" => mailer.name,
    "method" => method.to_s,
    "job_args" => ActiveJob::Arguments.serialize(args),
    "statements" => statements,
    "delivery_statements" => delivery_statements,
    "features" => features.keys,
    "redis_before" => redis,
    "rands_used" => $rands_used.dup,
    "ivs" => $ivs_used.dup,
    "rendered_html" => rendered,
    "returned_message" => result.is_a?(Mail::Message),
    "delivered" => $delivered.dup,
    "redis_after" => $redis.keys("mail_router:*").sort.to_h { [_1, $redis.get(_1)] },
    "fallback_after" => $redis.keys("email_router_fallback:*").sort.to_h { [_1, [$redis.get(_1), $redis.ttl(_1)]] },
  }
end

# A mailer call that raises while Rails builds the message (a missing row): the delivery job fails.
def record_error(name, mailer, method, args)
  $rands.clear
  delivery = mailer.public_send(method, *args)
  error = nil
  statements = capture_sql do
    delivery.message
  rescue => e
    error = { "class" => e.class.name, "message" => e.message }
  end
  { "name" => name, "mailer" => mailer.name, "method" => method.to_s, "job_args" => ActiveJob::Arguments.serialize(args), "statements" => statements, "error" => error }
end

# --- fixtures --------------------------------------------------------------------------------------
TABLES = %w[users links purchases subscriptions url_redirects purchase_presentments calls refunds email_infos].freeze
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

def insert_link(id:, user_id:, **attrs)
  Link.insert!({ id:, user_id:, name: "Product #{id}", unique_permalink: "perm#{id}", price_cents: 100, created_at: FIXED_NOW, updated_at: FIXED_NOW, **attrs })
end

def insert_purchase(id:, link_id:, seller_id:, **attrs)
  Purchase.insert!({ id:, link_id:, seller_id:, email: "buyer@example.com", purchase_state: "successful", price_cents: 100, total_transaction_cents: 100,
                     displayed_price_cents: 100, displayed_price_currency_type: "usd", rate_converted_to_usd: "1", created_at: FIXED_NOW, updated_at: FIXED_NOW, **attrs })
end

def insert_subscription(id:, link_id:, user_id: nil, **attrs)
  Subscription.insert!({ id:, link_id:, user_id:, created_at: FIXED_NOW, updated_at: FIXED_NOW, **attrs })
end

# Rails.cache is the first place User#mailer_level looks, the Redis namespace the second; with neither
# it sums the seller's sales in Elasticsearch, which the Node port does not do. Cases seed one.
def seed_mailer_level(user_id, via, level)
  key = "creator_mailer_level_#{user_id}"
  Rails.cache.delete(key)
  case via
  when :cache then Rails.cache.write(key, level, expires_in: 2.days)
  when :redis then Redis::Namespace.new(:user_mailer_redis_namespace, redis: $redis).set(key, level.to_s)
  end
  { "mailer_level" => { "via" => via.to_s, "level" => level.to_s } }
end

# Warm the schema cache so the recorded statements are the mailers' own.
[User, Link, Purchase, Subscription, UrlRedirect, PurchasePresentment, Price, Preorder, PreorderLink].each { _1.columns; _1.first }
SidekiqExecutor.perform { User.first; User.transaction { User.first } }

messages = []
errors = []

# CustomerMailer#paypal_purchase_failed
[
  ["paypal_failed_subdomain", { username: "seller_name" }, {}, {}],
  ["paypal_failed_no_username", {}, {}, {}],
  ["paypal_failed_custom_permalink", { username: "seller" }, { custom_permalink: "my-thing" }, {}],
  ["paypal_failed_html_name", { username: "seller" }, { name: "Tom & Jerry's <Guide>" }, {}],
  ["paypal_failed_resend", { username: "seller" }, {}, { "resend" => true, "force_resend" => true }],
  ["paypal_failed_united_internet", { username: "seller" }, {}, { "resend" => true, "force_resend" => true }, { email: "buyer@web.de" }],
].each do |name, seller, link, features, purchase = {}|
  reset!
  insert_user(id: 201, email: "seller@example.com", **seller)
  insert_link(id: 301, user_id: 201, **link)
  insert_purchase(id: 401, link_id: 301, seller_id: 201, **purchase)
  meta = seed_mailer_level(201, name.end_with?("resend") ? :redis : :cache, name.end_with?("resend") ? :level_2 : :level_1)
  messages << record_message(name, CustomerMailer, :paypal_purchase_failed, [401], features:, meta:)
end
reset!
errors << record_error("paypal_failed_missing_purchase", CustomerMailer, :paypal_purchase_failed, [404])

# CustomerMailer#subscription_magic_link
[
  ["magic_link_default", "buyer@example.com", {}, {}],
  ["magic_link_html_name", "buyer@example.com", { name: "Tom & Jerry's <Guide>" }, {}],
  ["magic_link_resend", "buyer@example.com", {}, { "resend" => true, "force_resend" => true }],
  ["magic_link_united_internet", "buyer@web.de", {}, { "resend" => true, "force_resend" => true }],
  ["magic_link_invalid_email", "not-an-email", {}, {}],
  ["magic_link_blank_email", "", {}, {}],
].each do |name, email, link, features|
  reset!
  insert_user(id: 201, email: "seller@example.com", username: "seller")
  insert_link(id: 301, user_id: 201, **link)
  insert_subscription(id: 501, link_id: 301, token: "0123456789abcdef0123456789abcdef0123456789abcdef", token_expires_at: FIXED_NOW + 1.day)
  messages << record_message(name, CustomerMailer, :subscription_magic_link, [501, email], features:)
end
reset!
errors << record_error("magic_link_missing_subscription", CustomerMailer, :subscription_magic_link, [404, "buyer@example.com"])

# CustomerMailer#files_ready_for_download
def insert_url_redirect(id:, purchase_id:, link_id:, **attrs)
  UrlRedirect.insert!({ id:, purchase_id:, link_id:, token: "tok#{id}abcdef", created_at: FIXED_NOW, updated_at: FIXED_NOW, **attrs })
end

[
  ["files_ready_default", { name: "Seller Name" }, {}, {}, {}],
  ["files_ready_button_text", { name: "Seller Name" }, { json_data: { "custom_view_content_button_text" => "Get <it> now" } }, {}, {}],
  ["files_ready_link_support_email", { name: "Seller Name" }, { support_email: "link-support@example.com" }, {}, {}],
  ["files_ready_user_support_email", { name: "Seller Name", support_email: "user-support@example.com" }, {}, {}, {}],
  ["files_ready_colon_in_name", { name: "Seller: The Shop" }, {}, {}, {}],
  ["files_ready_no_name", { name: nil }, {}, {}, {}],
  ["files_ready_html_product", { name: "Seller Name" }, { name: "Tom & Jerry's <Guide>" }, {}, {}],
  ["files_ready_resend", { name: "Seller Name" }, {}, { "resend" => true, "force_resend" => true }, {}],
  ["files_ready_united_internet", { name: "Seller Name" }, {}, { "resend" => true, "force_resend" => true }, { email: "buyer@gmx.de" }],
].each do |name, seller, link, features, purchase|
  reset!
  insert_user(id: 201, email: "seller@example.com", username: "seller", **seller)
  insert_link(id: 301, user_id: 201, **link)
  insert_purchase(id: 401, link_id: 301, seller_id: 201, **purchase)
  insert_url_redirect(id: 601, purchase_id: 401, link_id: 301)
  meta = seed_mailer_level(201, :cache, :level_1)
  messages << record_message(name, CustomerMailer, :files_ready_for_download, [401], features:, meta:)
end
reset!
insert_user(id: 201, email: "seller@example.com", username: "seller")
insert_link(id: 301, user_id: 201)
insert_purchase(id: 401, link_id: 301, seller_id: 201)
seed_mailer_level(201, :cache, :level_1)
errors << record_error("files_ready_no_url_redirect", CustomerMailer, :files_ready_for_download, [401])
errors << record_error("files_ready_missing_purchase", CustomerMailer, :files_ready_for_download, [404])

# CustomerMailer#refund and #partial_refund
REFUND_CASES = [
  ["default", { name: "Seller Name" }, {}, {}, { total_transaction_cents: 1234 }],
  ["ninety_nine_cents", { name: "Seller Name" }, {}, {}, { total_transaction_cents: 99 }],
  ["thousands", { name: "Seller Name" }, {}, {}, { total_transaction_cents: 123_456_789 }],
  ["whole_dollars", { name: "Seller Name" }, {}, {}, { total_transaction_cents: 500 }],
  ["html_product", { name: "Seller Name" }, { name: "Tom & Jerry's <Guide>" }, {}, { total_transaction_cents: 1234 }],
  ["user_support_email", { name: "Seller Name", support_email: "user-support@example.com" }, {}, {}, { total_transaction_cents: 1234 }],
  ["no_name", { name: nil }, {}, {}, { total_transaction_cents: 1234 }],
  ["resend", { name: "Seller Name" }, {}, { "resend" => true, "force_resend" => true }, { total_transaction_cents: 1234 }],
]
REFUND_CASES.each do |name, seller, link, features, purchase|
  reset!
  insert_user(id: 201, email: "seller@example.com", username: "seller", **seller)
  insert_link(id: 301, user_id: 201, **link)
  insert_purchase(id: 401, link_id: 301, seller_id: 201, **purchase)
  meta = seed_mailer_level(201, :cache, :level_1)
  messages << record_message("refund_#{name}", CustomerMailer, :refund, ["buyer@example.com", 301, 401], features:, meta:)
  messages << record_message("partial_refund_#{name}", CustomerMailer, :partial_refund, ["buyer@example.com", 301, 401, 250, "partially"], features:, meta:)
end
reset!
insert_user(id: 201, email: "seller@example.com", username: "seller", name: "Seller Name")
insert_link(id: 301, user_id: 201)
insert_purchase(id: 401, link_id: 301, seller_id: 201, total_transaction_cents: 1234)
seed_mailer_level(201, :cache, :level_1)
messages << record_message("partial_refund_whole_amount", CustomerMailer, :partial_refund, ["buyer@gmx.de", 301, 401, 1000, "<fully> & more"], features: { "resend" => true, "force_resend" => true }, meta: seed_mailer_level(201, :cache, :level_1))
reset!
insert_user(id: 201, email: "seller@example.com", username: "seller", name: "Seller Name")
insert_link(id: 301, user_id: 201)
insert_purchase(id: 401, link_id: 301, seller_id: 201, total_transaction_cents: 1234)
messages << record_message("partial_refund_ninety_nine", CustomerMailer, :partial_refund, ["buyer@example.com", 301, 401, 99, "partially"], meta: seed_mailer_level(201, :cache, :level_1))
errors << record_error("refund_without_purchase", CustomerMailer, :refund, ["buyer@example.com", 301, nil])
errors << record_error("refund_missing_link", CustomerMailer, :refund, ["buyer@example.com", 404, 401])
errors << record_error("refund_missing_purchase", CustomerMailer, :refund, ["buyer@example.com", 301, 404])
errors << record_error("partial_refund_without_purchase", CustomerMailer, :partial_refund, ["buyer@example.com", 301, nil, 250, "partially"])
# The buyer-currency (presentment) wording and non-USD products format money through Money/CURRENCY_CHOICES, which Node does not port.
reset!
insert_user(id: 201, email: "seller@example.com", username: "seller", name: "Seller Name")
insert_link(id: 301, user_id: 201)
insert_purchase(id: 401, link_id: 301, seller_id: 201, total_transaction_cents: 1234)
PurchasePresentment.insert!({ purchase_id: 401, presentment_currency: "eur", presentment_gumroad_amount_cents: 100, presentment_price_cents: 1000, presentment_total_cents: 1100, processor: "stripe", created_at: FIXED_NOW, updated_at: FIXED_NOW })
seed_mailer_level(201, :cache, :level_1)
refused = []
refused << record_message("refund_presentment", CustomerMailer, :refund, ["buyer@example.com", 301, 401], meta: seed_mailer_level(201, :cache, :level_1))
refused << record_message("partial_refund_presentment", CustomerMailer, :partial_refund, ["buyer@example.com", 301, 401, 250, "partially", 220, "eur"], meta: seed_mailer_level(201, :cache, :level_1))
reset!
insert_user(id: 201, email: "seller@example.com", username: "seller", name: "Seller Name")
insert_link(id: 301, user_id: 201, price_currency_type: "eur")
insert_purchase(id: 401, link_id: 301, seller_id: 201, total_transaction_cents: 1234, displayed_price_currency_type: "eur", rate_converted_to_usd: "1.2")
refused << record_message("refund_euro", CustomerMailer, :refund, ["buyer@example.com", 301, 401], meta: seed_mailer_level(201, :cache, :level_1))
refused << record_message("partial_refund_euro", CustomerMailer, :partial_refund, ["buyer@example.com", 301, 401, 250, "partially"], meta: seed_mailer_level(201, :cache, :level_1))

# CustomerMailer#preorder_receipt: the receipt of a preorder, read through its authorization purchase.
def preorder_setup(seller: {}, link: {}, release_at: Time.utc(2026, 12, 25, 17, 0, 0), purchase: {})
  reset!
  %w[preorders preorder_links].each { ActiveRecord::Base.connection.execute("DELETE FROM #{_1}") }
  insert_user(id: 201, email: "seller@example.com", username: "seller", name: "Seller Name", **seller)
  insert_link(id: 301, user_id: 201, **link)
  ActiveRecord::Base.connection.execute("INSERT INTO preorder_links (id, link_id, state, release_at, created_at, updated_at) VALUES (801, 301, 'unreleased', #{ActiveRecord::Base.connection.quote(release_at)}, '#{FIXED_NOW.to_fs(:db)}', '#{FIXED_NOW.to_fs(:db)}')")
  ActiveRecord::Base.connection.execute("INSERT INTO preorders (id, preorder_link_id, seller_id, state, created_at, updated_at) VALUES (901, 801, 201, 'authorization_successful', '#{FIXED_NOW.to_fs(:db)}', '#{FIXED_NOW.to_fs(:db)}')")
  insert_purchase(id: 401, link_id: 301, seller_id: 201, preorder_id: 901, purchase_state: "preorder_authorization_successful", flags: 1 << 12, **purchase)
  seed_mailer_level(201, :cache, :level_1)
end
PREORDER_SHIPPING = { full_name: "Ada Lovelace", street_address: "1 Analytical Way", city: "London", state: "LDN", zip_code: "N1 9GU", country: "United Kingdom" }.freeze
[
  ["preorder_receipt_digital", {}, {}, Time.utc(2026, 12, 25, 17, 0, 0), {}, {}],
  ["preorder_receipt_minutes", {}, {}, Time.utc(2026, 12, 25, 17, 30, 0), {}, {}],
  ["preorder_receipt_utc_seller", { timezone: "UTC" }, {}, Time.utc(2026, 7, 1, 0, 0, 0), {}, {}],
  ["preorder_receipt_summer_time", {}, {}, Time.utc(2026, 7, 4, 19, 15, 0), {}, {}],
  ["preorder_receipt_eastern_zone", { timezone: "Eastern Time (US & Canada)" }, {}, Time.utc(2026, 7, 4, 19, 15, 0), {}, {}],
  ["preorder_receipt_central_zone", { timezone: "Central Time (US & Canada)" }, {}, Time.utc(2026, 1, 4, 19, 15, 0), {}, {}],
  ["preorder_receipt_mountain_zone", { timezone: "Mountain Time (US & Canada)" }, {}, Time.utc(2026, 1, 4, 19, 15, 0), {}, {}],
  ["preorder_receipt_ordinals", {}, {}, Time.utc(2026, 11, 22, 20, 0, 0), {}, {}],
  ["preorder_receipt_html_names", {}, { name: "Tom & Jerry's <Guide>" }, Time.utc(2026, 12, 25, 17, 0, 0), {}, {}],
  ["preorder_receipt_link_support_email", {}, { support_email: "link-support@example.com" }, Time.utc(2026, 12, 25, 17, 0, 0), {}, {}],
  ["preorder_receipt_resend", {}, {}, Time.utc(2026, 12, 25, 17, 0, 0), {}, { "resend" => true, "force_resend" => true }],
  ["preorder_receipt_physical", {}, { flags: 128 }, Time.utc(2026, 12, 25, 17, 0, 0), PREORDER_SHIPPING, {}],
  ["preorder_receipt_physical_html_address", {}, { flags: 128 }, Time.utc(2026, 12, 25, 17, 0, 0), PREORDER_SHIPPING.merge(full_name: "A & B <C>", street_address: "1 \"Main\" St"), {}],
].each do |name, seller, link, release_at, purchase, features|
  preorder_setup(seller:, link:, release_at:, purchase:)
  messages << record_message(name, CustomerMailer, :preorder_receipt, [901], features:, meta: seed_mailer_level(201, :cache, :level_1))
end
preorder_setup
preorder_setup
errors << record_error("preorder_receipt_missing_preorder", CustomerMailer, :preorder_receipt, [404])
preorder_setup(seller: { timezone: "Kolkata" })
refused << record_message("preorder_receipt_kolkata_zone", CustomerMailer, :preorder_receipt, [901], meta: seed_mailer_level(201, :cache, :level_1))

cases = { "messages" => messages, "errors" => errors, "refused" => refused }
File.write(File.join(FIXTURES, "customer-mailer.golden.json"), JSON.pretty_generate({ "now" => FIXED_NOW.iso8601, "secrets" => SMTP_SECRETS, "cases" => cases }) + "\n")
puts "wrote #{messages.size} messages, #{errors.size} errors"
