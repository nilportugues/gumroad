# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/post-email-sends.golden.json: SendWorkflowInstallmentWorker
# (and the Installment#send_installment_from_workflow_for_* it calls, PostEmailApi, PostResendApi and
# PostSendgridApi) run by the real application in production mode against a scratch database, each case as
# a Sidekiq job (support/sidekiq_executor.rb). The provider clients are replaced by recorders, so each case
# holds the request bodies Ruby would have sent. Run it like the application mailer generator:
#
#   mysql -uroot -ppassword -e 'CREATE DATABASE gumroad_ws59'   # then load the schema into it
#   USE_DB_WORKER_REPLICAS=true bundle exec ruby nextjs/scripts/golden/post-email-sends.rb
#
# Purchases are plain INSERTs (the purchase factory charges Stripe). Elasticsearch is captured, never reached.
# The AES IVs of the unsubscribe tokens come from a fixed sequence, recorded per case.
require "fileutils"
require "json"

ROOT = File.expand_path("../../..", __dir__)
Dir.chdir(ROOT)

REDIS_DB = ENV.fetch("REDIS_DB", "7")
abort "Refusing to flush Redis db 0" if REDIS_DB == "0"

ENV["RAILS_ENV"] = "production"
ENV["TZ"] = "UTC"
{
  "DATABASE_HOST" => "127.0.0.1", "DATABASE_PORT" => "3306", "DATABASE_NAME" => "gumroad_ws59",
  "DATABASE_USERNAME" => "root", "DATABASE_PASSWORD" => "password",
  "SECRET_KEY_BASE" => "x" * 64, "DEVISE_SECRET_KEY" => "d" * 64, "REVISION" => "ws59golden",
  "MEMCACHE_SERVERS" => "localhost:11211", "ELASTICSEARCH_HOST" => "http://localhost:9200",
  "SENDGRID_GR_CREATORS_API_KEY" => "sg-creators-key", "RESEND_CREATORS_API_KEY" => "re-creators-key",
  "MAILER_HEADERS_ENCRYPTION_KEY_V1" => "ws59-golden-header-key",
  "OBFUSCATE_IDS_CIPHER_KEY" => "ws59-golden-obfuscate-key", "OBFUSCATE_IDS_NUMERIC_CIPHER_KEY" => "123456789",
  "SECURE_EXTERNAL_ID__PRIMARY_KEY_VERSION" => "1", "SECURE_EXTERNAL_ID__KEYS__1" => "ws59-secure-external-id-key-0001",
  "USE_DB_WORKER_REPLICAS" => "true",
}.each { |k, v| ENV[k] = v }
%w[REDIS_HOST SIDEKIQ_REDIS_HOST RPUSH_REDIS_HOST RACK_ATTACK_REDIS_HOST].each { |k| ENV[k] = "localhost:6379/#{REDIS_DB}" }
abort "Use a scratch database" unless ENV["DATABASE_NAME"].match?(/_ws\d+\z/)

require "dotenv"
Dotenv.parse(File.join(ROOT, ".env.test")).each { |k, v| ENV[k] ||= v }

# A production build's stylesheet: the manifest entry the layout links and the CSS premailer reads.
VITE_DIR = File.join(ROOT, "public/vite")
abort "public/vite exists; move it aside first" if File.exist?(VITE_DIR)
FileUtils.mkdir_p(File.join(VITE_DIR, ".vite"))
FileUtils.mkdir_p(File.join(VITE_DIR, "assets"))
File.write(File.join(VITE_DIR, ".vite/manifest.json"), JSON.generate({ "entrypoints/email.ts" => { "file" => "assets/email.js", "css" => ["assets/email-golden.css"] } }))
FileUtils.cp(File.join(ROOT, "nextjs/src/server/mail/__fixtures__/email.css"), File.join(VITE_DIR, "assets/email-golden.css"))
at_exit { FileUtils.rm_rf(VITE_DIR) }

require File.join(ROOT, "config/environment")
Rails.logger = ActiveSupport::Logger.new(nil)
ActiveRecord::Base.logger = nil
ActiveJob::Base.logger = Logger.new(nil)
ActiveJob::Base.queue_adapter = :sidekiq
require "active_support/testing/time_helpers"
require File.join(ROOT, "nextjs/scripts/golden/support/rails_cases")
include RailsCases
capture_elasticsearch!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/post-email-sends.golden.json")
NOW = Time.utc(2025, 11, 1, 12, 30, 45)
SEEDED_AT = "2025-01-01 00:00:00"
TABLES = %w[users links purchases subscriptions workflows installments installment_rules sent_post_emails email_infos url_redirects
            seller_profiles followers product_files affiliates affiliates_links feature_announcement_newsletter_cutovers
            audience_members versions subscription_events].freeze

# The unsubscribe tokens are AES-GCM with a random IV: pin it.
$iv_seq = 0
$ivs_used = []
OpenSSL::Cipher.prepend(Module.new do
  def random_iv
    $iv_seq += 1
    iv = format("ws59-iv-%07d-----", $iv_seq)[0, iv_len]
    $ivs_used << Base64.strict_encode64(iv)
    self.iv = iv
  end
end)
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
$uuid_seq = 0
SecureRandom.singleton_class.prepend(Module.new do
  def uuid
    $uuid_seq += 1
    format("00000000-0000-4000-8000-%012d", $uuid_seq)
  end
end)

# --- provider recorders -----------------------------------------------------------------------------
$provider_calls = []
$provider_failures = []
FakeResponse = Struct.new(:status_code, :body) do
  def success? = (200..299).cover?(status_code)
end
class FakeSendgrid
  def client = self
  def mail = self
  def _(_name) = self

  def post(request_body:)
    $provider_calls << { "provider" => "sendgrid", "api_key" => "sg-creators-key", "request" => JSON.parse(request_body.to_json) }
    failure = $provider_failures.shift
    failure ? FakeResponse.new(failure, "rejected") : FakeResponse.new(202, "")
  end
end
SendGrid::API.singleton_class.prepend(Module.new { def new(*) = FakeSendgrid.new })
module FakeResend
  def self.record(kind, payload)
    $provider_calls << { "provider" => "resend", "kind" => kind, "api_key" => Resend.api_key, "request" => JSON.parse(payload.to_json) }
    failure = $provider_failures.shift
    FakeResponse.new(failure || 200, failure ? "rejected" : "{}")
  end
end
Resend::Emails.singleton_class.prepend(Module.new { def send(params = {}) = FakeResend.record("email", params) })
Resend::Batch.singleton_class.prepend(Module.new { def send(params = []) = FakeResend.record("batch", params) })
Rails.application.config.action_mailer.perform_deliveries = true

def at(time) = time.utc.strftime("%Y-%m-%d %H:%M:%S.%6N")

def user_row(id, **overrides)
  { id:, email: "user#{id}@example.com", username: "user#{id}", name: "User #{id}", external_id: (8_000_000_000_000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, json_data: nil, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def link_row(id = 1, **overrides)
  { id:, name: "Product #{id}", user_id: 1, unique_permalink: "p#{id}", price_currency_type: "usd", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def purchase_row(id = 1, **overrides)
  { id:, link_id: 1, seller_id: 1, email: "buyer@example.com", full_name: "Ada Lovelace", purchase_state: "successful", price_cents: 500, displayed_price_cents: 500,
    quantity: 1, flags: 0, can_contact: true, country: "United States", ip_country: "United States", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def workflow_row(id = 1, **overrides)
  { id:, seller_id: 1, link_id: 1, workflow_type: "product", published_at: SEEDED_AT, json_data: nil, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

INSTALLMENT_FLAGS = { is_for_new_customers_of_workflow: 6, shown_on_profile: 8, send_emails: 9, allow_comments: 11, single_recipient_email: 12 }.freeze
def installment_flags(*names) = names.sum { 1 << (INSTALLMENT_FLAGS.fetch(_1) - 1) }

def installment_row(id = 10, workflow_id: 1, flags: installment_flags(:send_emails), **overrides)
  { id:, link_id: 1, seller_id: 1, workflow_id:, installment_type: "product", name: "Welcome", message: "<p>Hello and thanks for your purchase.</p>", slug: "welcome-#{id}",
    published_at: SEEDED_AT, flags:, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def rule_row(id = 10, installment_id: id, **overrides)
  { id:, installment_id:, delayed_delivery_time: 3600, version: 3, time_period: "hour", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def follower_row(id = 1, **overrides)
  { id:, followed_id: 1, email: "follower@example.com", confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def merge_seeds(*seeds)
  seeds.each_with_object({}) { |seed, all| seed.each { |table, rows| (all[table] ||= []).concat(rows) } }
end

def base_seed(**extra)
  { users: [user_row(1), user_row(2)], links: [link_row], workflows: [workflow_row], installments: [installment_row], installment_rules: [rule_row],
    purchases: [purchase_row] }.merge(extra)
end

SW = "SendWorkflowInstallmentWorker"
# args: installment, version, purchase, follower, affiliate user, subscription
def run(name, args, seed: {}, now: NOW, features: %i[], cached_version: 3, setup: nil, failures: [], rands: [])
  $uuid_seq = 0
  $iv_seq = 0
  $ivs_used.clear
  $provider_calls.clear
  $provider_failures.replace(failures)
  $rands.replace(rands)
  $rands_used.clear
  result = capture(name, now:, tables: TABLES, seed: base_seed(**seed), setup: lambda {
    features.each { |feature| Feature.activate(feature) }
    redis.set("workflow_installment_rule:10:version", cached_version) if cached_version
    setup&.call
  }, sidekiq: true, job: SW, args:, case_now: now.to_f) { SW.constantize.new.perform(*args) }
  result.delete("rows")
  result.delete("seed")
  result.merge("providers" => $provider_calls.dup, "ivs" => $ivs_used.dup, "rands_used" => $rands_used.dup)
end

cases = []
resend = %i[use_resend_for_post_emails force_resend_for_post_emails]
resend_split = %i[use_resend_for_post_emails resend]
acme = { purchases: [purchase_row(email: "buyer@acme.dev")] }
HOUR = 3600
DAY = 86_400
ORIGINAL_SUBSCRIPTION_PURCHASE = 1 << 2
SUSPENDED = { user_risk_state: "suspended_for_fraud" }.freeze
router_counters = ->(probability) { -> { redis.set("mail_router:probability:creators:#{NOW.to_date}", probability); redis.set("mail_router:max_count:creators:#{NOW.to_date}", "10") } }
settings_row = ->(**overrides) { { id: 1, seller_id: 1, highlight_color: "#ff90e8", background_color: "#ffffff", font: "ABC Favorit", border_radius: "small", button_hover: "lift", json_data: nil, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides) }
email_info = { id: 1, purchase_id: 1, installment_id: 10, type: "CreatorContactingCustomersEmailInfo", email_name: "purchase_installment", state: "sent", sent_at: SEEDED_AT }
claim = ->(email) { { id: 1, post_id: 10, email:, created_at: SEEDED_AT, updated_at: SEEDED_AT } }
profile_flags = installment_flags(:send_emails, :shown_on_profile, :allow_comments)
token_message = "<p>Hi {{first_name}}, and {{ first_name | friend }}.</p>"

# --- worker guards ---------------------------------------------------------------------------------
cases << run("guard: no recipient", [10, 3, nil, nil])
cases << run("guard: two recipients", [10, 3, 1, 1])
cases << run("guard: no cached version", [10, 3, 1, nil], cached_version: nil)
cases << run("guard: installment does not exist", [999, 3, 1, nil], cached_version: nil)
cases << run("guard: cached version differs from the job's", [10, 2, 1, nil])
cases << run("guard: rule version newer than the cached one", [10, 3, 1, nil], cached_version: 2)
cases << run("guard: rule version older than the cached one", [10, 3, 1, nil], cached_version: 4)
cases << run("guard: pending version", [10, 3, 1, nil], setup: -> { redis.set("workflow_installment_rule:10:pending_token", "tok") })
cases << run("guard: installment without a rule", [10, 3, 1, nil], seed: { installment_rules: [] })
cases << run("guard: suspended seller", [10, 3, 1, nil], seed: { users: [user_row(1, **SUSPENDED), user_row(2)] })
cases << run("guard: deleted workflow", [10, 3, 1, nil], seed: { workflows: [workflow_row(deleted_at: SEEDED_AT)] })
cases << run("guard: installment without a workflow", [10, 3, 1, nil], seed: { installments: [installment_row(workflow_id: nil)] })
cases << run("guard: deleted installment", [10, 3, 1, nil], seed: { installments: [installment_row(deleted_at: SEEDED_AT)] })
cases << run("guard: unpublished installment", [10, 3, 1, nil], seed: { installments: [installment_row(published_at: nil)] })
cases << run("guard: reschedule reference time without a recipient", [10, 3, nil, nil, nil, nil, "2025-10-31T12:30:45Z"])
cases << run("guard: reschedule reference time", [10, 3, 1, nil, nil, nil, "2025-10-31T12:30:45Z"])

# --- purchases ---------------------------------------------------------------------------------------
cases << run("purchase: sendgrid", [10, 3, 1, nil])
cases << run("purchase: resend forced", [10, 3, 1, nil], features: resend)
cases << run("purchase: resend split picks resend", [10, 3, 1, nil], seed: acme, features: resend_split, setup: router_counters.call("1"), rands: [0.5])
cases << run("purchase: resend split picks sendgrid", [10, 3, 1, nil], seed: acme, features: resend_split, setup: router_counters.call("0.5"), rands: [0.75])
cases << run("purchase: resend split without counters", [10, 3, 1, nil], seed: acme, features: resend_split)
cases << run("purchase: resend split, counter at its maximum", [10, 3, 1, nil], seed: acme, features: resend_split, setup: -> { router_counters.call("1").call; redis.set("mail_router:counter:creators:#{NOW.to_date}", "10") })
cases << run("purchase: resend flag on, recipient at a United Internet domain", [10, 3, 1, nil], features: resend, seed: { purchases: [purchase_row(email: "buyer@web.de")] })
cases << run("purchase: resend split, recipient at a United Internet domain", [10, 3, 1, nil], features: resend_split, seed: { purchases: [purchase_row(email: "buyer@gmx.net")] })
cases << run("purchase: resend split, recipient address Resend cannot take", [10, 3, 1, nil], features: resend_split, seed: { purchases: [purchase_row(email: "bu!yer@acme.dev")] })
cases << run("purchase: sendgrid rejects", [10, 3, 1, nil], failures: [500])
cases << run("purchase: resend rejects", [10, 3, 1, nil], features: resend, failures: [422])
cases << run("purchase: buyer is a user", [10, 3, 1, nil], seed: { users: [user_row(1), user_row(2, email: "buyer@example.com")] })
cases << run("purchase: buyer is a user, resend", [10, 3, 1, nil], features: resend, seed: { users: [user_row(1), user_row(2, email: "buyer@example.com")] })
cases << run("purchase: free purchase", [10, 3, 1, nil], seed: { purchases: [purchase_row(price_cents: 0, displayed_price_cents: 0)] })
cases << run("purchase: free purchase, resend", [10, 3, 1, nil], features: resend, seed: { purchases: [purchase_row(price_cents: 0, displayed_price_cents: 0)] })
cases << run("purchase: no full name", [10, 3, 1, nil], seed: { installments: [installment_row(message: token_message)], purchases: [purchase_row(full_name: nil)] })
cases << run("purchase: first name token", [10, 3, 1, nil], seed: { installments: [installment_row(message: token_message)] })
cases << run("purchase: first name token, resend", [10, 3, 1, nil], features: resend, seed: { installments: [installment_row(message: token_message)] })
cases << run("purchase: shown on profile with comments", [10, 3, 1, nil], seed: { installments: [installment_row(flags: profile_flags)] })
cases << run("purchase: shown on profile with comments, resend", [10, 3, 1, nil], features: resend, seed: { installments: [installment_row(flags: profile_flags)] })
cases << run("purchase: shown on profile without a slug", [10, 3, 1, nil], seed: { installments: [installment_row(flags: installment_flags(:send_emails, :shown_on_profile), slug: nil)] })
cases << run("purchase: call to action", [10, 3, 1, nil], seed: { installments: [installment_row(call_to_action_url: "https://example.com/offer?a=1&b=2", call_to_action_text: "Get <it>")] })
cases << run("purchase: seller post", [10, 3, 1, nil], seed: { workflows: [workflow_row(workflow_type: "seller", link_id: nil)], installments: [installment_row(installment_type: "seller", link_id: nil)] })
cases << run("purchase: seller post, seller without a name", [10, 3, 1, nil], seed: { users: [user_row(1, name: nil), user_row(2)], workflows: [workflow_row(workflow_type: "seller", link_id: nil)], installments: [installment_row(installment_type: "seller", link_id: nil)] })
cases << run("purchase: seller post, free", [10, 3, 1, nil], seed: { workflows: [workflow_row(workflow_type: "seller", link_id: nil)], installments: [installment_row(installment_type: "seller", link_id: nil)], purchases: [purchase_row(price_cents: 0)] })
cases << run("purchase: audience post", [10, 3, 1, nil], seed: { workflows: [workflow_row(workflow_type: "audience", link_id: nil)], installments: [installment_row(installment_type: "audience", link_id: nil)] })
cases << run("purchase: product without a name", [10, 3, 1, nil], seed: { installments: [installment_row(name: nil)] })
cases << run("purchase: product name with markup", [10, 3, 1, nil], seed: { links: [link_row(name: "<b>Bold</b> & co")] })
cases << run("purchase: membership product", [10, 3, 1, nil], seed: { links: [link_row(flags: 1 << 9)] })
cases << run("purchase: long message", [10, 3, 1, nil], seed: { installments: [installment_row(message: "<p>#{"Lorem ipsum dolor sit amet. " * 30}</p><h2>Heading</h2><ul><li>One</li><li>Two &amp; three</li></ul><p><strong>Bold</strong> and <em>italic</em><br>line</p>")] })
cases << run("purchase: message with links", [10, 3, 1, nil], seed: { installments: [installment_row(message: "<p>See https://example.com/a?b=1&amp;c=2 or write to me@example.com or www.example.org.</p><p><a href=\"https://example.net\">link</a></p>")] })
cases << run("purchase: message without markup", [10, 3, 1, nil], seed: { installments: [installment_row(message: "just text <3 & more")] })
cases << run("purchase: message in a right-to-left script", [10, 3, 1, nil], seed: { installments: [installment_row(message: "<p>Hello</p><p>שלום</p><div dir=\"ltr\">x</div><blockquote>q</blockquote>")] })
cases << run("purchase: message with a code block", [10, 3, 1, nil], seed: { installments: [installment_row(message: "<pre><code class=\"language-ruby\">puts 1</code></pre>")] })
cases << run("purchase: message with an upsell", [10, 3, 1, nil], seed: { installments: [installment_row(message: "<upsell-card id=\"abc\"></upsell-card>")] })
cases << run("purchase: message with an embedded link", [10, 3, 1, nil], seed: { installments: [installment_row(message: "<div class=\"tiptap__raw\" data-url=\"https://example.com\" data-title=\"T\"></div>")] })
cases << run("purchase: message with a button", [10, 3, 1, nil], seed: { installments: [installment_row(message: "<p><a class=\"tiptap__button\" href=\"https://example.com\">Go</a></p>")] })
cases << run("purchase: empty message", [10, 3, 1, nil], seed: { installments: [installment_row(message: "")] })
cases << run("purchase: custom seller profile", [10, 3, 1, nil], seed: { seller_profiles: [settings_row.call(highlight_color: "#112233", background_color: "#000000", font: "Inter")] })
cases << run("purchase: default seller profile row", [10, 3, 1, nil], seed: { seller_profiles: [settings_row.call] })
cases << run("purchase: post with files", [10, 3, 1, nil], seed: { product_files: [{ id: 1, link_id: nil, installment_id: 10, url: "https://example.com/f.pdf", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }] })

# --- purchase guards -----------------------------------------------------------------------------------
recurring_charge = { subscriptions: [{ id: 1, link_id: 1, user_id: 2, seller_id: 1, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }], purchases: [purchase_row(1, subscription_id: 1, flags: ORIGINAL_SUBSCRIPTION_PURCHASE), purchase_row(2, subscription_id: 1, flags: 0)] }
cases << run("purchase guard: purchase does not exist", [10, 3, 999, nil])
cases << run("purchase guard: recurring charge", [10, 3, 2, nil], seed: recurring_charge)
cases << run("purchase guard: member cancellation post", [10, 3, 1, nil], seed: { workflows: [workflow_row(json_data: { workflow_trigger: "member_cancellation" }.to_json)] })
cases << run("purchase guard: cannot contact", [10, 3, 1, nil], seed: { purchases: [purchase_row(can_contact: false)] })
cases << run("purchase guard: charged back", [10, 3, 1, nil], seed: { purchases: [purchase_row(chargeback_date: SEEDED_AT)] })
cases << run("purchase guard: charged back and reversed", [10, 3, 1, nil], seed: { purchases: [purchase_row(chargeback_date: SEEDED_AT, flags: 1 << 9)] })
cases << run("purchase guard: refunded", [10, 3, 1, nil], seed: { purchases: [purchase_row(stripe_refunded: true)] })
cases << run("purchase guard: already emailed", [10, 3, 1, nil], seed: { email_infos: [email_info] })
cases << run("purchase guard: already claimed", [10, 3, 1, nil], seed: { sent_post_emails: [claim.call("buyer@example.com")] })
cases << run("purchase guard: workflow of another product", [10, 3, 1, nil], seed: { links: [link_row, link_row(2, unique_permalink: "p2")], workflows: [workflow_row(link_id: 2)] })
cases << run("purchase guard: workflow filter not met", [10, 3, 1, nil], seed: { workflows: [workflow_row(json_data: { paid_more_than_cents: 600 }.to_json)] })

# --- subscriptions -------------------------------------------------------------------------------------
membership = lambda do |subscription: {}, flags: ORIGINAL_SUBSCRIPTION_PURCHASE, **purchase|
  {
    links: [link_row(flags: 1 << 9)],
    subscriptions: [{ id: 1, link_id: 1, user_id: 2, seller_id: 1, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(subscription)],
    purchases: [purchase_row(1, subscription_id: 1, flags:, **purchase)],
  }
end
cases << run("subscription: live membership", [10, 3, 1, nil], seed: membership.call)
cases << run("subscription: cancelled membership", [10, 3, 1, nil], seed: membership.call(subscription: { cancelled_at: at(NOW - DAY), deactivated_at: at(NOW - DAY) }))
cases << run("subscription: membership ending in the future", [10, 3, 1, nil], seed: membership.call(subscription: { cancelled_at: at(NOW + DAY) }))
cases << run("subscription: failed membership", [10, 3, 1, nil], seed: membership.call(subscription: { failed_at: at(NOW - DAY), deactivated_at: at(NOW - DAY) }))

# --- followers -------------------------------------------------------------------------------------------
follower_post = { workflows: [workflow_row(workflow_type: "follower", link_id: nil)], installments: [installment_row(installment_type: "follower", link_id: nil)] }
cases << run("follower: sendgrid", [10, 3, nil, 1], seed: merge_seeds(follower_post, { followers: [follower_row] }))
cases << run("follower: resend forced", [10, 3, nil, 1], features: resend, seed: merge_seeds(follower_post, { followers: [follower_row] }))
cases << run("follower: follower does not exist", [10, 3, nil, 999], seed: follower_post)
cases << run("follower: unconfirmed", [10, 3, nil, 1], seed: merge_seeds(follower_post, { followers: [follower_row(confirmed_at: nil)] }))
cases << run("follower: deleted", [10, 3, nil, 1], seed: merge_seeds(follower_post, { followers: [follower_row(deleted_at: SEEDED_AT)] }))
cases << run("follower: already claimed", [10, 3, nil, 1], seed: merge_seeds(follower_post, { followers: [follower_row], sent_post_emails: [claim.call("follower@example.com")] }))
cases << run("follower: follower of another seller", [10, 3, nil, 1], seed: merge_seeds(follower_post, { followers: [follower_row(followed_id: 2)] }))
cases << run("follower: shown on profile", [10, 3, nil, 1], seed: merge_seeds({ workflows: [workflow_row(workflow_type: "follower", link_id: nil)], installments: [installment_row(installment_type: "follower", link_id: nil, flags: profile_flags)] }, { followers: [follower_row] }))
cases << run("follower: audience post", [10, 3, nil, 1], seed: merge_seeds({ workflows: [workflow_row(workflow_type: "audience", link_id: nil)], installments: [installment_row(installment_type: "audience", link_id: nil)] }, { followers: [follower_row] }))
retired = { feature_announcement_newsletter_cutovers: [{ id: 1, seller_id: 1, state: "retired", cutoff_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }] }
migrating = { feature_announcement_newsletter_cutovers: [{ id: 1, seller_id: 1, state: "migrating", cutoff_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }] }
cases << run("follower: retired newsletter", [10, 3, nil, 1], seed: merge_seeds(follower_post, { followers: [follower_row] }, retired))
cases << run("follower: newsletter cutover in progress", [10, 3, nil, 1], seed: merge_seeds(follower_post, { followers: [follower_row] }, migrating))
cases << run("follower: retired newsletter on a product post", [10, 3, 1, nil], seed: retired)

# --- affiliates --------------------------------------------------------------------------------------------
affiliate_post = { workflows: [workflow_row(workflow_type: "affiliate", link_id: nil)], installments: [installment_row(installment_type: "affiliate", link_id: nil)] }
cases << run("affiliate: sendgrid", [10, 3, nil, nil, 2], seed: affiliate_post)
cases << run("affiliate: resend forced", [10, 3, nil, nil, 2], features: resend, seed: affiliate_post)
cases << run("affiliate: user does not exist", [10, 3, nil, nil, 999], seed: affiliate_post)
cases << run("affiliate: already claimed", [10, 3, nil, nil, 2], seed: merge_seeds(affiliate_post, { sent_post_emails: [claim.call("user2@example.com")] }))

# --- member cancellation -----------------------------------------------------------------------------------
cancel_post = { workflows: [workflow_row(json_data: { workflow_trigger: "member_cancellation" }.to_json)] }
cancelled = membership.call(subscription: { cancelled_at: at(NOW - DAY), deactivated_at: at(NOW - DAY) })
cases << run("cancellation: sendgrid", [10, 3, nil, nil, nil, 1], seed: merge_seeds(cancel_post, cancelled))
cases << run("cancellation: resend forced", [10, 3, nil, nil, nil, 1], features: resend, seed: merge_seeds(cancel_post, cancelled))
cases << run("cancellation: subscription does not exist", [10, 3, nil, nil, nil, 999], seed: cancel_post)
cases << run("cancellation: not a cancellation post", [10, 3, nil, nil, nil, 1], seed: cancelled)
cases << run("cancellation: subscription still alive", [10, 3, nil, nil, nil, 1], seed: merge_seeds(cancel_post, membership.call))
cases << run("cancellation: no original purchase", [10, 3, nil, nil, nil, 1], seed: merge_seeds(cancel_post, cancelled).merge(purchases: []))
cases << run("cancellation: cannot contact", [10, 3, nil, nil, nil, 1], seed: merge_seeds(cancel_post, membership.call(subscription: { cancelled_at: at(NOW - DAY), deactivated_at: at(NOW - DAY) }, can_contact: false)))
cases << run("cancellation: already emailed", [10, 3, nil, nil, nil, 1], seed: merge_seeds(cancel_post, cancelled, { email_infos: [email_info] }))

# --- delivery time ------------------------------------------------------------------------------------------
event = ->(id, type, occurred_at) { { id:, subscription_id: 1, event_type: type, occurred_at: at(occurred_at), created_at: SEEDED_AT, updated_at: SEEDED_AT } }
cases << run("delivery: too soon after the purchase", [10, 3, 1, nil], seed: { purchases: [purchase_row(created_at: at(NOW - 60))] })
cases << run("delivery: resubscribed membership, due", [10, 3, 1, nil], seed: merge_seeds(membership.call(created_at: at(NOW - 90 * DAY)), { subscription_events: [event.call(1, 0, NOW - 40 * DAY), event.call(2, 1, NOW - 39 * DAY)] }))
cases << run("delivery: resubscribed membership, not due yet", [10, 3, 1, nil], seed: merge_seeds(membership.call(created_at: at(NOW - DAY)), { subscription_events: [event.call(1, 0, NOW - 20 * DAY), event.call(2, 1, NOW - 10 * DAY)] }))
cases << run("delivery: restarted but never deactivated", [10, 3, 1, nil], seed: merge_seeds(membership.call, { subscription_events: [event.call(2, 1, NOW - 39 * DAY)] }))

# What a seller with the default profile gets: the compiled stylesheet and the button style are constants of the
# profile, which Node cannot compile (SassC), so it takes them from here and hands back any other profile.
defaults = SellerProfile.new(seller: User.new(id: 1))
File.write(Rails.root.join("nextjs/src/server/mail/post-email-defaults.generated.json"), JSON.pretty_generate(
  "profile" => defaults.attributes.slice("font", "background_color", "highlight_color", "border_radius", "button_hover"),
  "custom_styles" => defaults.custom_styles,
  "email_primary_button_style" => defaults.email_primary_button_style,
  "email_wordmark_image_path" => defaults.email_wordmark_image_path
) + "\n")

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
