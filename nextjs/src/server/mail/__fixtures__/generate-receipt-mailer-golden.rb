# frozen_string_literal: true

# Produces receipt-mailer.golden.json from the real application: it boots config/environment
# in production mode against a scratch MySQL database and a scratch Redis database, then runs
# the receipt mailers exactly as Sidekiq would,
# with only the SMTP socket replaced by a recorder. Nothing here re-implements Ruby behaviour.
#
#   mysql -uroot -e 'CREATE DATABASE gumroad_ws76'   # then load db/schema.rb's tables into it
#   USE_DB_WORKER_REPLICAS=true bundle exec ruby nextjs/src/server/mail/__fixtures__/generate-customer-mailer-golden.rb
#
# The jobs run as production Sidekiq runs them (scripts/golden/support/sidekiq_executor.rb), so the
# query cache is on.
#
# Environment it needs (defaults shown): DATABASE_NAME=gumroad_ws76, REDIS_DB=10 (flushed). The
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
  "SECURE_EXTERNAL_ID__PRIMARY_KEY_VERSION" => "1",
  "SECURE_EXTERNAL_ID__KEYS__1" => "ws76-secure-external-id-key-0001",
}.freeze

ENV["RAILS_ENV"] = "production"
ENV["TZ"] = "UTC"
{
  "DATABASE_HOST" => "127.0.0.1", "DATABASE_PORT" => "3306", "DATABASE_NAME" => "gumroad_ws76",
  "DATABASE_USERNAME" => "root", "DATABASE_PASSWORD" => "password",
  "SECRET_KEY_BASE" => "x" * 64, "DEVISE_SECRET_KEY" => "d" * 64, "REVISION" => "ws76golden",
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
    # iv_len is 16 for the X-GUM headers' CBC and 12 for SecureExternalId's GCM; the sequence leads so both stay distinct.
    iv = format("%06d-ws76-iv-x", $iv_seq)[0, iv_len]
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
# Schema introspection and connection setup, sent once per process by whichever statement touches a table
# first; Node has no schema cache to warm, so they are not part of what a render sends.
SCHEMA_STATEMENT = /\A(SHOW FULL FIELDS|SHOW CREATE TABLE|SET NAMES|SELECT column_name\s+FROM information_schema)/
module RecordStatements
  def perform_query(raw_connection, sql, *rest, **kwargs)
    result = super
    if $sql && !SCHEMA_STATEMENT.match?(sql)
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
  delivery = nil
  rendered = nil
  statements = nil
  delivery_statements = nil
  result = nil
  SidekiqExecutor.perform do
    statements = capture_sql do
      delivery = mailer.public_send(method, *args)
      rendered = delivery.message.is_a?(ActionMailer::Base::NullMail) ? nil : delivery.message.body.raw_source.dup
    end
    # EmailDeliveryObserver's CustomerEmailInfo write happens after the SMTP hand-off.
    delivery_statements = capture_sql { result = delivery.deliver_now }
  end
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
TABLES = %w[users links purchases subscriptions url_redirects purchase_presentments calls refunds prices charges charge_purchases orders order_purchases
            customer_email_infos email_infos product_files thumbnails gifts preorders base_variants base_variants_purchases purchase_custom_fields purchase_refund_policies tips product_files].freeze
def reset!
  conn = ActiveRecord::Base.connection
  TABLES.each { |t| conn.execute("DELETE FROM #{t}") if conn.table_exists?(t) }
  $redis.flushdb
  $rands.clear
  $rands_used.clear
  $iv_seq = 0
  $ivs_used.clear
  $delivered.clear
  $smtp_failures.clear
end

def insert_user(id:, **attrs)
  User.insert!({ id:, recommendation_type: "no_recommendations", external_id: (8_000_000_000_000 + id).to_s, created_at: FIXED_NOW, updated_at: FIXED_NOW, **attrs })
end

def insert_link(id:, user_id:, **attrs)
  Link.insert!({ id:, user_id:, name: "Product #{id}", unique_permalink: "perm#{id}", price_cents: 100, created_at: FIXED_NOW, updated_at: FIXED_NOW, **attrs })
end

def insert_purchase(id:, link_id:, seller_id:, **attrs)
  Purchase.insert!({ id:, link_id:, seller_id:, email: "buyer@example.com", purchase_state: "successful", price_cents: 100, total_transaction_cents: 100,
                     displayed_price_cents: 100, displayed_price_currency_type: "usd", rate_converted_to_usd: "1", created_at: FIXED_NOW, updated_at: FIXED_NOW, **attrs })
end

def insert_url_redirect(id:, purchase_id:, link_id:, **attrs)
  UrlRedirect.insert!({ id:, purchase_id:, link_id:, token: "tok#{id}abcdef", created_at: FIXED_NOW, updated_at: FIXED_NOW, **attrs })
end

def seed_mailer_level(user_id, via, level)
  key = "creator_mailer_level_#{user_id}"
  Rails.cache.delete(key)
  case via
  when :cache then Rails.cache.write(key, level, expires_in: 2.days)
  when :redis then Redis::Namespace.new(:user_mailer_redis_namespace, redis: $redis).set(key, level.to_s)
  end
  { "mailer_level" => { "via" => via.to_s, "level" => level.to_s } }
end

[User, Link, Purchase, Subscription, UrlRedirect, PurchasePresentment, Price].each { _1.columns; _1.first }
SidekiqExecutor.perform { User.first; User.transaction { User.first } }

messages = []
errors = []
refused = []

# The scratch Elasticsearch has no products mapping. Receipts of sellers that recommend products are refused
# by the port, so what the search returns only has to let Rails finish rendering them.
RecommendedProducts::CheckoutService.prepend(Module.new { def search_products(*) = { products: Link.none } })

def insert_variant(id:, link_id:, name:)
  Variant.insert!({ id:, name:, link_id:, variant_category_id: nil, type: "Variant", created_at: FIXED_NOW, updated_at: FIXED_NOW })
end

def attach_variant(purchase_id, variant_id)
  ActiveRecord::Base.connection.execute("INSERT INTO base_variants_purchases (purchase_id, base_variant_id) VALUES (#{purchase_id.to_i}, #{variant_id.to_i})")
end

# Every case is one seller, one product, one purchase unless it adds to them.
def setup(seller: {}, link: {}, purchase: {}, redirect: true)
  reset!
  insert_user(id: 201, email: "seller@example.com", username: "seller", name: "Seller Name", **seller)
  insert_link(id: 301, user_id: 201, **link)
  insert_purchase(id: 401, link_id: 301, seller_id: 201, **purchase)
  insert_url_redirect(id: 601, purchase_id: 401, link_id: 301) if redirect
  seed_mailer_level(201, :cache, :level_1)
end

PHYSICAL = { flags: 128 }.freeze # Link flag 8, is_physical
RESEND = { "resend" => true, "force_resend" => true }.freeze

CASES = [
  ["digital_basic", {}, {}, { price_cents: 500, total_transaction_cents: 500, displayed_price_cents: 500 }],
  ["digital_cents", {}, {}, { price_cents: 1234, total_transaction_cents: 1234, displayed_price_cents: 1234 }],
  ["digital_ninety_nine_cents", {}, {}, { price_cents: 99, total_transaction_cents: 99, displayed_price_cents: 99 }],
  ["digital_thousands", {}, {}, { price_cents: 123_456_789, total_transaction_cents: 123_456_789, displayed_price_cents: 123_456_789 }],
  ["digital_free", {}, {}, { price_cents: 0, total_transaction_cents: 0, displayed_price_cents: 0 }],
  ["digital_html_names", {}, { name: "Tom & Jerry's <Guide>" }, { price_cents: 500, total_transaction_cents: 500, displayed_price_cents: 500 }],
  ["digital_quantity", {}, {}, { price_cents: 1000, total_transaction_cents: 1000, displayed_price_cents: 1000, quantity: 2 }],
  ["digital_link_support_email", {}, { support_email: "link-support@example.com" }, {}],
  ["digital_user_support_email", { support_email: "user-support@example.com" }, {}, {}],
  ["digital_no_seller_name", { name: nil }, {}, {}],
  ["digital_custom_receipt_text", {}, { json_data: { "custom_receipt_text" => "Thanks for buying!\n\nSee you next time." } }, {}],
  ["digital_view_content_text", {}, { json_data: { "custom_view_content_button_text" => "Get it" } }, {}],
  ["digital_no_url_redirect", {}, {}, {}, { redirect: false }],
  ["digital_resend", {}, {}, {}, { features: RESEND }],
  ["digital_united_internet", {}, {}, { email: "buyer@web.de" }, { features: RESEND }],
  ["digital_old_purchase", {}, {}, { created_at: Time.utc(2025, 3, 5, 9, 30), updated_at: Time.utc(2025, 3, 5, 9, 30) }],
].freeze

CASES.each do |name, seller, link, purchase, extra = {}|
  meta = setup(seller:, link:, purchase:, redirect: extra.fetch(:redirect, true))
  messages << record_message("receipt_#{name}", CustomerMailer, :receipt, [401], features: extra.fetch(:features, {}), meta:)
end

# Rows that hang off the purchase.
setup(purchase: { price_cents: 500, total_transaction_cents: 500, displayed_price_cents: 500 })
insert_variant(id: 701, link_id: 301, name: "Premium")
attach_variant(401, 701)
messages << record_message("receipt_variant", CustomerMailer, :receipt, [401], meta: seed_mailer_level(201, :cache, :level_1))

setup(purchase: { price_cents: 500, total_transaction_cents: 500, displayed_price_cents: 500 })
insert_variant(id: 701, link_id: 301, name: "Untitled")
attach_variant(401, 701)
messages << record_message("receipt_untitled_variant", CustomerMailer, :receipt, [401], meta: seed_mailer_level(201, :cache, :level_1))

setup(purchase: { price_cents: 700, total_transaction_cents: 700, displayed_price_cents: 700 })
Tip.insert!({ purchase_id: 401, value_cents: 200, value_usd_cents: 200, created_at: FIXED_NOW, updated_at: FIXED_NOW })
messages << record_message("receipt_tip", CustomerMailer, :receipt, [401], meta: seed_mailer_level(201, :cache, :level_1))

setup(purchase: { price_cents: 700, total_transaction_cents: 700, displayed_price_cents: 700 })
PurchaseCustomField.insert_all!([
  { purchase_id: 401, field_type: "text", name: "Your name", value: "Ada Lovelace", created_at: FIXED_NOW, updated_at: FIXED_NOW },
  { purchase_id: 401, field_type: "checkbox", name: "Subscribe to the newsletter", value: "1", created_at: FIXED_NOW, updated_at: FIXED_NOW },
  { purchase_id: 401, field_type: "checkbox", name: "Accept the rules", value: "0", created_at: FIXED_NOW, updated_at: FIXED_NOW },
  { purchase_id: 401, field_type: "text", name: "Notes", value: "", created_at: FIXED_NOW, updated_at: FIXED_NOW },
  { purchase_id: 401, field_type: "text", name: "Tom & Jerry's <note>", value: "Rock & roll, \"quoted\" (it's 5 + 3?)", created_at: FIXED_NOW, updated_at: FIXED_NOW },
])
messages << record_message("receipt_custom_fields", CustomerMailer, :receipt, [401], meta: seed_mailer_level(201, :cache, :level_1))

setup(purchase: { price_cents: 700, total_transaction_cents: 700, displayed_price_cents: 700 })
PurchaseRefundPolicy.insert!({ purchase_id: 401, title: "30-day money back guarantee", fine_print: "Ask nicely & we refund.", created_at: FIXED_NOW, updated_at: FIXED_NOW })
messages << record_message("receipt_refund_policy", CustomerMailer, :receipt, [401], meta: seed_mailer_level(201, :cache, :level_1))

# A physical product: the shipping address and the shipping line of the payment.
SHIPPING = { full_name: "Ada Lovelace", street_address: "1 Analytical Way", city: "London", state: "LDN", zip_code: "N1 9GU", country: "United Kingdom" }.freeze
setup(link: PHYSICAL.merge(require_shipping: true), purchase: { price_cents: 1500, total_transaction_cents: 1500, displayed_price_cents: 1500, shipping_cents: 500, **SHIPPING }, redirect: false)
messages << record_message("receipt_physical_shipping", CustomerMailer, :receipt, [401], meta: seed_mailer_level(201, :cache, :level_1))
setup(link: PHYSICAL.merge(require_shipping: true), purchase: { price_cents: 1500, total_transaction_cents: 1500, displayed_price_cents: 1500, shipping_cents: 0, **SHIPPING }, redirect: false)
messages << record_message("receipt_physical_free_shipping", CustomerMailer, :receipt, [401], meta: seed_mailer_level(201, :cache, :level_1))

# The sender's mailer level: a seller on level 2 sends through the second customers key.
setup
seed_mailer_level(201, :redis, :level_2)
messages << record_message("receipt_level_two", CustomerMailer, :receipt, [401], meta: seed_mailer_level(201, :redis, :level_2))

# Cases Rails sends and the port hands back (the Node test only expects a refusal).
def refuse(refused, name, **setup_args)
  meta = setup(**setup_args)
  refused << record_message("receipt_#{name}", CustomerMailer, :receipt, [401], meta:)
end

PRICE = { price_cents: 500, total_transaction_cents: 500, displayed_price_cents: 500 }.freeze
refuse(refused, "recommending_seller", seller: { recommendation_type: "own_products" }, purchase: PRICE)
refuse(refused, "rental", purchase: PRICE.merge(flags: 16384))
refuse(refused, "bundle", purchase: PRICE.merge(flags: 33_554_432), link: { flags: 33_554_432 })
refuse(refused, "licensed", link: { flags: 64 }, purchase: PRICE)
refuse(refused, "membership", link: { flags: 2, native_type: "membership" }, purchase: PRICE)
refuse(refused, "taxed", purchase: PRICE.merge(tax_cents: 50, flags: 4096))
refuse(refused, "euro_product", link: { price_currency_type: "eur" }, purchase: PRICE.merge(displayed_price_currency_type: "eur", rate_converted_to_usd: "1.2"))
refuse(refused, "call", link: { native_type: "call" }, purchase: PRICE)
refuse(refused, "signed_in_buyer", purchase: PRICE.merge(purchaser_id: 201))
setup(purchase: PRICE)
PurchasePresentment.insert!({ purchase_id: 401, presentment_currency: "eur", presentment_gumroad_amount_cents: 50, presentment_price_cents: 450, presentment_total_cents: 500, processor: "stripe", created_at: FIXED_NOW, updated_at: FIXED_NOW })
refused << record_message("receipt_buyer_currency", CustomerMailer, :receipt, [401], meta: seed_mailer_level(201, :cache, :level_1))
setup(purchase: PRICE)
ActiveRecord::Base.connection.execute("INSERT INTO thumbnails (product_id, created_at, updated_at) VALUES (301, NOW(), NOW())")
refused << record_message("receipt_product_with_thumbnail", CustomerMailer, :receipt, [401], meta: seed_mailer_level(201, :cache, :level_1))
setup(purchase: PRICE, seller: { name: "Tom & <Jerry>" })
refused << record_message("receipt_html_seller_name", CustomerMailer, :receipt, [401], meta: seed_mailer_level(201, :cache, :level_1))
setup(purchase: PRICE)
PurchaseCustomField.insert!({ purchase_id: 401, field_type: "text", name: "Site", value: "see https://example.com", created_at: FIXED_NOW, updated_at: FIXED_NOW })
refused << record_message("receipt_auto_linked_field", CustomerMailer, :receipt, [401], meta: seed_mailer_level(201, :cache, :level_1))

# Errors.
reset!
errors << record_error("receipt_missing_purchase", CustomerMailer, :receipt, [404])

# --- SendPurchaseReceiptJob: the job as Sidekiq runs it, the mail inline ------------------------------------------
def record_job(name, args, features: {}, meta: {})
  $delivered.clear
  $iv_seq = 0
  $ivs_used.clear
  $rands_used.clear
  features.each_key { Feature.activate(_1) }
  error = nil
  statements = nil
  SidekiqExecutor.perform do
    statements = capture_sql do
      SendPurchaseReceiptJob.new.perform(*args)
    rescue => e
      error = { "class" => e.class.name, "message" => e.message }
    end
  end
  {
    **meta,
    "name" => name,
    "args" => args,
    "statements" => statements,
    "error" => error,
    "features" => features.keys,
    "rands_used" => $rands_used.dup,
    "ivs" => $ivs_used.dup,
    "delivered" => $delivered.dup,
    "stamp_jobs" => Sidekiq.redis { |c| c.lrange("queue:long", 0, -1) },
    "email_infos" => EmailInfo.order(:id).map { |info| info.attributes.slice("purchase_id", "type", "email_name", "state").merge("sent_at" => info.sent_at&.iso8601) },
  }
end

jobs = []
def job_setup(**args)
  Sidekiq.redis { |c| c.del("queue:long") }
  setup(**args)
end
job_setup(purchase: PRICE)
jobs << record_job("job_basic", [401], meta: seed_mailer_level(201, :cache, :level_1))
job_setup(purchase: PRICE)
jobs << record_job("job_resend_provider", [401], features: RESEND, meta: seed_mailer_level(201, :cache, :level_1))
job_setup(purchase: PRICE)
CustomerEmailInfo.insert!({ purchase_id: 401, type: "CustomerEmailInfo", email_name: "receipt", state: "delivered", sent_at: FIXED_NOW - 1.hour })
jobs << record_job("job_already_sent", [401], meta: seed_mailer_level(201, :cache, :level_1))
job_setup(purchase: PRICE)
CustomerEmailInfo.insert!({ purchase_id: 401, type: "CustomerEmailInfo", email_name: "receipt", state: "delivered", sent_at: FIXED_NOW - 1.hour })
jobs << record_job("job_resend_requested", [401, true], meta: seed_mailer_level(201, :cache, :level_1))
job_setup(purchase: PRICE.merge(flags: 67_108_864))
jobs << record_job("job_bundle_product_purchase", [401], meta: seed_mailer_level(201, :cache, :level_1))
job_setup(purchase: PRICE, redirect: false)
jobs << record_job("job_without_url_redirect", [401], meta: seed_mailer_level(201, :cache, :level_1))
job_setup(purchase: PRICE)
jobs << record_job("job_missing_purchase", [404])
job_setup(purchase: PRICE, seller: { recommendation_type: "own_products" })
jobs << record_job("job_recommending_seller", [401], meta: seed_mailer_level(201, :cache, :level_1))
job_setup(purchase: PRICE)
ProductFile.insert!({ link_id: 301, url: "https://example.com/a.pdf", filetype: "pdf", flags: 16, created_at: FIXED_NOW, updated_at: FIXED_NOW })
jobs << record_job("job_stampable_pdf", [401], meta: seed_mailer_level(201, :cache, :level_1))

cases = { "messages" => messages, "errors" => errors, "refused" => refused, "jobs" => jobs }
File.write(File.join(FIXTURES, "receipt-mailer.golden.json"), JSON.pretty_generate({ "now" => FIXED_NOW.iso8601, "secrets" => SMTP_SECRETS, "cases" => cases }) + "\n")
puts "wrote #{messages.size} messages, #{errors.size} errors, #{refused.size} refused"
