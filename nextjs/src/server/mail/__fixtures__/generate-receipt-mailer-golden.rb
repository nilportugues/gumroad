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

# Recommended products search Elasticsearch: a proxy keeps the exact requests and answers, against a scratch index.
require File.join(ROOT, "nextjs/src/server/search/__fixtures__/es_recording_proxy")
connect_recording_client!
Link.index_name("ws85-link")

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


# The Elasticsearch requests of the case, as the client put them on the wire, with the answers (minus the timing).
def es_exchanges = EsProxy.log.map { _1.except("response").merge("response" => JSON.parse(_1["response"]).except("took")) }

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
  EsProxy.log.clear
  EsProxy.on = true
  SidekiqExecutor.perform do
    statements = capture_sql do
      delivery = mailer.public_send(method, *args)
      rendered = delivery.message.is_a?(ActionMailer::Base::NullMail) ? nil : delivery.message.body.raw_source.dup
    end
    # EmailDeliveryObserver's CustomerEmailInfo write happens after the SMTP hand-off.
    delivery_statements = capture_sql { result = delivery.deliver_now }
  end
  EsProxy.on = false
  {
    **meta,
    "name" => name,
    "mailer" => mailer.name,
    "method" => method.to_s,
    "job_args" => ActiveJob::Arguments.serialize(args),
    "statements" => statements,
    "delivery_statements" => delivery_statements,
    "es" => es_exchanges,
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
            customer_email_infos email_infos product_files thumbnails gifts preorders base_variants base_variants_purchases purchase_custom_fields purchase_refund_policies tips cached_sales_related_products_infos bundle_products product_review_stats active_storage_attachments active_storage_blobs asset_previews custom_domains offer_codes variant_categories affiliates zip_tax_rates purchase_taxjar_infos licenses].freeze
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

messages = $messages = []
errors = []
refused = []


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
  # Priced in another currency: the line is converted back to dollars at the purchase's rate, the product price stays in the product's.
  ["eur_product", {}, { price_currency_type: "eur" }, { price_cents: 500, total_transaction_cents: 500, displayed_price_cents: 450, displayed_price_currency_type: "eur", rate_converted_to_usd: "0.9" }],
  ["eur_rate_digits", {}, { price_currency_type: "eur" }, { price_cents: 1234, total_transaction_cents: 1234, displayed_price_cents: 1017, displayed_price_currency_type: "eur", rate_converted_to_usd: "0.8237451" }],
  ["eur_half_cent", {}, { price_currency_type: "eur" }, { price_cents: 1, total_transaction_cents: 1, displayed_price_cents: 1, displayed_price_currency_type: "eur", rate_converted_to_usd: "2.0" }],
  ["jpy_product", {}, { price_currency_type: "jpy" }, { price_cents: 5000, total_transaction_cents: 5000, displayed_price_cents: 7500, displayed_price_currency_type: "jpy", rate_converted_to_usd: "150.0" }],
  ["gbp_quantity", {}, { price_currency_type: "gbp" }, { price_cents: 2000, total_transaction_cents: 2000, displayed_price_cents: 1600, quantity: 2, displayed_price_currency_type: "gbp", rate_converted_to_usd: "0.8" }],
  ["eur_free", {}, { price_currency_type: "eur" }, { price_cents: 0, total_transaction_cents: 0, displayed_price_cents: 0, displayed_price_currency_type: "eur", rate_converted_to_usd: "0.9" }],
  ["usd_purchase_of_eur_product", {}, { price_currency_type: "eur" }, { price_cents: 500, total_transaction_cents: 500, displayed_price_cents: 500 }],
].freeze

CASES.each do |name, seller, link, purchase, extra = {}|
  meta = setup(seller:, link:, purchase:, redirect: extra.fetch(:redirect, true))
  messages << record_message("receipt_#{name}", CustomerMailer, :receipt, [401], features: extra.fetch(:features, {}), meta:)
end

# Rows that hang off the purchase.
setup(link: { price_currency_type: "eur" }, purchase: { price_cents: 700, total_transaction_cents: 700, displayed_price_cents: 630, displayed_price_currency_type: "eur", rate_converted_to_usd: "0.9" })
Tip.insert!({ purchase_id: 401, value_cents: 90, value_usd_cents: 100, created_at: FIXED_NOW, updated_at: FIXED_NOW })
messages << record_message("receipt_eur_tip", CustomerMailer, :receipt, [401], meta: seed_mailer_level(201, :cache, :level_1))
setup(link: PHYSICAL.merge(require_shipping: true, price_currency_type: "eur"), purchase: { price_cents: 1500, total_transaction_cents: 1500, displayed_price_cents: 1000, shipping_cents: 500, displayed_price_currency_type: "eur", rate_converted_to_usd: "0.8", **{ full_name: "Ada Lovelace", street_address: "1 Analytical Way", city: "London", state: "LDN", zip_code: "N1 9GU", country: "United Kingdom" } }, redirect: false)
messages << record_message("receipt_eur_physical_shipping", CustomerMailer, :receipt, [401], meta: seed_mailer_level(201, :cache, :level_1))

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

# A signed-in buyer: the footer's test-purchase check and the recommendations read the buyer's account.
setup(purchase: { price_cents: 500, total_transaction_cents: 500, displayed_price_cents: 500, purchaser_id: 202 })
insert_user(id: 202, email: "buyer@example.com", username: "buyer")
messages << record_message("receipt_signed_in_buyer", CustomerMailer, :receipt, [401], meta: seed_mailer_level(201, :cache, :level_1))

# A buyer with other purchases: the products Rails excludes from recommendations include theirs, newest first.
setup(purchase: { price_cents: 500, total_transaction_cents: 500, displayed_price_cents: 500, purchaser_id: 202, succeeded_at: FIXED_NOW })
insert_user(id: 202, email: "buyer@example.com", username: "buyer")
insert_link(id: 302, user_id: 201)
insert_link(id: 303, user_id: 201)
insert_purchase(id: 402, link_id: 302, seller_id: 201, purchaser_id: 202, succeeded_at: FIXED_NOW - 2.days)
insert_purchase(id: 403, link_id: 303, seller_id: 201, purchaser_id: 202, succeeded_at: FIXED_NOW - 1.day)
insert_purchase(id: 404, link_id: 302, seller_id: 201, purchaser_id: 202, succeeded_at: FIXED_NOW - 3.days)
messages << record_message("receipt_signed_in_buyer_with_history", CustomerMailer, :receipt, [401], meta: seed_mailer_level(201, :cache, :level_1))

# Cases Rails sends and the port hands back (the Node test only expects a refusal).
def refuse(refused, name, **setup_args)
  meta = setup(**setup_args)
  refused << record_message("receipt_#{name}", CustomerMailer, :receipt, [401], meta:)
end

PRICE = { price_cents: 500, total_transaction_cents: 500, displayed_price_cents: 500 }.freeze
# A rental purchase (Purchase flag 15) whose redirect is not a rental: the plain "View content" button.
setup(purchase: PRICE.merge(flags: 16384))
messages << record_message("receipt_rental", CustomerMailer, :receipt, [401], meta: seed_mailer_level(201, :cache, :level_1))
# A rental redirect (UrlRedirect flag 3) is what checkout creates. "Watch" only when the product has a video file; with
# none, the download button partial renders nothing. Not yet recorded from Ruby: the Node port of these two is unproven
# until this script is run against the real application and the golden regenerated.
RENTAL = PRICE.merge(flags: 16384)
setup(purchase: RENTAL, redirect: false)
insert_url_redirect(id: 601, purchase_id: 401, link_id: 301, flags: 4)
messages << record_message("receipt_rental_no_video", CustomerMailer, :receipt, [401], meta: seed_mailer_level(201, :cache, :level_1))
setup(purchase: RENTAL, redirect: false)
insert_url_redirect(id: 601, purchase_id: 401, link_id: 301, flags: 4)
ProductFile.insert!({ link_id: 301, url: "https://example.com/a.mp4", filetype: "mp4", filegroup: "video", created_at: FIXED_NOW, updated_at: FIXED_NOW })
messages << record_message("receipt_rental_watch", CustomerMailer, :receipt, [401], meta: seed_mailer_level(201, :cache, :level_1))
# A gift the buyer sent (Purchase flag 7, is_gift_sender_purchase). Not yet recorded from Ruby: the Node port is
# unproven (`unproven.giftSender` in receipt-presenter.ts) until this script is run and the golden regenerated.
setup(purchase: PRICE.merge(flags: 64, quantity: 2), redirect: false)
Gift.insert!({ gifter_purchase_id: 401, link_id: 301, state: "successful", giftee_email: "friend@example.com", gifter_email: "buyer@example.com", gift_note: "  Enjoy!\n", created_at: FIXED_NOW, updated_at: FIXED_NOW })
messages << record_message("receipt_gift_sender", CustomerMailer, :receipt, [401], meta: seed_mailer_level(201, :cache, :level_1))
refuse(refused, "bundle",purchase: PRICE.merge(flags: 33_554_432), link: { flags: 33_554_432 })
refuse(refused, "membership", link: { flags: 2, native_type: "membership" }, purchase: PRICE)
refuse(refused, "unknown_currency", purchase: PRICE.merge(displayed_price_currency_type: "xxx", rate_converted_to_usd: "1.0"))
refuse(refused, "call", link: { native_type: "call" }, purchase: PRICE)
setup(purchase: PRICE.merge(purchaser_id: 201))
refused << record_message("receipt_test_purchase", CustomerMailer, :receipt, [401], meta: seed_mailer_level(201, :cache, :level_1))
setup(purchase: PRICE)
ActiveRecord::Base.connection.execute("INSERT INTO thumbnails (product_id, created_at, updated_at) VALUES (301, NOW(), NOW())")
refused << record_message("receipt_product_with_thumbnail", CustomerMailer, :receipt, [401], meta: seed_mailer_level(201, :cache, :level_1))
setup(purchase: PRICE, seller: { name: "Tom & <Jerry>" })
refused << record_message("receipt_html_seller_name", CustomerMailer, :receipt, [401], meta: seed_mailer_level(201, :cache, :level_1))
setup(purchase: PRICE)
PurchaseCustomField.insert!({ purchase_id: 401, field_type: "text", name: "Site", value: "see https://example.com", created_at: FIXED_NOW, updated_at: FIXED_NOW })
refused << record_message("receipt_auto_linked_field", CustomerMailer, :receipt, [401], meta: seed_mailer_level(201, :cache, :level_1))


# --- Recommended products (WS-85) ---------------------------------------------------------------------------------
# A seller who recommends their own products: the receipt runs RecommendedProducts::CheckoutService, the related-sales
# cache and an Elasticsearch search. The index is rebuilt from the rows, so seed everything, then `recommend!`.
def recommend!
  Link.__elasticsearch__.create_index!(force: true)
  Link.find_each { _1.__elasticsearch__.index_document }
  EsClient.indices.refresh(index: Link.index_name)
end

def insert_price(link_id:, price_cents:, currency: "usd", recurrence: nil, **attrs)
  Price.insert!({ link_id:, price_cents:, currency:, recurrence:, created_at: FIXED_NOW, updated_at: FIXED_NOW, **attrs })
end

def cache_related(product_id, counts)
  CachedSalesRelatedProductsInfo.insert!({ product_id:, counts: counts.transform_keys(&:to_s), created_at: FIXED_NOW, updated_at: FIXED_NOW })
end

# Link flag 17, display_product_reviews
REVIEWS = { flags: 65_536 }.freeze
OWN = { recommendation_type: "own_products" }.freeze

def recommending(name, purchase: PRICE, seller: {}, link: {}, buyer: false, features: {}, into: nil)
  setup(seller: OWN.merge(seller), link:, purchase: purchase.merge(buyer ? { purchaser_id: 202 } : {}))
  insert_user(id: 202, email: "buyer@example.com", username: "buyer") if buyer
  yield
  recommend!
  record_message("receipt_#{name}", CustomerMailer, :receipt, [401], features:, meta: seed_mailer_level(201, :cache, :level_1))
end

def other_products(*ids, **attrs)
  ids.each do |id|
    insert_link(id:, user_id: 201, name: "Other #{id}", **attrs)
    insert_price(link_id: id, price_cents: 100 * (id - 300))
  end
end

# Nothing else to recommend: the search comes back empty and the section is absent.
messages << recommending("rec_no_other_products") {}
# The creator's other products, in the search's order.
messages << recommending("rec_creator_featured") { other_products(302, 303) }
messages << recommending("rec_creator_featured_cap", buyer: false) { other_products(302, 303, 304, 305, 306, 307) }
messages << recommending("rec_signed_in_buyer", buyer: true) { other_products(302, 303) }
# Sold alongside this product: the cache's counts, highest first (ties by product id, descending).
messages << recommending("rec_co_purchase") do
  other_products(302, 303)
  cache_related(301, { 302 => 5, 303 => 2 })
end
messages << recommending("rec_co_purchase_full") do
  other_products(302, 303, 304, 305, 306)
  cache_related(301, { 302 => 5, 303 => 5, 304 => 5, 305 => 1, 306 => 9 })
end
messages << recommending("rec_co_purchase_mixed") do
  other_products(302, 303, 304)
  cache_related(301, { 303 => 4 })
end
# Cached ids that are another seller's, deleted, archived or the purchased product itself drop out.
messages << recommending("rec_co_purchase_filtered") do
  other_products(302, 303)
  insert_user(id: 203, email: "other@example.com", username: "other")
  insert_link(id: 304, user_id: 203, name: "Not theirs")
  insert_link(id: 305, user_id: 201, name: "Deleted", deleted_at: FIXED_NOW)
  insert_link(id: 306, user_id: 201, name: "Archived", flags: 16)
  cache_related(301, { 302 => 3, 304 => 8, 305 => 7, 306 => 6, 301 => 9, 303 => 1 })
end
messages << recommending("rec_signed_in_buyer_history", buyer: true) do
  other_products(302, 303, 304)
  insert_purchase(id: 402, link_id: 302, seller_id: 201, purchaser_id: 202, succeeded_at: FIXED_NOW - 2.days)
  cache_related(301, { 302 => 3, 303 => 2, 304 => 1 })
end
# Card details: ratings, pay-what-you-want, another currency, a missing price row, a one-time price row.
messages << recommending("rec_card_details") do
  other_products(302, 303, 304, 305)
  Link.where(id: 302).update_all(flags: 65_536)
  ProductReviewStat.insert!({ link_id: 302, reviews_count: 1234, average_rating: 4.5, created_at: FIXED_NOW, updated_at: FIXED_NOW })
  Link.where(id: 303).update_all(customizable_price: true)
  Link.where(id: 304).update_all(price_currency_type: "eur")
  Price.where(link_id: 304).update_all(currency: "eur")
  Price.where(link_id: 305).delete_all
end
messages << recommending("rec_ratings_rounding") do
  other_products(302, 303, 304)
  Link.where(id: [302, 303, 304]).update_all(flags: 65_536)
  ProductReviewStat.insert_all!([
    { link_id: 302, reviews_count: 999, average_rating: 3.0, created_at: FIXED_NOW, updated_at: FIXED_NOW },
    { link_id: 303, reviews_count: 15_300, average_rating: 4.75, created_at: FIXED_NOW, updated_at: FIXED_NOW },
    { link_id: 304, reviews_count: 0, average_rating: 0.0, created_at: FIXED_NOW, updated_at: FIXED_NOW },
  ])
end
messages << recommending("rec_html_names") do
  insert_link(id: 302, user_id: 201, name: "Tom & Jerry's <Guide>", custom_permalink: "tom-jerry")
  insert_price(link_id: 302, price_cents: 250)
end
messages << recommending("rec_physical_and_free_purchase", purchase: PRICE.merge(price_cents: 0, total_transaction_cents: 0, displayed_price_cents: 0)) { other_products(302) }

# Shapes the port hands back: the preloads or the card they need are not ported.
def refuse_recommending(refused, name, buyer: false, seller: {}, link: {}, &seed)
  refused << recommending(name, buyer:, seller:, link:, &seed)
end
refuse_recommending(refused, "rec_affiliates_seller", seller: { recommendation_type: "gumroad_affiliates_products" }) { other_products(302) }
refuse_recommending(refused, "rec_directly_affiliated_seller", seller: { recommendation_type: "directly_affiliated_products" }) { other_products(302) }
refuse_recommending(refused, "rec_thumbnail") do
  other_products(302)
  ActiveRecord::Base.connection.execute("INSERT INTO thumbnails (product_id, created_at, updated_at) VALUES (302, NOW(), NOW())")
end
refuse_recommending(refused, "rec_variant_category") do
  other_products(302)
  VariantCategory.insert!({ link_id: 302, title: "Version" })
end
refuse_recommending(refused, "rec_auto_apply_sale") do
  other_products(302)
  OfferCode.insert!({ user_id: 201, name: "Sale", code: "sale", amount_percentage: 10, universal: true, auto_apply: true, created_at: FIXED_NOW, updated_at: FIXED_NOW })
end
refuse_recommending(refused, "rec_membership") do
  other_products(302)
  Link.where(id: 302).update_all(flags: 2 | 262_144, native_type: "membership")
end
refuse_recommending(refused, "rec_sold_out_limit") do
  other_products(302)
  Link.where(id: 302).update_all(max_purchase_count: 5)
end
refuse_recommending(refused, "rec_bundle") do
  other_products(302)
  Link.where(id: 302).update_all(flags: 33_554_432)
end
# Four ids to associate (this product and three bought): Rails samples half of them at random.
refuse_recommending(refused, "rec_sampled_associations", buyer: true) do
  other_products(302, 303, 304, 305)
  [302, 303, 304].each_with_index { |link_id, i| insert_purchase(id: 410 + i, link_id:, seller_id: 201, purchaser_id: 202, succeeded_at: FIXED_NOW - (i + 1).days) }
end


# --- Taxed purchases (WS-85) --------------------------------------------------------------------------------------
TAXABLE = 4096 # was_purchase_taxable
TAX_EXCLUDED = 8192 # was_tax_excluded_from_price

def insert_zip_tax_rate(id:, country:, combined_rate:, **attrs)
  ZipTaxRate.insert!({ id:, country:, combined_rate:, created_at: FIXED_NOW, updated_at: FIXED_NOW, **attrs })
end

def taxed(name, country: nil, rate: nil, purchase: {}, link: {}, zip: {}, extra: nil, into: nil)
  setup(link:, purchase: { price_cents: 500, total_transaction_cents: 550, displayed_price_cents: 500, flags: TAXABLE | TAX_EXCLUDED, tax_cents: 50, **purchase })
  if country
    insert_zip_tax_rate(id: 901, country:, combined_rate: rate, **zip)
    Purchase.where(id: 401).update_all(zip_tax_rate_id: 901)
  end
  extra&.call
  (into || $messages) << record_message("receipt_#{name}", CustomerMailer, :receipt, [401], meta: seed_mailer_level(201, :cache, :level_1))
end

taxed("tax_us_excluded", country: "US", rate: 0.0825)
taxed("tax_us_included", country: "US", rate: 0.0825, purchase: { flags: TAXABLE, total_transaction_cents: 500, tax_cents: 38 })
taxed("tax_without_zip_rate")
taxed("tax_without_zip_rate_included", purchase: { flags: TAXABLE, total_transaction_cents: 500 })
taxed("tax_eu_vat", country: "DE", rate: 0.19, purchase: { tax_cents: 0, gumroad_tax_cents: 95, total_transaction_cents: 595 })
taxed("tax_eu_vat_uk", country: "GB", rate: 0.2, purchase: { tax_cents: 0, gumroad_tax_cents: 100, total_transaction_cents: 600 })
taxed("tax_eu_vat_refunded", country: "FR", rate: 0.2, purchase: { tax_cents: 0, gumroad_tax_cents: 100, total_transaction_cents: 600 }, extra: -> {
  Refund.insert_all!([
    { purchase_id: 401, amount_cents: 100, gumroad_tax_cents: 20, status: "succeeded", json_data: nil, created_at: FIXED_NOW, updated_at: FIXED_NOW },
    { purchase_id: 401, amount_cents: 50, gumroad_tax_cents: 15, status: nil, json_data: nil, created_at: FIXED_NOW, updated_at: FIXED_NOW },
    { purchase_id: 401, amount_cents: 50, gumroad_tax_cents: 40, status: "failed", json_data: nil, created_at: FIXED_NOW, updated_at: FIXED_NOW },
    { purchase_id: 401, amount_cents: 50, gumroad_tax_cents: 10, status: "canceled", json_data: nil, created_at: FIXED_NOW, updated_at: FIXED_NOW },
    { purchase_id: 401, amount_cents: 50, gumroad_tax_cents: 7, status: "failed", json_data: { balance_reversed_on_failure: "true" }.to_json, created_at: FIXED_NOW, updated_at: FIXED_NOW },
    { purchase_id: 401, amount_cents: 50, gumroad_tax_cents: 5, status: "failed", json_data: { balance_reversed_on_failure: "false" }.to_json, created_at: FIXED_NOW, updated_at: FIXED_NOW },
  ])
})
taxed("tax_gst_india", country: "IN", rate: 0.18, purchase: { tax_cents: 0, gumroad_tax_cents: 90, total_transaction_cents: 590 })
taxed("tax_gst_new_zealand", country: "NZ", rate: 0.15, purchase: { tax_cents: 0, gumroad_tax_cents: 75, total_transaction_cents: 575 })
taxed("tax_gst_australia", country: "AU", rate: 0.1, purchase: { tax_cents: 0, gumroad_tax_cents: 50 })
taxed("tax_gst_singapore", country: "SG", rate: 0.09, purchase: { tax_cents: 0, gumroad_tax_cents: 45, total_transaction_cents: 545 })
taxed("tax_consumption_tax_japan", country: "JP", rate: 0.1, purchase: { tax_cents: 0, gumroad_tax_cents: 50 })
taxed("tax_service_tax_malaysia", country: "MY", rate: 0.06, purchase: { tax_cents: 0, gumroad_tax_cents: 30, total_transaction_cents: 530 })
taxed("tax_vat_norway", country: "NO", rate: 0.25, purchase: { tax_cents: 0, gumroad_tax_cents: 125, total_transaction_cents: 625 })
taxed("tax_vat_turkey", country: "TR", rate: 0.2, purchase: { tax_cents: 0, gumroad_tax_cents: 100, total_transaction_cents: 600 })
taxed("tax_canada_zip_rate", country: "CA", rate: 0.05)
taxed("tax_rate_truncated", country: "ES", rate: 0.0799999, purchase: { tax_cents: 0, gumroad_tax_cents: 40, total_transaction_cents: 540 })
taxed("tax_rate_fraction", country: "ES", rate: 0.2175, purchase: { tax_cents: 0, gumroad_tax_cents: 109, total_transaction_cents: 609 })
taxed("tax_flag_without_amount", country: "DE", rate: 0.19, purchase: { tax_cents: 0, gumroad_tax_cents: 0, total_transaction_cents: 500 })
taxed("tax_total_transaction_zero", country: "DE", rate: 0.19, purchase: { price_cents: 0, displayed_price_cents: 0, tax_cents: 0, gumroad_tax_cents: 0, total_transaction_cents: 0 })
taxed("tax_amount_without_flag", country: "US", rate: 0.0825, purchase: { flags: 0 })
taxed("tax_with_shipping", country: "DE", rate: 0.19, link: PHYSICAL.merge(require_shipping: true), purchase: { tax_cents: 0, gumroad_tax_cents: 100, shipping_cents: 500, total_transaction_cents: 1100, price_cents: 500, **SHIPPING })
taxed("tax_eur_product", country: "DE", rate: 0.19, link: { price_currency_type: "eur" }, purchase: { tax_cents: 0, gumroad_tax_cents: 95, total_transaction_cents: 595, displayed_price_cents: 450, displayed_price_currency_type: "eur", rate_converted_to_usd: "0.9" })
taxed("tax_quantity", country: "DE", rate: 0.19, purchase: { quantity: 2, price_cents: 1000, displayed_price_cents: 1000, tax_cents: 0, gumroad_tax_cents: 190, total_transaction_cents: 1190 })
taxed("tax_taxjar_zero_rates", country: "US", rate: 0.07, extra: -> {
  PurchaseTaxjarInfo.insert!({ purchase_id: 401, combined_tax_rate: 0.07, gst_tax_rate: 0, pst_tax_rate: 0, qst_tax_rate: 0, created_at: FIXED_NOW, updated_at: FIXED_NOW })
})
taxed("tax_taxjar_without_canadian_rates", country: "US", rate: 0.07, extra: -> {
  PurchaseTaxjarInfo.insert!({ purchase_id: 401, combined_tax_rate: 0.07, state_tax_rate: 0.07, created_at: FIXED_NOW, updated_at: FIXED_NOW })
})
taxed("tax_signed_in_buyer", country: "DE", rate: 0.19, purchase: { purchaser_id: 202, tax_cents: 0, gumroad_tax_cents: 95, total_transaction_cents: 595 }, extra: -> { insert_user(id: 202, email: "buyer@example.com", username: "buyer") })

# Shapes the port hands back: Canadian splits, a creator's own tax ID.
taxed("tax_canada_split", country: "US", rate: 0.13, into: refused, extra: -> {
  PurchaseTaxjarInfo.insert!({ purchase_id: 401, combined_tax_rate: 0.13, gst_tax_rate: 0.05, pst_tax_rate: 0.08, created_at: FIXED_NOW, updated_at: FIXED_NOW })
})
taxed("tax_creator_tax_rate", country: "DE", rate: 0.19, into: refused, zip: { user_id: 201, json_data: { "invoice_sales_tax_id" => "DE123" } })


# --- Licence keys and the other plain native types (WS-85) --------------------------------------------------------
LICENSED = 64 # Link flag 7, is_licensed

def insert_license(purchase_id:, link_id:, serial:)
  License.insert!({ purchase_id:, link_id:, serial:, created_at: FIXED_NOW, updated_at: FIXED_NOW })
end

def licensed(name, link: {}, purchase: {}, serial: "A1B2C3D4-E5F6A7B8-C9D0E1F2-A3B4C5D6", into: nil, redirect: true)
  setup(link: { flags: LICENSED }.merge(link), purchase: PRICE.merge(purchase), redirect:)
  insert_license(purchase_id: 401, link_id: 301, serial:) if serial
  yield if block_given?
  (into || $messages) << record_message("receipt_#{name}", CustomerMailer, :receipt, [401], meta: seed_mailer_level(201, :cache, :level_1))
end

licensed("licensed_basic")
licensed("licensed_without_license_row", serial: nil)
licensed("licensed_physical", link: { flags: LICENSED | 128, require_shipping: true }, purchase: SHIPPING.merge(shipping_cents: 0), redirect: false)
licensed("licensed_free", purchase: { price_cents: 0, total_transaction_cents: 0, displayed_price_cents: 0 })
licensed("licensed_quantity", purchase: { quantity: 2, price_cents: 1000, total_transaction_cents: 1000, displayed_price_cents: 1000 })
# A licensed product with versions reads the versions' content, which the port does not.
licensed("licensed_with_versions", into: refused) do
  insert_variant(id: 701, link_id: 301, name: "Premium")
  attach_variant(401, 701)
  ActiveRecord::Base.connection.execute("INSERT INTO variant_categories (id, link_id, title) VALUES (801, 301, 'Version')")
  ActiveRecord::Base.connection.execute("UPDATE base_variants SET variant_category_id = 801 WHERE id = 701")
end

# Native types whose receipt is the plain product one.
%w[newsletter podcast audiobook physical].each do |native_type|
  setup(link: { native_type: }, purchase: PRICE)
  messages << record_message("receipt_native_type_#{native_type}", CustomerMailer, :receipt, [401], meta: seed_mailer_level(201, :cache, :level_1))
end

# Coffee: a donation, no download button, no variant or quantity lines.
setup(link: { native_type: "coffee" }, purchase: PRICE, redirect: false)
messages << record_message("receipt_coffee", CustomerMailer, :receipt, [401], meta: seed_mailer_level(201, :cache, :level_1))
setup(link: { native_type: "coffee" }, purchase: PRICE.merge(quantity: 2, price_cents: 1000, total_transaction_cents: 1000, displayed_price_cents: 1000))
insert_variant(id: 701, link_id: 301, name: "Large")
attach_variant(401, 701)
messages << record_message("receipt_coffee_with_redirect_variant_and_quantity", CustomerMailer, :receipt, [401], meta: seed_mailer_level(201, :cache, :level_1))
setup(link: { native_type: "coffee" }, purchase: PRICE.merge(price_cents: 700, total_transaction_cents: 700, displayed_price_cents: 700), redirect: false)
Tip.insert!({ purchase_id: 401, value_cents: 200, value_usd_cents: 200, created_at: FIXED_NOW, updated_at: FIXED_NOW })
messages << record_message("receipt_coffee_tip", CustomerMailer, :receipt, [401], meta: seed_mailer_level(201, :cache, :level_1))
setup(link: { native_type: "coffee", price_currency_type: "eur" }, purchase: PRICE.merge(displayed_price_cents: 450, displayed_price_currency_type: "eur", rate_converted_to_usd: "0.9"), redirect: false)
messages << record_message("receipt_coffee_eur", CustomerMailer, :receipt, [401], meta: seed_mailer_level(201, :cache, :level_1))


# --- Buyer-currency purchases (WS-85) -----------------------------------------------------------------------------
def presented(name, currency: "eur", link: {}, purchase: {}, presentment: {}, redirect: true, into: nil, extra: nil)
  setup(link:, purchase: PRICE.merge(purchase), redirect:)
  PurchasePresentment.insert!({ purchase_id: 401, presentment_currency: currency, presentment_gumroad_amount_cents: 50, presentment_price_cents: 450, presentment_total_cents: 450, processor: "stripe",
                                created_at: FIXED_NOW, updated_at: FIXED_NOW, **presentment })
  extra&.call
  (into || $messages) << record_message("receipt_#{name}", CustomerMailer, :receipt, [401], meta: seed_mailer_level(201, :cache, :level_1))
end

presented("presented_eur")
presented("presented_gbp_cents", currency: "gbp", presentment: { presentment_price_cents: 1234, presentment_total_cents: 1234 }, purchase: { price_cents: 1500, total_transaction_cents: 1500, displayed_price_cents: 1500 })
presented("presented_jpy", currency: "jpy", presentment: { presentment_price_cents: 750, presentment_total_cents: 750 })
presented("presented_krw", currency: "krw", presentment: { presentment_price_cents: 6500, presentment_total_cents: 6500 })
presented("presented_quantity", purchase: { quantity: 2, price_cents: 1000, total_transaction_cents: 1000, displayed_price_cents: 1000 }, presentment: { presentment_price_cents: 900, presentment_total_cents: 900 })
presented("presented_quantity_remainder", purchase: { quantity: 3, price_cents: 1500, total_transaction_cents: 1500, displayed_price_cents: 1500 }, presentment: { presentment_price_cents: 1001, presentment_total_cents: 1001 })
presented("presented_tip", purchase: { price_cents: 700, total_transaction_cents: 700, displayed_price_cents: 700 }, presentment: { presentment_price_cents: 450, presentment_tip_cents: 180, presentment_total_cents: 630 },
          extra: -> { Tip.insert!({ purchase_id: 401, value_cents: 200, value_usd_cents: 200, created_at: FIXED_NOW, updated_at: FIXED_NOW }) })
presented("presented_shipping", link: PHYSICAL.merge(require_shipping: true), redirect: false,
          purchase: { price_cents: 1500, total_transaction_cents: 1500, displayed_price_cents: 1000, shipping_cents: 500, **SHIPPING },
          presentment: { presentment_price_cents: 900, presentment_shipping_cents: 450, presentment_total_cents: 1350 })
presented("presented_shipping_but_zero_total", link: PHYSICAL.merge(require_shipping: true), redirect: false,
          purchase: { price_cents: 0, total_transaction_cents: 0, displayed_price_cents: 0, shipping_cents: 500, **SHIPPING },
          presentment: { presentment_price_cents: 0, presentment_shipping_cents: 450, presentment_total_cents: 450 })
presented("presented_tax_excluded", purchase: { flags: TAXABLE | TAX_EXCLUDED, tax_cents: 50, total_transaction_cents: 550 },
          presentment: { presentment_price_cents: 450, presentment_seller_tax_cents: 45, presentment_total_cents: 495 },
          extra: -> { insert_zip_tax_rate(id: 901, country: "US", combined_rate: 0.1); Purchase.where(id: 401).update_all(zip_tax_rate_id: 901) })
presented("presented_tax_included", purchase: { flags: TAXABLE, tax_cents: 38, total_transaction_cents: 500 },
          presentment: { presentment_price_cents: 450, presentment_seller_tax_cents: 34, presentment_total_cents: 450 },
          extra: -> { insert_zip_tax_rate(id: 901, country: "US", combined_rate: 0.1); Purchase.where(id: 401).update_all(zip_tax_rate_id: 901) })
presented("presented_vat", purchase: { flags: TAXABLE | TAX_EXCLUDED, tax_cents: 0, gumroad_tax_cents: 95, total_transaction_cents: 595 },
          presentment: { presentment_price_cents: 450, presentment_gumroad_tax_cents: 85, presentment_total_cents: 535 },
          extra: -> { insert_zip_tax_rate(id: 901, country: "DE", combined_rate: 0.19); Purchase.where(id: 401).update_all(zip_tax_rate_id: 901) })
presented("presented_product_in_euros", link: { price_currency_type: "eur" }, purchase: { displayed_price_cents: 450, displayed_price_currency_type: "eur", rate_converted_to_usd: "0.9" })
presented("presented_coffee", link: { native_type: "coffee" }, redirect: false)
presented("presented_licensed", link: { flags: LICENSED }, extra: -> { insert_license(purchase_id: 401, link_id: 301, serial: "AAAA-BBBB") })
presented("presented_after_failed_refund", into: refused, extra: -> {
  Refund.insert!({ purchase_id: 401, amount_cents: 100, gumroad_tax_cents: 0, status: "failed", json_data: nil, created_at: FIXED_NOW, updated_at: FIXED_NOW })
})
presented("presented_signed_in_buyer", purchase: { purchaser_id: 202 }, extra: -> { insert_user(id: 202, email: "buyer@example.com", username: "buyer") })
# A zero-dollar purchase never gets a presentment row.
setup(purchase: PRICE.merge(price_cents: 0, total_transaction_cents: 0, displayed_price_cents: 0))
$messages << record_message("receipt_presented_free", CustomerMailer, :receipt, [401], meta: seed_mailer_level(201, :cache, :level_1))

# Shapes the port hands back: a refund changes which currency the document uses.
presented("presented_effective_refund", into: refused, extra: -> {
  Refund.insert!({ purchase_id: 401, amount_cents: 100, gumroad_tax_cents: 0, status: "succeeded", json_data: nil, created_at: FIXED_NOW, updated_at: FIXED_NOW })
})

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
  EsProxy.log.clear
  EsProxy.on = true
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
    "es" => (EsProxy.on = false; es_exchanges),
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
other_products(302, 303)
recommend!
jobs << record_job("job_recommending_seller", [401], meta: seed_mailer_level(201, :cache, :level_1))
job_setup(purchase: PRICE)
ProductFile.insert!({ link_id: 301, url: "https://example.com/a.pdf", filetype: "pdf", flags: 16, created_at: FIXED_NOW, updated_at: FIXED_NOW })
jobs << record_job("job_stampable_pdf", [401], meta: seed_mailer_level(201, :cache, :level_1))

cases = { "messages" => messages, "errors" => errors, "refused" => refused, "jobs" => jobs }
File.write(File.join(FIXTURES, "receipt-mailer.golden.json"), JSON.generate({ "now" => FIXED_NOW.iso8601, "secrets" => SMTP_SECRETS, "cases" => cases }) + "\n")
puts "wrote #{messages.size} messages, #{errors.size} errors, #{refused.size} refused"
