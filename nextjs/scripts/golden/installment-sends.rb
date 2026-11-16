# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/installment-sends.golden.json: SendLastPostJob and the reschedule paths of
# SendWorkflowInstallmentWorker (AudienceMember.filter, Installment#audience_members_filter_params, SendWorkflowInstallmentRescheduleJob) run by the real application in production mode against a scratch database, each case as
# a Sidekiq job (support/sidekiq_executor.rb). The provider clients are replaced by recorders, so each case
# holds the request bodies Ruby would have sent. Run it like the application mailer generator:
#
#   GOLDEN_DATABASE=gumroad_ws63 REDIS_DB=13 bundle exec ruby nextjs/scripts/golden/installment-sends.rb
#
# Purchases are plain INSERTs (the purchase factory charges Stripe). Elasticsearch is captured, never reached.
# The AES IVs of the unsubscribe tokens come from a fixed sequence, recorded per case.
require "fileutils"
require "json"

ROOT = File.expand_path("../../..", __dir__)
Dir.chdir(ROOT)

REDIS_DB = ENV.fetch("REDIS_DB", "13")
abort "Refusing to flush Redis db 0" if REDIS_DB == "0"

ENV["RAILS_ENV"] = "production"
ENV["TZ"] = "UTC"
{
  "DATABASE_HOST" => "127.0.0.1", "DATABASE_PORT" => "3306", "DATABASE_NAME" => ENV.fetch("GOLDEN_DATABASE", "gumroad_ws63"),
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

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/installment-sends.golden.json")
NOW = Time.utc(2025, 11, 1, 12, 30, 45)
SEEDED_AT = "2025-01-01 00:00:00"
TABLES = %w[users links purchases subscriptions workflows installments installment_rules sent_post_emails email_infos url_redirects
            seller_profiles followers product_files affiliates affiliates_links feature_announcement_newsletter_cutovers
            audience_members versions subscription_events base_variants base_variants_purchases variant_categories].freeze

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


def run(name, args, job: "SendWorkflowInstallmentWorker", seed: {}, now: NOW, features: %i[], cached_version: 3, setup: nil, failures: [])
  $uuid_seq = 0
  $iv_seq = 0
  $ivs_used.clear
  $provider_calls.clear
  $provider_failures.replace(failures)
  $rands.replace([])
  $rands_used.clear
  result = capture(name, now:, tables: TABLES, seed: base_seed(**seed), setup: lambda {
    features.each { |feature| Feature.activate(feature) }
    redis.set("workflow_installment_rule:10:version", cached_version) if cached_version
    setup&.call
  }, sidekiq: true, job:, args:, case_now: now.to_f) { job.constantize.new.perform(*args) }
  result.delete("rows")
  result.delete("seed")
  result.merge("providers" => $provider_calls.dup, "ivs" => $ivs_used.dup, "rands_used" => $rands_used.dup)
end

def audience_row(id = 1, email: "buyer@example.com", details:, **overrides)
  member = AudienceMember.new(seller_id: 1, email:, details: details.deep_stringify_keys)
  member.valid?
  member.send(:assign_derived_columns)
  attrs = member.attributes.except("id").symbolize_keys
  attrs[:details] = attrs[:details].to_json
  { id: }.merge(attrs).merge(created_at: SEEDED_AT, updated_at: SEEDED_AT).merge(overrides)
end

def purchase_detail(id = 1, created_at: "2025-01-01T00:00:00Z", **overrides)
  { id:, product_id: 1, variant_ids: [], price_cents: 500, created_at:, country: "United States" }.merge(overrides)
end

HOUR = 3600
DAY = 86_400
CREATED = "2025-01-01T00:00:00Z"
DELIVERY = at(Time.utc(2025, 1, 1, 1)) # purchase created_at + the rule's hour
ORIGINAL_SUBSCRIPTION_PURCHASE = 1 << 2
email_info = { id: 1, purchase_id: 1, installment_id: 10, type: "CreatorContactingCustomersEmailInfo", email_name: "purchase_installment", state: "sent", sent_at: SEEDED_AT }
claim = ->(email) { { id: 1, post_id: 10, email:, created_at: SEEDED_AT, updated_at: SEEDED_AT } }
member = ->(**overrides) { { audience_members: [audience_row(details: { purchases: [purchase_detail] }, **overrides)] } }
purchase_member = member.call
event = ->(id, type, occurred_at) { { id:, subscription_id: 1, event_type: type, occurred_at: at(occurred_at), created_at: SEEDED_AT, updated_at: SEEDED_AT } }
membership = lambda do |subscription: {}, flags: ORIGINAL_SUBSCRIPTION_PURCHASE, **purchase|
  {
    links: [link_row(flags: 1 << 9)],
    subscriptions: [{ id: 1, link_id: 1, user_id: 2, seller_id: 1, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(subscription)],
    purchases: [purchase_row(1, subscription_id: 1, flags:, **purchase)],
  }
end
follower_post = { workflows: [workflow_row(workflow_type: "follower", link_id: nil)], installments: [installment_row(installment_type: "follower", link_id: nil)] }
follower_member = ->(created_at: "2025-01-01T00:00:00.000Z", id: 1) { { audience_members: [audience_row(email: "follower@example.com", details: { follower: { id:, created_at: } })] } }
affiliate_post = { workflows: [workflow_row(workflow_type: "affiliate", link_id: nil)], installments: [installment_row(installment_type: "affiliate", link_id: nil)] }
affiliate_rows = lambda do |send_posts: true, created_at: SEEDED_AT, product_created_at: "2025-01-01 00:00:00"|
  {
    affiliates: [{ id: 1, seller_id: 1, affiliate_user_id: 2, type: "DirectAffiliate", affiliate_basis_points: 1000, flags: send_posts ? 2 : 0, created_at:, updated_at: created_at }],
    affiliates_links: [{ id: 1, affiliate_id: 1, link_id: 1, flags: 0, created_at: product_created_at, updated_at: product_created_at }],
    audience_members: [audience_row(email: "user2@example.com", details: { affiliates: [{ id: 1, product_id: 1, created_at: product_created_at.sub(" ", "T") + "Z" }] })],
  }
end
cancel_post = { workflows: [workflow_row(json_data: { workflow_trigger: "member_cancellation" }.to_json)] }
cancelled = membership.call(subscription: { cancelled_at: at(NOW - DAY), deactivated_at: at(NOW - DAY) })
cancelled_at_ref = (NOW - DAY).utc.strftime("%Y-%m-%dT%H:%M:%SZ")
stale = 2
cases = []
RJ = "SendWorkflowInstallmentRescheduleJob"

# --- SendLastPostJob ---------------------------------------------------------------------------------------------------
last = ->(name, args = [1], **options) { cases << run(name, args, job: "SendLastPostJob", cached_version: nil, **options) }
product_post = ->(id = 10, **overrides) { installment_row(id, workflow_id: nil, **overrides) }
last.call("last post: a product post", seed: { workflows: [], installments: [product_post.call], installment_rules: [] })
last.call("last post: no posts", seed: { workflows: [], installments: [], installment_rules: [] })
last.call("last post: purchase does not exist", [999], seed: { workflows: [], installments: [], installment_rules: [] })
last.call("last post: cannot contact", seed: { purchases: [purchase_row(can_contact: false)], workflows: [], installments: [product_post.call], installment_rules: [] })
last.call("last post: a seller post", seed: { workflows: [], installments: [product_post.call(installment_type: "seller", link_id: nil)], installment_rules: [] })
last.call("last post: a variant post", seed: {
  workflows: [], installment_rules: [], installments: [product_post.call(installment_type: "variant", link_id: 1, base_variant_id: 1)],
  base_variants: [{ id: 1, variant_category_id: 1, name: "V", link_id: 1, type: "Variant", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }],
  base_variants_purchases: [{ base_variant_id: 1, purchase_id: 1 }],
  variant_categories: [{ id: 1, link_id: 1, title: "Edition", created_at: SEEDED_AT, updated_at: SEEDED_AT }]
})
last.call("last post: a post for another product", seed: { links: [link_row, link_row(2, unique_permalink: "p2")], workflows: [], installments: [product_post.call(link_id: 2)], installment_rules: [] })
last.call("last post: a post nobody emails", seed: { workflows: [], installments: [product_post.call(flags: 0)], installment_rules: [] })
last.call("last post: a single recipient post", seed: { workflows: [], installments: [product_post.call(flags: installment_flags(:send_emails, :single_recipient_email))], installment_rules: [] })
last.call("last post: an unpublished post", seed: { workflows: [], installments: [product_post.call(published_at: nil)], installment_rules: [] })
last.call("last post: a deleted post", seed: { workflows: [], installments: [product_post.call(deleted_at: SEEDED_AT)], installment_rules: [] })
last.call("last post: a workflow post", seed: { installments: [installment_row], installment_rules: [rule_row] })
last.call("last post: the newest of several", seed: { workflows: [], installment_rules: [], installments: [product_post.call(10, name: "Old", published_at: "2025-02-01 00:00:00"), product_post.call(11, name: "New", published_at: "2025-03-01 00:00:00", slug: "new")] })
last.call("last post: the newest fails the filters", seed: { workflows: [], installment_rules: [], installments: [product_post.call(10, name: "Old", published_at: "2025-02-01 00:00:00"), product_post.call(11, name: "New", published_at: "2025-03-01 00:00:00", slug: "new", json_data: { paid_more_than_cents: 900 }.to_json)] })
last.call("last post: none pass the filters", seed: { workflows: [], installment_rules: [], installments: [product_post.call(json_data: { paid_more_than_cents: 900 }.to_json)] })
last.call("last post: already claimed", seed: { workflows: [], installments: [product_post.call], installment_rules: [], sent_post_emails: [claim.call("buyer@example.com")] })
last.call("last post: a membership", seed: merge_seeds(membership.call, { workflows: [], installments: [product_post.call], installment_rules: [] }))
last.call("last post: sendgrid rejects", failures: [500], seed: { workflows: [], installments: [product_post.call], installment_rules: [] })
last.call("last post: resend", features: %i[use_resend_for_post_emails force_resend_for_post_emails], seed: { workflows: [], installments: [product_post.call], installment_rules: [] })
last.call("last post: a post with files", seed: { workflows: [], installments: [product_post.call], installment_rules: [], product_files: [{ id: 1, link_id: nil, installment_id: 10, url: "https://example.com/f.pdf", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }] })
last.call("last post: a post with a filter Node does not read", seed: { workflows: [], installment_rules: [], installments: [product_post.call(json_data: { created_after: "soon" }.to_json)] })

# --- reschedule: purchases -------------------------------------------------------------------------------------------
cases << run("reschedule: purchase, stale version", [10, stale, 1, nil], seed: purchase_member)
cases << run("reschedule: purchase, stale version, no audience member", [10, stale, 1, nil])
cases << run("reschedule: purchase, stale version, purchase not in the member", [10, stale, 1, nil], seed: { audience_members: [audience_row(details: { purchases: [purchase_detail(2)] })] })
cases << run("reschedule: purchase, stale version, the filters no longer match", [10, stale, 1, nil], seed: merge_seeds(purchase_member, { installments: [installment_row(json_data: { bought_products: %w[nope] }.to_json)] }))
cases << run("reschedule: purchase, stale version, the filters match a product", [10, stale, 1, nil], seed: merge_seeds(purchase_member, { installments: [installment_row(json_data: { bought_products: %w[p1] }.to_json)] }))
cases << run("reschedule: purchase, stale version, already emailed address", [10, stale, 1, nil], seed: merge_seeds(purchase_member, { sent_post_emails: [claim.call("buyer@example.com")] }))
cases << run("reschedule: purchase, stale version, workflow does not apply", [10, stale, 1, nil], seed: merge_seeds(purchase_member, { workflows: [workflow_row(json_data: { paid_more_than_cents: 600 }.to_json)] }))
cases << run("reschedule: purchase, stale version, post for new customers published after the purchase", [10, stale, 1, nil],
             seed: merge_seeds(purchase_member, { installments: [installment_row(flags: installment_flags(:send_emails, :is_for_new_customers_of_workflow), published_at: "2025-06-01 00:00:00")] }))
cases << run("reschedule: purchase, stale version, post for new customers published before the purchase", [10, stale, 1, nil],
             seed: merge_seeds(purchase_member, { installments: [installment_row(flags: installment_flags(:send_emails, :is_for_new_customers_of_workflow), published_at: "2024-12-01 00:00:00")] }))
cases << run("reschedule: purchase, stale version, purchase does not exist", [10, stale, 999, nil])
cases << run("reschedule: purchase, stale version, with a reference time", [10, stale, 1, nil, nil, nil, "2024-12-31T00:00:00Z"], seed: purchase_member)
cases << run("reschedule: purchase, job version ahead of the rule", [10, 4, 1, nil], seed: purchase_member)
cases << run("reschedule: purchase, resubscribed membership", [10, stale, 1, nil],
             seed: merge_seeds(membership.call(created_at: at(NOW - 90 * DAY)), { audience_members: [audience_row(details: { purchases: [purchase_detail(1, created_at: at(NOW - 90 * DAY).sub(" ", "T").sub(/\.\d+/, "") + "Z")] })] },
                               { subscription_events: [event.call(1, 0, NOW - 40 * DAY), event.call(2, 1, NOW - 39 * DAY)] }))
cases << run("reschedule: purchase, current version, matching reference time", [10, 3, 1, nil, nil, nil, CREATED], seed: purchase_member)
cases << run("reschedule: purchase, current version, reference time of another sale time", [10, 3, 1, nil, nil, nil, "2024-12-31T00:00:00Z"], seed: purchase_member)
cases << run("reschedule: purchase, current version, reference time and no audience member", [10, 3, 1, nil, nil, nil, CREATED])
cases << run("reschedule: purchase, current version, reference time of a purchase that does not exist", [10, 3, 999, nil, nil, nil, CREATED], seed: purchase_member)
cases << run("reschedule: purchase, current version, resubscribed membership moved the reference time", [10, 3, 1, nil, nil, nil, at(NOW - 90 * DAY).sub(" ", "T").sub(/\.\d+/, "") + "Z"],
             seed: merge_seeds(membership.call(created_at: at(NOW - 90 * DAY)), { audience_members: [audience_row(details: { purchases: [purchase_detail(1, created_at: at(NOW - 90 * DAY).sub(" ", "T").sub(/\.\d+/, "") + "Z")] })] },
                               { subscription_events: [event.call(1, 0, NOW - 40 * DAY), event.call(2, 1, NOW - 39 * DAY)] }))
cases << run("reschedule: purchase, current version, not due yet after resubscribing", [10, 3, 1, nil, nil, nil, at(NOW - DAY).sub(" ", "T").sub(/\.\d+/, "") + "Z"],
             seed: merge_seeds(membership.call(created_at: at(NOW - DAY)), { audience_members: [audience_row(details: { purchases: [purchase_detail(1, created_at: at(NOW - DAY).sub(" ", "T").sub(/\.\d+/, "") + "Z")] })] },
                               { subscription_events: [event.call(1, 0, NOW - 20 * DAY), event.call(2, 1, NOW - 10 * DAY)] }))
cases << run("purchase: too soon, resubscribed membership, no reference time", [10, 3, 1, nil],
             seed: merge_seeds(membership.call(created_at: at(NOW - DAY)), { subscription_events: [event.call(1, 0, NOW - 20 * DAY), event.call(2, 1, NOW - 10 * DAY)] }))

# --- reschedule: followers ----------------------------------------------------------------------------------------------
fm = follower_member.call
follower = { followers: [follower_row] }
cases << run("reschedule: follower, stale version", [10, stale, nil, 1], seed: merge_seeds(follower_post, follower, fm))
cases << run("reschedule: follower, stale version, unconfirmed", [10, stale, nil, 1], seed: merge_seeds(follower_post, { followers: [follower_row(confirmed_at: nil)] }, fm))
cases << run("reschedule: follower, stale version, deleted", [10, stale, nil, 1], seed: merge_seeds(follower_post, { followers: [follower_row(deleted_at: SEEDED_AT)] }, fm))
cases << run("reschedule: follower, stale version, follower does not exist", [10, stale, nil, 999], seed: merge_seeds(follower_post, fm))
cases << run("reschedule: follower, stale version, already emailed address", [10, stale, nil, 1], seed: merge_seeds(follower_post, follower, fm, { sent_post_emails: [claim.call("follower@example.com")] }))
cases << run("reschedule: follower, stale version, no audience member", [10, stale, nil, 1], seed: merge_seeds(follower_post, follower))
cases << run("reschedule: follower, stale version, the member's follower is another", [10, stale, nil, 1], seed: merge_seeds(follower_post, follower, follower_member.call(id: 2)))
cases << run("reschedule: follower, stale version, created after the follower", [10, stale, nil, 1],
             seed: merge_seeds({ workflows: follower_post[:workflows], installments: [installment_row(installment_type: "follower", link_id: nil, json_data: { created_after: "2025-03-01T00:00:00.000-08:00" }.to_json)] }, follower, fm))
cases << run("reschedule: follower, stale version, created before the follower", [10, stale, nil, 1],
             seed: merge_seeds({ workflows: follower_post[:workflows], installments: [installment_row(installment_type: "follower", link_id: nil, json_data: { created_before: "2024-12-01T00:00:00.000-08:00" }.to_json)] }, follower, fm))
cases << run("reschedule: follower, stale version, created within the dates", [10, stale, nil, 1],
             seed: merge_seeds({ workflows: follower_post[:workflows], installments: [installment_row(installment_type: "follower", link_id: nil, json_data: { created_after: "2024-12-01T00:00:00.000-08:00", created_before: "2025-03-01T23:59:59.999-08:00" }.to_json)] }, follower, fm))
cases << run("reschedule: follower, stale version, reference time of another confirmation", [10, stale, nil, 1, nil, nil, "2024-12-31T00:00:00Z"], seed: merge_seeds(follower_post, follower, fm))
cases << run("reschedule: follower, stale version, matching reference time", [10, stale, nil, 1, nil, nil, CREATED], seed: merge_seeds(follower_post, follower, fm))
cases << run("reschedule: follower, current version, matching reference time", [10, 3, nil, 1, nil, nil, CREATED], seed: merge_seeds(follower_post, follower, fm))
cases << run("reschedule: follower, current version, reference time that does not match", [10, 3, nil, 1, nil, nil, "2024-12-31T00:00:00Z"], seed: merge_seeds(follower_post, follower, fm))
cases << run("reschedule: follower, current version, follower of another seller", [10, 3, nil, 1, nil, nil, CREATED], seed: merge_seeds(follower_post, { followers: [follower_row(followed_id: 2)] }, fm))
cases << run("reschedule: follower, audience post", [10, stale, nil, 1], seed: merge_seeds({ workflows: [workflow_row(workflow_type: "audience", link_id: nil)], installments: [installment_row(installment_type: "audience", link_id: nil)] }, follower, fm))

# --- reschedule: affiliates ------------------------------------------------------------------------------------------------
cases << run("reschedule: affiliate, stale version", [10, stale, nil, nil, 2], seed: merge_seeds(affiliate_post, affiliate_rows.call))
cases << run("reschedule: affiliate, stale version, does not send posts", [10, stale, nil, nil, 2], seed: merge_seeds(affiliate_post, affiliate_rows.call(send_posts: false)))
cases << run("reschedule: affiliate, stale version, no audience member", [10, stale, nil, nil, 2], seed: merge_seeds(affiliate_post, affiliate_rows.call.except(:audience_members)))
cases << run("reschedule: affiliate, stale version, user does not exist", [10, stale, nil, nil, 999], seed: merge_seeds(affiliate_post, affiliate_rows.call))
cases << run("reschedule: affiliate, stale version, already emailed address", [10, stale, nil, nil, 2], seed: merge_seeds(affiliate_post, affiliate_rows.call, { sent_post_emails: [claim.call("user2@example.com")] }))
cases << run("reschedule: affiliate, stale version, for another product", [10, stale, nil, nil, 2],
             seed: merge_seeds({ workflows: affiliate_post[:workflows], installments: [installment_row(installment_type: "affiliate", link_id: nil, json_data: { affiliate_products: %w[p2] }.to_json)], links: [link_row, link_row(2, unique_permalink: "p2")] }, affiliate_rows.call))
cases << run("reschedule: affiliate, stale version, for the assignment's product", [10, stale, nil, nil, 2],
             seed: merge_seeds({ workflows: affiliate_post[:workflows], installments: [installment_row(installment_type: "affiliate", link_id: nil, json_data: { affiliate_products: %w[p1] }.to_json)] }, affiliate_rows.call))
cases << run("reschedule: affiliate, stale version, created after the affiliate", [10, stale, nil, nil, 2],
             seed: merge_seeds({ workflows: affiliate_post[:workflows], installments: [installment_row(installment_type: "affiliate", link_id: nil, json_data: { created_after: "2025-03-01T00:00:00.000-08:00" }.to_json)] }, affiliate_rows.call))
cases << run("reschedule: affiliate, stale version, matching reference time", [10, stale, nil, nil, 2, nil, CREATED], seed: merge_seeds(affiliate_post, affiliate_rows.call))
cases << run("reschedule: affiliate, stale version, reference time that does not match", [10, stale, nil, nil, 2, nil, "2024-12-31T00:00:00Z"], seed: merge_seeds(affiliate_post, affiliate_rows.call))
cases << run("reschedule: affiliate, current version, matching reference time", [10, 3, nil, nil, 2, nil, CREATED], seed: merge_seeds(affiliate_post, affiliate_rows.call))
cases << run("reschedule: affiliate, current version, reference time in the future", [10, 3, nil, nil, 2, nil, "2025-12-31T00:00:00Z"],
             seed: merge_seeds(affiliate_post, affiliate_rows.call(product_created_at: "2025-12-31 00:00:00")))
cases << run("reschedule: affiliate, stale version, deleted affiliate", [10, stale, nil, nil, 2], seed: merge_seeds(affiliate_post, affiliate_rows.call, { affiliates: [affiliate_rows.call[:affiliates][0].merge(deleted_at: SEEDED_AT)] }).merge(affiliates: [affiliate_rows.call[:affiliates][0].merge(deleted_at: SEEDED_AT)]))

# --- reschedule: member cancellations --------------------------------------------------------------------------------------------
cases << run("reschedule: cancellation, stale version", [10, stale, nil, nil, nil, 1], seed: merge_seeds(cancel_post, cancelled))
cases << run("reschedule: cancellation, stale version, subscription still alive", [10, stale, nil, nil, nil, 1], seed: merge_seeds(cancel_post, membership.call))
cases << run("reschedule: cancellation, stale version, subscription does not exist", [10, stale, nil, nil, nil, 999], seed: cancel_post)
cases << run("reschedule: cancellation, stale version, already emailed address", [10, stale, nil, nil, nil, 1], seed: merge_seeds(cancel_post, cancelled, { sent_post_emails: [claim.call("buyer@example.com")] }))
cases << run("reschedule: cancellation, stale version, workflow does not apply", [10, stale, nil, nil, nil, 1], seed: merge_seeds({ workflows: [workflow_row(json_data: { workflow_trigger: "member_cancellation", paid_more_than_cents: 600 }.to_json)] }, cancelled))
cases << run("reschedule: cancellation, stale version, reference time that does not match", [10, stale, nil, nil, nil, 1, "2024-12-31T00:00:00Z"], seed: merge_seeds(cancel_post, cancelled))
cases << run("reschedule: cancellation, stale version, matching reference time", [10, stale, nil, nil, nil, 1, cancelled_at_ref], seed: merge_seeds(cancel_post, cancelled))
cases << run("reschedule: cancellation, current version, matching reference time", [10, 3, nil, nil, nil, 1, cancelled_at_ref], seed: merge_seeds(cancel_post, cancelled))
cases << run("reschedule: cancellation, post for new customers published after the cancellation", [10, stale, nil, nil, nil, 1],
             seed: merge_seeds({ workflows: cancel_post[:workflows], installments: [installment_row(flags: installment_flags(:send_emails, :is_for_new_customers_of_workflow), published_at: at(NOW))] }, cancelled))

# --- SendWorkflowInstallmentRescheduleJob ------------------------------------------------------------------------------------------
cases << run("reschedule job: one recipient", [10, 3, 1, nil, nil, nil, CREATED], job: RJ, seed: purchase_member)
cases << run("reschedule job: stale version", [10, stale, 1, nil, nil, nil, CREATED], job: RJ, seed: purchase_member)
cases << run("reschedule job: no recipient", [10, 3, nil, nil, nil, nil, CREATED], job: RJ, seed: purchase_member)
cases << run("reschedule job: two recipients", [10, 3, 1, 1, nil, nil, CREATED], job: RJ, seed: purchase_member)

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
