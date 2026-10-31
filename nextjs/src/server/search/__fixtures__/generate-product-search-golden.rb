# frozen_string_literal: true

# Produces product-search.golden.json by running the real app: Product::Searchable,
# ProductIndexingService, SendToElasticsearchWorker and the jobs that reindex products, on the full
# Rails bundle against a scratch MySQL database. Records are built with the spec factories; each
# case then records every statement MySQL answered (with its rows), every Elasticsearch request
# (answered from the case's script by a local socket) and the Sidekiq Redis state it left.
#
# Each case runs with a fresh query cache, as a Sidekiq job or request does (the Rails executor
# enables it), so a statement repeated within a case is sent once.
#
#   # gumroad_ws37: an empty copy of gumroad_test's schema. Every table is truncated first.
#   RAILS_ENV=test DATABASE_NAME=gumroad_ws37 TEST_DATABASE_NAME=gumroad_ws37 DISABLE_TEST_REDIS_ISOLATION=1 \
#     REDIS_HOST=localhost:6379/13 SIDEKIQ_REDIS_HOST=localhost:6379/13 \
#     bin/rails runner nextjs/src/server/search/__fixtures__/generate-product-search-golden.rb
abort "Refusing to run outside the test environment" unless Rails.env.test?
abort "Refusing to truncate #{ActiveRecord::Base.connection.current_database}" if ActiveRecord::Base.connection.current_database == "gumroad_test"
abort "Refusing to flush Redis db 0" if Sidekiq.redis { _1.call("CLIENT", "INFO") }[/ db=0 /]

require "factory_bot"
require "socket"
require "active_support/testing/time_helpers"
FactoryBot.definition_file_paths << Rails.root.join("spec", "support", "factories")
FactoryBot.reload
include FactoryBot::Syntax::Methods
include ActiveSupport::Testing::TimeHelpers

FIXED_NOW = Time.utc(2026, 10, 1, 12, 0, 0)
travel_to(FIXED_NOW)
Kernel.srand(37)
Faker::Config.random = Random.new(37)
$jid_seq = 0
module SecureRandom
  def self.hex(n = nil)
    return super unless n == 12
    $jid_seq += 1
    format("%024x", $jid_seq)
  end
end
SidekiqUniqueJobs.config.enabled = true
# The test bundle loads sidekiq/testing, whose fake mode keeps pushes out of Redis.
Sidekiq::Testing.disable! if defined?(Sidekiq::Testing)

# --- MySQL: every statement the server answers, with its rows ---------------------------------------
module SqlCapture
  class << self
    attr_accessor :on
    def log = (@log ||= [])

    def encode(value)
      case value
      when Time then { "$time" => value.utc.strftime("%Y-%m-%dT%H:%M:%S.%6NZ") }
      when BigDecimal then { "$decimal" => value.to_s("F") }
      when Date then raise "date column in a captured row"
      when String then value.encoding == Encoding::BINARY && !value.dup.force_encoding("UTF-8").valid_encoding? ? { "$binary" => [value].pack("m0") } : value.dup.force_encoding("UTF-8")
      else value
      end
    end
  end

  def query(sql, *rest, **options)
    result = super
    if SqlCapture.on && !sql.start_with?("SET ", "SHOW ", "SELECT @@") && !sql.include?("information_schema")
      entry = { "sql" => sql }
      if result.is_a?(Mysql2::Result)
        rows = result.to_a.map { |row| (row.is_a?(Hash) ? row.values : row).map { SqlCapture.encode(_1) } }
        entry["result"] = { "fields" => result.fields, "rows" => rows }
      else
        entry["result"] = { "affected" => affected_rows, "last_id" => (sql.start_with?("INSERT") ? last_id : nil) }.compact
      end
      SqlCapture.log << entry
    end
    result
  end
end
Mysql2::Client.prepend(SqlCapture)

# --- Elasticsearch: a socket that records requests and answers from a script ------------------------
module EsCapture
  class << self
    attr_accessor :responses
    def requests = (@requests ||= [])

    def start
      server = TCPServer.new("127.0.0.1", 0)
      Thread.new { loop { serve(server.accept) } }
      server.addr[1]
    end

    def serve(socket)
      method, target = socket.gets.split(" ")
      headers = {}
      while (line = socket.gets) && line != "\r\n"
        key, value = line.split(": ", 2)
        headers[key.downcase] = value.strip
      end
      body = headers["content-length"] ? socket.read(headers["content-length"].to_i) : nil
      path, query = target.split("?", 2)
      requests << { "method" => method, "path" => path, "query" => query, "body" => body }
      status, payload = (responses || []).shift || [200, {}]
      text = payload.is_a?(String) ? payload : JSON.generate(payload)
      socket.write("HTTP/1.1 #{status} X\r\nContent-Type: application/json\r\nContent-Length: #{text.bytesize}\r\nConnection: close\r\n\r\n#{text}")
    ensure
      socket.close
    end
  end
end
es_port = EsCapture.start
Object.send(:remove_const, :EsClient)
EsClient = Elasticsearch::Model.client = Elasticsearch::Client.new(
  host: "http://127.0.0.1:#{es_port}", retry_on_failure: 5, transport_options: { request: { timeout: 15 } }
)
[Link, Purchase, Installment, AudienceMember, ConfirmedFollowerEvent, ProductPageView].each { _1.__elasticsearch__.client = EsClient }

# --- Redis ------------------------------------------------------------------------------------------
SIDEKIQ_KEYS = /\A(queue:|queues\z|schedule\z|retry\z|dead\z|uniquejobs|send_to_elasticsearch_worker:|nextjs:)/

def snapshot
  Sidekiq.redis do |conn|
    conn.call("KEYS", "*").select { SIDEKIQ_KEYS.match?(_1) }.sort.to_h do |key|
      type = conn.call("TYPE", key)
      value =
        case type
        when "string" then conn.call("GET", key)
        when "list" then conn.call("LRANGE", key, 0, -1)
        when "set" then conn.call("SMEMBERS", key).sort
        when "hash" then conn.call("HGETALL", key)
        when "zset" then conn.call("ZRANGE", key, 0, -1, "WITHSCORES").flatten.each_slice(2).map { |m, score| [m, score.to_f] }
        end
      if key == "uniquejobs:changelog"
        next [key, { "type" => type, "messages" => value.map { |(json, _)| JSON.parse(json)["message"] }, "expires" => conn.call("PTTL", key).positive? }]
      end
      [key, { "type" => type, "value" => value, "expires" => conn.call("PTTL", key).positive? }]
    end
  end
end

def flush_sidekiq!
  Sidekiq.redis do |conn|
    keys = conn.call("KEYS", "*").select { SIDEKIQ_KEYS.match?(_1) }
    conn.call("DEL", *keys) unless keys.empty?
  end
end

# Flipper reads $redis; a case lists the features it turns on, for Node's injected Feature.active?.
def with_features(features)
  features.each { |name, actor| actor ? Feature.activate_user(name, actor) : Feature.activate(name) }
  yield
ensure
  features.each { |name, actor| actor ? Feature.deactivate_user(name, actor) : Feature.deactivate(name) }
end

# Runs `block` as one job or request would: a fresh query cache, nothing else captured.
def run(name, es: [], features: [], args: nil, setup: nil)
  with_features(features) do
    flush_sidekiq!
    setup&.call
    $jid_seq = 0
    EsCapture.requests.clear
    EsCapture.responses = es.dup
    ActiveRecord::Base.connection.clear_query_cache
    SqlCapture.log.clear
    error = nil
    result = nil
    SqlCapture.on = true
    begin
      result = yield
    rescue StandardError => e
      error = { "class" => e.class.name, "message" => e.message }
      warn "#{name}: #{e.class}: #{e.message}\n  #{e.backtrace.first(8).join("\n  ")}" if ENV["SCRATCH"]
    ensure
      SqlCapture.on = false
    end
    {
      "name" => name, "args" => args, "error" => error, "result" => result.as_json, "statements" => SqlCapture.log.dup,
      "es" => EsCapture.requests.dup, "es_responses" => es, "features" => features.map { |n, a| [n.to_s, a && "#{a.class.name};#{a.id}"] },
      "redis" => snapshot,
    }
  end
end

def truncate_all!
  conn = ActiveRecord::Base.connection
  conn.execute("SET FOREIGN_KEY_CHECKS = 0")
  (conn.tables - %w[schema_migrations ar_internal_metadata]).each { conn.execute("TRUNCATE TABLE `#{_1}`") }
  conn.execute("SET FOREIGN_KEY_CHECKS = 1")
end

# Sum aggregations come back as doubles: `"value": 900.0`.
def aggs(**values) = [200, { "took" => 1, "hits" => { "total" => { "value" => 0, "relation" => "eq" }, "hits" => [] }, "aggregations" => values.transform_values { { "value" => _1.to_f } } }]
def sales_aggs(price, refunded) = aggs(price_cents_total: price, amount_refunded_cents_total: refunded)
def fee_aggs(fee, refunded) = aggs(fee_cents_total: fee, fee_refunded_cents_total: refunded)
DOC_ES = [sales_aggs(12_345, 345), fee_aggs(1_200, 20), fee_aggs(5_000, 50)].freeze

truncate_all!
golden = { "now" => FIXED_NOW.to_f, "es_index" => Link.index_name }
golden["search_fields"] = Link::SEARCH_FIELDS.to_a
golden["attribute_to_search_fields"] = Link.const_get(:ATTRIBUTE_TO_SEARCH_FIELDS_MAP)

# --- records ----------------------------------------------------------------------------------------
seller = create(:compliant_user, name: "Seller <One>", username: "sellerone", bio: "Hi")
seller.update_columns(payment_address: "seller@example.com")
plain = create(:product, user: seller, name: "Plain", description: "A plain product", price_cents: 500)

rich_seller = create(:compliant_user, name: nil, username: "richseller", bio: "Adult toys", payment_address: nil)
create(:ach_account, user: rich_seller)
taxonomy = create(:taxonomy, slug: "design")
TaxonomyAttribute.create!(taxonomy:, name: "format", label: "Format", value_type: "enum", values: ["Video Course", "Ébook"], position: 1)
TaxonomyAttribute.create!(taxonomy:, name: "has_audio", label: "Audio", value_type: "boolean", position: 0)
TaxonomyAttribute.create!(taxonomy:, name: "pages", label: "Pages", value_type: "number", position: 2)
TaxonomyAttribute.create!(taxonomy:, name: "retired", label: "Retired", value_type: "enum", values: ["x"], position: 3, active: false)
rich = create(:product, user: rich_seller, name: "Rich", description: "<p>Rich</p>", price_cents: 1_000, taxonomy:, max_purchase_count: 10)
rich.update_columns(content_updated_at: Time.utc(2026, 9, 1, 8, 30, 15), sales_count_for_inventory_cache: 3)
%w[zeta alpha].each { |name| rich.tag!(name) }
create(:product_file, link: rich, url: "#{S3_BASE_URL}specs/a.pdf")
create(:product_file, link: rich, url: "#{S3_BASE_URL}specs/b.mp3")
create(:product_file, link: rich, url: "#{S3_BASE_URL}specs/c.pdf")
create(:product_file, link: rich, url: "#{S3_BASE_URL}specs/d.zip").mark_deleted!
ProductReviewStat.create!(link: rich, reviews_count: 2, average_rating: 4.5)
StaffPickedProduct.create!(product: rich).update_columns(updated_at: Time.utc(2026, 9, 15, 10, 0, 0))
travel_to(Time.utc(2026, 9, 2)) { create(:offer_code, user: rich_seller, products: [rich], code: "second") }
travel_to(Time.utc(2026, 9, 1)) { create(:offer_code, user: rich_seller, products: [rich], code: "first") }
travel_to(Time.utc(2026, 9, 3)) { create(:universal_offer_code, user: rich_seller, code: "everyone", currency_type: "usd") }
travel_to(Time.utc(2026, 9, 4)) { create(:universal_offer_code, user: rich_seller, code: "euros", currency_type: "eur") }
travel_to(Time.utc(2026, 9, 5)) { create(:offer_code, user: rich_seller, products: [rich], code: "gone").mark_deleted! }
excluded = travel_to(Time.utc(2026, 9, 6)) { create(:universal_offer_code, user: rich_seller, code: "notyou", currency_type: nil) }
excluded.excluded_products << rich
travel_to(Time.utc(2026, 9, 7)) { create(:universal_offer_code, user: rich_seller, code: "anycurrency", currency_type: nil) }
Purchase.insert({ link_id: rich.id, seller_id: rich_seller.id, purchase_state: "successful", price_cents: 1_000, email: "buyer@example.com", created_at: FIXED_NOW, updated_at: FIXED_NOW })

membership = create(:membership_product_with_preset_tiered_pricing, user: seller, name: "Club")
tiers = membership.tier_category.variants.alive.order(:id).to_a
tiers.first.update!(flags: tiers.first.flags | BaseVariant.flag_mapping["flags"][:closed_to_new_purchases])

versions = create(:product, user: seller, name: "Versions", price_cents: 300)
version_category = create(:variant_category, link: versions, title: "Edition")
create(:variant, variant_category: version_category, name: "Hardcover", price_difference_cents: 200)
create(:variant, variant_category: version_category, name: "Paperback", price_difference_cents: 0)
create(:variant, variant_category: version_category, name: "Gone", price_difference_cents: 900).mark_deleted!

rental = create(:product, user: seller, name: "Rental", purchase_type: "buy_and_rent", price_cents: 700, rental_price_cents: 200)

nameless = create(:user, name: nil, username: nil, user_risk_state: "not_reviewed")
create(:merchant_account_stripe_connect, user: nameless)
dead = create(:product, user: nameless, name: "Dead", price_cents: 0)
dead.update_columns(deleted_at: Time.utc(2026, 9, 20), purchase_disabled_at: Time.utc(2026, 9, 19))
StaffPickedProduct.create!(product: dead, deleted_at: Time.utc(2026, 9, 21))

paypal_seller = create(:compliant_user, name: "Pal", payment_address: nil)
create(:merchant_account_paypal, user: paypal_seller)
archived = create(:product, user: paypal_seller, name: "Archived", is_adult: true, archived: true, price_cents: 100)
archived.update_columns(native_type: "call")
rent_only = create(:product, user: seller, name: "Rent only", purchase_type: "rent_only", price_cents: 250, rental_price_cents: 250)

# Last: saving the product (tags, files, offer codes) reclassifies it and clears inferred values.
rich.update_columns(json_data: { "taxonomy_attribute_values" => { "format" => "Ébook", "pages" => "120" }, "inferred_taxonomy_attribute_values" => { "format" => "Video Course", "has_audio" => "true", "retired" => "x" } })
Purchase.insert({ link_id: plain.id, seller_id: seller.id, purchase_state: "successful", price_cents: 500, email: "old@example.com", created_at: Time.utc(2026, 5, 1), updated_at: Time.utc(2026, 5, 1) })

# --- documents --------------------------------------------------------------------------------------
golden["documents"] = [
  run("plain product", es: DOC_ES, args: [plain.id]) { Link.find(plain.id).as_indexed_json },
  run("rich product", es: DOC_ES, args: [rich.id]) { Link.find(rich.id).as_indexed_json },
  run("tiered membership", es: DOC_ES, args: [membership.id]) { Link.find(membership.id).as_indexed_json },
  run("tiered membership, a tier closed to new buyers", es: DOC_ES, args: [membership.id], features: [[:close_membership_tier_to_new_buyers, seller]]) { Link.find(membership.id).as_indexed_json },
  run("versions", es: DOC_ES, args: [versions.id]) { Link.find(versions.id).as_indexed_json },
  run("buy and rent", es: DOC_ES, args: [rental.id]) { Link.find(rental.id).as_indexed_json },
  run("rent only", es: DOC_ES, args: [rent_only.id]) { Link.find(rent_only.id).as_indexed_json },
  run("deleted product of an unnamed seller", es: DOC_ES, args: [dead.id]) { Link.find(dead.id).as_indexed_json },
  run("archived adult call of a PayPal seller", es: DOC_ES, args: [archived.id]) { Link.find(archived.id).as_indexed_json },
  run("purchase search fails", es: [[503, { "error" => "unavailable" }]], args: [plain.id]) { Link.find(plain.id).as_indexed_json },
  run("search update", es: [fee_aggs(10, 1)], args: [rich.id, %w[is_recommendable rated_as_adult creator_name total_fee_cents tags]]) { Link.find(rich.id).build_search_update(%w[is_recommendable rated_as_adult creator_name total_fee_cents tags]) },
  run("search update of an unknown field", args: [plain.id, %w[name nope]]) { Link.find(plain.id).build_search_update(%w[name nope]) },
]

# --- jobs -------------------------------------------------------------------------------------------
UPDATED = [200, { "_index" => "products", "_id" => "1", "result" => "updated" }].freeze
UNAVAILABLE = [503, { "error" => "unavailable" }].freeze
# A case with `trailing` starts with the key MarkForTrailingRun sets when a duplicate is dropped.
def send_to_es(name, args, es: [], trailing: false)
  key = SendToElasticsearchWorker.trailing_key(args)
  setup = trailing ? -> { Sidekiq.redis { _1.call("SET", key, "1", "EX", 600) } } : nil
  run(name, es:, args:, setup:) { SendToElasticsearchWorker.new.perform(*args) }.merge(trailing ? { "trailing_key" => key } : {})
end

golden["jobs"] = {}
golden["jobs"]["SendToElasticsearchWorker"] = [
  send_to_es("index", [plain.id, "index"], es: DOC_ES + [UPDATED]),
  send_to_es("update", [rich.id, "update", %w[sales_volume is_recommendable]], es: [sales_aggs(900, 0), UPDATED]),
  send_to_es("update with no attributes", [rich.id, "update", []]),
  send_to_es("update without an attributes argument", [rich.id, "update"]),
  send_to_es("unknown action", [rich.id, "reindex", ["name"]]),
  send_to_es("missing product", [9_999, "index"]),
  send_to_es("Elasticsearch fails", [rich.id, "update", ["name"]], es: [UNAVAILABLE]),
  send_to_es("unknown field", [rich.id, "update", ["nope"]]),
  send_to_es("a duplicate was dropped while queued", [rich.id, "update", ["name"]], es: [UPDATED], trailing: true),
  send_to_es("a duplicate was dropped and the run fails", [rich.id, "update", ["name"]], es: [UNAVAILABLE], trailing: true),
  send_to_es("a duplicate was dropped and the product is gone", [9_999, "update", ["name"]], trailing: true),
]

refresh = lambda do |klass|
  [
    run("seller with several products, one update fails", es: [UPDATED, UNAVAILABLE, UPDATED, UPDATED, UPDATED], args: [seller.id]) { klass.new.perform(seller.id) },
    run("seller with one product", es: [UPDATED], args: [rich_seller.id]) { klass.new.perform(rich_seller.id) },
    run("missing user", args: [9_999]) { klass.new.perform(9_999) },
  ]
end
golden["jobs"]["RefreshUserProductsRecommendationEligibilityJob"] = refresh.call(RefreshUserProductsRecommendationEligibilityJob)
golden["jobs"]["RefreshMerchantAccountProductsRecommendationEligibilityJob"] = refresh.call(RefreshMerchantAccountProductsRecommendationEligibilityJob)

# A two-hit scroll page makes the paging reachable without a thousand products.
golden["reindex_scroll_size"] = 2
ReindexRecommendableProductsWorker.send(:remove_const, :SCROLL_SIZE)
ReindexRecommendableProductsWorker.const_set(:SCROLL_SIZE, golden["reindex_scroll_size"])
def page(scroll_id, *ids) = [200, { "_scroll_id" => scroll_id, "hits" => { "hits" => ids.map { { "_index" => "products", "_id" => _1.to_s, "_score" => nil } } } }]
golden["jobs"]["ReindexRecommendableProductsWorker"] = [
  run("two pages", es: [page("s1", rich.id, plain.id), page("s2", versions.id), [200, { "succeeded" => true }]], args: []) { ReindexRecommendableProductsWorker.new.perform },
  run("a full last page scrolls once more", es: [page("s1", rich.id, plain.id), page("s2"), [200, {}]], args: []) { ReindexRecommendableProductsWorker.new.perform },
  run("no hits", es: [page("s0"), [200, {}]], args: []) { ReindexRecommendableProductsWorker.new.perform },
  run("scroll fails", es: [page("s1", rich.id, plain.id), UNAVAILABLE], args: []) { ReindexRecommendableProductsWorker.new.perform },
]

# User#update_product_search_index!: Node receives the product ids, so the first statement (the
# find_each batch) is the caller's, and each product's update runs after commit.
user_hook = lambda do |name, user, change_list, es|
  run(name, es:, args: [user.id, change_list]) do
    ActiveRecord::Base.transaction { user.products.find_each { _1.enqueue_index_update_for(change_list) } }
  end
end
golden["user_product_index_updates"] = [
  user_hook.call("name change", seller, %w[rated_as_adult creator_name], [UPDATED, UPDATED, UNAVAILABLE, UPDATED, UPDATED]),
  user_hook.call("compliance change", rich_seller, %w[is_recommendable], [UPDATED]),
]

File.write(File.join(__dir__, "product-search.golden.json"), JSON.pretty_generate(golden) + "\n")
puts "wrote product-search.golden.json"
