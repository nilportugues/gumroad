# frozen_string_literal: true

# Produces discover-search.golden.json: Product::Searchable's query builders (search_options,
# filetype_options, taxonomy_attribute_options, partial_search_options), the SearchProducts concern
# (param normalization, the aggregation handling of search_products) and the Elasticsearch
# requests they send, run on the real app against the real Elasticsearch. A TCP proxy sits between
# EsClient and Elasticsearch, so the request recorded is the exact method, path, query and body the
# client put on the wire, next to the answer Elasticsearch gave.
#
# The indices are the ws65-* ones this script creates and fills with a fixed catalogue (never the
# spec indices); MySQL is a scratch database whose taxonomy and attribute tables are truncated first.
#
#   scratchpad/ws65-run.sh bin/rails runner nextjs/src/server/search/__fixtures__/generate-discover-search-golden.rb
abort "Refusing to run outside the test environment" unless Rails.env.test?
abort "Refusing to truncate #{ActiveRecord::Base.connection.current_database}" unless ActiveRecord::Base.connection.current_database == "gumroad_ws65"

require "net/http"
require "socket"
require "json"
require "active_support/testing/time_helpers"
include ActiveSupport::Testing::TimeHelpers

REAL_ES = URI(ENV.fetch("ELASTICSEARCH_HOST"))
FIXED_NOW = Time.utc(2026, 10, 1, 12, 0, 0)
travel_to(FIXED_NOW)

# --- Elasticsearch proxy ----------------------------------------------------------------------------
module EsProxy
  class << self
    attr_accessor :on
    def log = (@log ||= [])

    def start
      server = TCPServer.new("127.0.0.1", 0)
      Thread.new { loop { Thread.new(server.accept) { |socket| serve(socket) } } }
      server.addr[1]
    end

    def serve(socket)
      loop do
        line = socket.gets or break
        method, target = line.split(" ")
        headers = {}
        while (header = socket.gets) && header != "\r\n"
          key, value = header.split(": ", 2)
          headers[key.downcase] = value.strip
        end
        body = headers["content-length"] ? socket.read(headers["content-length"].to_i) : nil
        request = Net::HTTP.const_get(method.capitalize).new(target)
        request["content-type"] = headers["content-type"] if headers["content-type"]
        request.body = body
        response = Net::HTTP.start(REAL_ES.host, REAL_ES.port) { _1.request(request) }
        path, query = target.split("?", 2)
        log << { "method" => method, "path" => path, "query" => query, "body" => body, "status" => response.code.to_i, "response" => response.body.to_s } if on
        socket.write("HTTP/1.1 #{response.code} X\r\nContent-Type: application/json\r\nContent-Length: #{response.body.to_s.bytesize}\r\nConnection: close\r\n\r\n#{response.body}")
        break
      end
    ensure
      socket.close
    end
  end
end
port = EsProxy.start
Object.send(:remove_const, :EsClient)
EsClient = Elasticsearch::Model.client = Elasticsearch::Client.new(host: "http://127.0.0.1:#{port}", retry_on_failure: 5, transport_options: { request: { timeout: 15 } })
[Link, Purchase, Installment, AudienceMember, ConfirmedFollowerEvent, ProductPageView].each { _1.__elasticsearch__.client = EsClient }

Link.index_name("ws65-link")
Link.__elasticsearch__.create_index!(force: true)

# --- Catalogue --------------------------------------------------------------------------------------
%w[taxonomy_attributes taxonomy_hierarchies taxonomies].each { ActiveRecord::Base.connection.execute("TRUNCATE TABLE #{_1}") }
design = Taxonomy.create!(slug: "design")
icons = Taxonomy.create!(slug: "icons", parent: design)
fonts = Taxonomy.create!(slug: "fonts", parent: design)
serif = Taxonomy.create!(slug: "serif", parent: fonts)
films = Taxonomy.create!(slug: "films")
TaxonomyAttribute.create!(taxonomy: icons, name: "format", label: "Format", value_type: "enum", values: %w[SVG PNG], position: 1, active: true)
TaxonomyAttribute.create!(taxonomy: icons, name: "animated", label: "Animated", value_type: "boolean", position: 2, active: true)
TaxonomyAttribute.create!(taxonomy: icons, name: "pixels", label: "Pixels", value_type: "number", position: 3, active: true)
TaxonomyAttribute.create!(taxonomy: icons, name: "retired", label: "Retired", value_type: "enum", values: %w[a], position: 4, active: false)

def iso(time) = time.utc.iso8601
base = {
  "description" => "", "tags" => [], "filetypes" => [], "user_id" => 1, "taxonomy_id" => nil, "sales_volume" => 0, "average_rating" => 0.0,
  "reviews_count" => 0, "creator_external_id" => "ext1", "creator_name" => "Seller", "display_product_reviews" => true, "is_physical" => false,
  "is_preorder" => false, "is_subscription" => false, "is_bundle" => false, "is_recommendable" => true, "is_alive_on_profile" => true,
  "is_call" => false, "is_alive" => true, "native_type" => "digital", "customizable_price" => false, "price_cents" => 500,
  "available_price_cents" => 500, "price_currency_type" => "usd", "rated_as_adult" => false, "total_fee_cents" => 0, "past_year_fee_cents" => 0,
  "staff_picked_at" => nil, "offer_codes" => [], "taxonomy_attribute_filters" => []
}
products = [
  { "id" => 1, "name" => "Ruby icon pack", "description" => "Hand drawn ruby icons", "tags" => %w[icons ruby design], "filetypes" => %w[svg png], "taxonomy_id" => icons.id, "sales_volume" => 9_000, "average_rating" => 4.8, "reviews_count" => 40, "total_fee_cents" => 900, "past_year_fee_cents" => 2_000, "price_cents" => 1_200, "available_price_cents" => 1_200, "created_at" => FIXED_NOW - 10.days, "content_updated_at" => FIXED_NOW - 2.days, "staff_picked_at" => FIXED_NOW - 1.day, "offer_codes" => %w[BLACKFRIDAY2025 SAVE10], "taxonomy_attribute_filters" => %w[format:svg format:png animated:false] },
  { "id" => 2, "name" => "Serif display font", "description" => "A font family", "tags" => ["fonts", "serif display", "design"], "filetypes" => %w[ttf otf], "taxonomy_id" => serif.id, "sales_volume" => 12_000, "average_rating" => 4.2, "reviews_count" => 12, "total_fee_cents" => 1_500, "past_year_fee_cents" => 6_000, "price_cents" => 2_500, "available_price_cents" => 2_000, "created_at" => FIXED_NOW - 40.days, "content_updated_at" => FIXED_NOW - 20.days },
  { "id" => 3, "name" => "Sans-serif starter", "tags" => %w[fonts sans-serif], "filetypes" => %w[ttf], "taxonomy_id" => fonts.id, "user_id" => 2, "creator_name" => "Other seller", "creator_external_id" => "ext2", "sales_volume" => 300, "average_rating" => 3.0, "reviews_count" => 3, "total_fee_cents" => 30, "past_year_fee_cents" => 300, "price_cents" => 0, "available_price_cents" => 0, "customizable_price" => true, "created_at" => FIXED_NOW - 100.days, "content_updated_at" => FIXED_NOW - 90.days },
  { "id" => 4, "name" => "Ruby on rails course", "description" => "Learn rails with ruby", "tags" => %w[ruby rails programming], "filetypes" => %w[mp4 pdf], "user_id" => 2, "creator_name" => "Other seller", "creator_external_id" => "ext2", "sales_volume" => 20_000, "average_rating" => 4.9, "reviews_count" => 300, "total_fee_cents" => 5_000, "past_year_fee_cents" => 30_000, "price_cents" => 9_900, "available_price_cents" => 9_900, "is_subscription" => true, "created_at" => FIXED_NOW - 5.days, "content_updated_at" => FIXED_NOW - 1.day },
  { "id" => 5, "name" => "Adult art book", "tags" => %w[art], "filetypes" => %w[pdf], "rated_as_adult" => true, "sales_volume" => 100, "average_rating" => 4.0, "reviews_count" => 5, "price_cents" => 1_500, "available_price_cents" => 1_500, "created_at" => FIXED_NOW - 3.days, "content_updated_at" => FIXED_NOW - 3.days },
  { "id" => 6, "name" => "Hidden draft", "tags" => %w[ruby], "is_recommendable" => false, "is_alive_on_profile" => false, "is_alive" => false, "sales_volume" => 1, "price_cents" => 100, "available_price_cents" => 100, "created_at" => FIXED_NOW - 400.days, "content_updated_at" => FIXED_NOW - 400.days },
  { "id" => 7, "name" => "Film bundle", "description" => "All the films", "tags" => %w[films bundle], "filetypes" => %w[mp4], "taxonomy_id" => films.id, "is_bundle" => true, "user_id" => 3, "creator_name" => nil, "creator_external_id" => "ext3", "sales_volume" => 5_000, "average_rating" => 0.0, "reviews_count" => 0, "display_product_reviews" => false, "total_fee_cents" => 400, "past_year_fee_cents" => 800, "price_cents" => 4_000, "available_price_cents" => 4_000, "created_at" => FIXED_NOW - 60.days, "content_updated_at" => FIXED_NOW - 59.days },
  { "id" => 8, "name" => "Consulting call", "tags" => %w[coaching], "native_type" => "call", "is_call" => true, "user_id" => 3, "creator_external_id" => "ext3", "sales_volume" => 700, "average_rating" => 5.0, "reviews_count" => 2, "price_cents" => 15_000, "available_price_cents" => 15_000, "price_currency_type" => "eur", "created_at" => FIXED_NOW - 1.day, "content_updated_at" => FIXED_NOW - 1.day, "staff_picked_at" => FIXED_NOW - 2.days },
  { "id" => 9, "name" => "Pre-order poster", "tags" => %w[art posters], "is_preorder" => true, "is_physical" => true, "sales_volume" => 20, "average_rating" => 2.5, "reviews_count" => 8, "price_cents" => 2_000, "available_price_cents" => 2_000, "created_at" => FIXED_NOW - 20.days, "content_updated_at" => FIXED_NOW - 20.days },
  { "id" => 10, "name" => "Icon pack for <b>web</b> & apps", "description" => "Tom & Jerry's icons", "tags" => %w[icons web], "taxonomy_id" => icons.id, "sales_volume" => 2_000, "average_rating" => 3.5, "reviews_count" => 20, "total_fee_cents" => 200, "past_year_fee_cents" => 1_000, "price_cents" => 700, "available_price_cents" => 700, "created_at" => FIXED_NOW - 80.days, "content_updated_at" => FIXED_NOW - 70.days, "taxonomy_attribute_filters" => %w[format:svg animated:true] },
]
products.each do |product|
  document = base.merge(product).merge("updated_at" => FIXED_NOW)
  id = document.delete("id")
  %w[created_at content_updated_at staff_picked_at updated_at].each { document[_1] = iso(document[_1]) if document[_1] }
  EsClient.index(index: Link.index_name, id:, body: document)
end
EsClient.indices.refresh(index: Link.index_name)

# --- Cases ------------------------------------------------------------------------------------------
# A param value {"$section" => [ids]} stands for a SellerProfileProductsSection showing those ids.
# "internal" params arrive as a Hash from application code; the others as ActionController::Parameters.
def build_params(spec, controller:)
  data = spec.deep_dup.transform_values { |value| value.is_a?(Hash) && value.key?("$section") ? SellerProfileProductsSection.new(shown_products: value["$section"]) : value }
  controller ? ActionController::Parameters.new(data) : data.with_indifferent_access
end

class Harness
  include SearchProducts
  public :search_products, :normalize_search_param_values!, :format_search_params!, :taxonomy_attributes_data
  def params = @params ||= ActionController::Parameters.new({})
  def offer_codes_search_feature_active?(_params) = false
end

$statements = []
ActiveSupport::Notifications.subscribe("sql.active_record") do |*, payload|
  $statements << payload[:sql] if EsProxy.on && !%w[SCHEMA TRANSACTION].include?(payload[:name].to_s)
end

def exchanges_log = EsProxy.log.map { _1.except("response").merge("response" => JSON.parse(_1["response"]).except("took")) }

# Runs the block with the proxy recording; returns the outcome (or the error) and the exchanges. The
# SQL the block ran lands in $statements.
def record
  EsProxy.log.clear
  $statements.clear
  EsProxy.on = true
  value = yield
  [value, exchanges_log]
rescue StandardError => e
  [{ "error" => { "class" => e.class.name, "message" => e.message } }, exchanges_log]
ensure
  EsProxy.on = false
end

def wire_body(options) = Elasticsearch::Client.new(host: "http://localhost:1").transport.send(:__convert_to_json, options)

search_cases = []
add = lambda do |name, params, via: :search, controller: false|
  entry = { "name" => name, "params" => params, "via" => via.to_s, "controller" => controller }
  built = build_params(params, controller:)
  outcome, exchanges = record do
    case via
    when :search then Link.search(Link.search_options(built)).response
    when :filetype then Link.search(Link.filetype_options(built)).response
    when :taxonomy_attribute then Link.search(Link.taxonomy_attribute_options(built)).response
    when :partial then Link.search(Link.partial_search_options(built)).response
    end
    {}
  end
  entry["outcome"] = outcome
  entry["exchanges"] = exchanges
  entry["sql"] = $statements.dup
  search_cases << entry
end

add.call("defaults", {})
add.call("query", { "query" => "ruby icons" })
add.call("blank query is skipped", { "query" => "   " })
add.call("query with html characters", { "query" => "tom & jerry <b>" })
add.call("user_id as integer", { "user_id" => 1 })
add.call("user_id list and strings", { "user_id" => ["1", "2", "x"] })
add.call("user_id string with profile tags", { "user_id" => "2", "is_alive_on_profile" => true })
add.call("user_id with string flag", { "user_id" => "2", "is_alive_on_profile" => "true" })
add.call("user_id with false string flag", { "user_id" => "2", "is_alive_on_profile" => "false" })
add.call("empty user_id is truthy", { "user_id" => "" })
add.call("include_rated_as_adult", { "include_rated_as_adult" => true })
add.call("include_rated_as_adult false is still truthy-checked", { "include_rated_as_adult" => false })
add.call("is_alive_on_profile nil key", { "is_alive_on_profile" => nil })
add.call("is_alive_on_profile false", { "is_alive_on_profile" => false })
add.call("ids", { "ids" => %w[1 2 4] })
add.call("empty ids", { "ids" => [] })
add.call("ids with page_layout sort", { "ids" => %w[4 1 2], "sort" => "page_layout" })
add.call("section with page_layout sort", { "section" => { "$section" => [7, 1, 3] }, "sort" => "page_layout" })
add.call("section with featured sort", { "section" => { "$section" => [7, 1] } })
add.call("ids win over section", { "ids" => %w[1], "section" => { "$section" => [7, 1] }, "sort" => "page_layout" })
add.call("page_layout without ids", { "sort" => "page_layout" })
add.call("exclude_ids", { "exclude_ids" => %w[1 2] })
add.call("taxonomy_id", { "taxonomy_id" => 4 })
add.call("taxonomy_id with descendants", { "taxonomy_id" => design.id, "include_taxonomy_descendants" => true })
add.call("taxonomy_id leaf with descendants", { "taxonomy_id" => serif.id, "include_taxonomy_descendants" => true })
add.call("unknown taxonomy with descendants", { "taxonomy_id" => 99_999, "include_taxonomy_descendants" => true })
add.call("tags list", { "tags" => ["icons", "serif display"] })
add.call("tags string", { "tags" => "icons" })
add.call("tags with hyphen", { "tags" => ["sans-serif"] })
add.call("tags with number", { "tags" => [3] })
add.call("filetypes", { "filetypes" => %w[svg png] })
add.call("filetypes string", { "filetypes" => "svg" })
add.call("taxonomy attribute filters grouped", { "taxonomy_id" => icons.id, "taxonomy_attribute_filters" => ["format:svg", "format:png", "animated:true"] })
add.call("taxonomy attribute filters need a taxonomy", { "taxonomy_attribute_filters" => ["format:svg"] })
add.call("taxonomy attribute filter without a colon", { "taxonomy_id" => icons.id, "taxonomy_attribute_filters" => ["svg"] })
add.call("min and max price", { "min_price" => "10", "max_price" => "20" })
add.call("min price only, fractional", { "min_price" => "10.5" })
add.call("max price only, fractional", { "max_price" => "10.555" })
add.call("price as integer", { "min_price" => 10, "max_price" => 20 })
add.call("price as float", { "min_price" => 10.25 })
add.call("price with exponent is ignored", { "min_price" => "1e3" })
add.call("price with leading dot", { "min_price" => ".5", "max_price" => "5." })
add.call("negative price clamps to zero", { "min_price" => "-5", "max_price" => "-1" })
add.call("plus sign price", { "min_price" => "+7" })
add.call("huge price clamps", { "min_price" => "99999999999999", "max_price" => "99999999999999999999" })
add.call("price with a long digit string is ignored", { "max_price" => "1" * 65 })
add.call("price text is ignored", { "min_price" => "abc", "max_price" => "0x10" })
add.call("blank price is skipped", { "min_price" => "", "max_price" => "" })
add.call("price zero", { "min_price" => "0", "max_price" => "0" })
add.call("price with trailing newline", { "min_price" => "5\n" })
add.call("rating", { "rating" => "4" })
add.call("rating zero still requires reviews display", { "rating" => "0" })
add.call("rating text", { "rating" => "abc" })
add.call("rating integer", { "rating" => 3 })
add.call("min_reviews_count", { "min_reviews_count" => "10" })
add.call("staff_picked", { "staff_picked" => true })
add.call("is_subscription true", { "is_subscription" => true })
add.call("is_subscription false", { "is_subscription" => false })
add.call("is_bundle", { "is_bundle" => true })
add.call("is_call nil key", { "is_call" => nil })
add.call("is_call false", { "is_call" => false })
add.call("is_alive", { "is_alive" => true })
add.call("offer_code", { "offer_code" => "SAVE10" })
add.call("search hash", { "search" => { "range" => { "price_cents" => { "gt" => 100 } } } })
add.call("search that is not a hash", { "search" => "foo" }, controller: true)
add.call("curated with ids", { "sort" => "curated", "curated_product_ids" => %w[4 1] })
add.call("curated without ids", { "sort" => "curated" })
add.call("curated ids on another sort", { "sort" => "featured", "curated_product_ids" => %w[4 1] })
add.call("top creators", { "include_top_creators" => true })
add.call("track_total_hits", { "track_total_hits" => true })
add.call("track_total_hits false", { "track_total_hits" => false })
add.call("track_total_hits number", { "track_total_hits" => 100 })
%w[featured best_sellers curated newest price_asc price_desc available_price_asc available_price_desc most_reviewed highest_rated page_layout recently_updated hot_and_new staff_picked sales_volume_asc sales_volume_desc recommendable_asc recommendable_desc bogus].each do |sort|
  add.call("sort #{sort}", { "sort" => sort })
end
add.call("sort nil key", { "sort" => nil })
add.call("size and from", { "size" => 3, "from" => 2 })
add.call("size and from as strings", { "size" => "3", "from" => "2" })
add.call("from zero", { "from" => "0" })
add.call("from one", { "from" => 1 })
add.call("negative from", { "from" => "-4" })
add.call("from past the window", { "from" => 20_000, "size" => 36 })
add.call("size zero", { "size" => 0 })
add.call("size nil key", { "size" => nil })
add.call("size past the window", { "size" => 20_000 })
add.call("size at the window", { "size" => 10_000, "from" => 5 })
add.call("from with underscores and spaces", { "from" => " 1_0 " })
add.call("from with trailing text", { "from" => "3abc" })
add.call("size float", { "size" => 2.9 })
add.call("everything", {
  "query" => "icons", "user_id" => 1, "is_alive_on_profile" => true, "include_rated_as_adult" => true, "exclude_ids" => ["9"], "taxonomy_id" => design.id,
  "include_taxonomy_descendants" => true, "tags" => %w[icons], "filetypes" => %w[svg], "min_price" => "1", "max_price" => "100", "rating" => "3", "min_reviews_count" => "1",
  "sort" => "hot_and_new", "staff_picked" => true, "is_subscription" => false, "is_bundle" => false, "is_call" => false, "is_alive" => true, "offer_code" => "SAVE10",
  "include_top_creators" => true, "track_total_hits" => true, "size" => 5, "from" => 1
})
add.call("filetype options", { "query" => "icons", "filetypes" => %w[svg], "tags" => %w[icons], "sort" => "newest", "size" => 4 }, via: :filetype)
add.call("filetype options without filters", {}, via: :filetype)
add.call("taxonomy attribute options", { "taxonomy_id" => icons.id, "taxonomy_attribute_filters" => ["format:svg"], "query" => "icon" }, via: :taxonomy_attribute)
add.call("taxonomy attribute options with descendants", { "taxonomy_id" => design.id, "include_taxonomy_descendants" => true }, via: :taxonomy_attribute)
add.call("partial search", { "query" => "ruby" }, via: :partial)
add.call("partial search with adult", { "query" => "art", "include_rated_as_adult" => true }, via: :partial)
add.call("partial search prefix", { "query" => "ic" }, via: :partial)

# --- Taxonomy descendants: the statement and answer behind include_taxonomy_descendants ------------------
descendants = {}
statements = []
subscriber = ActiveSupport::Notifications.subscribe("sql.active_record") { |*, payload| statements << payload[:sql] if payload[:sql].include?("taxonomy_hierarchies") }
[design.id, icons.id, fonts.id, serif.id, films.id].each do |id|
  statements.clear
  ids = Taxonomy.find(id).self_and_descendants.pluck(:id)
  descendants[id.to_s] = { "ids" => ids, "sql" => statements.dup }
end
ActiveSupport::Notifications.unsubscribe(subscriber)


# --- SearchProducts: search_products' aggregation handling and the param normalization -------------------
harness = Harness.new
search_products_cases = []
add_search_products = lambda do |name, params|
  built = ActionController::Parameters.new(params)
  outcome, exchanges = record do
    result = harness.search_products(built)
    {
      "total" => result[:total], "tags_data" => result[:tags_data], "filetypes_data" => result[:filetypes_data],
      "taxonomy_attributes_data" => JSON.parse(result[:taxonomy_attributes_data].to_json)
    }
  end
  search_products_cases << { "name" => name, "params" => params, "outcome" => outcome, "exchanges" => exchanges, "sql" => $statements.dup }
end
add_search_products.call("plain", {})
add_search_products.call("query and tags", { "query" => "ruby", "tags" => "ruby" })
add_search_products.call("a taxonomy with filterable attributes", { "taxonomy_id" => icons.id.to_s, "taxonomy_attribute_filters" => ["format:svg"] })
add_search_products.call("a taxonomy without attributes", { "taxonomy_id" => fonts.id.to_s })
add_search_products.call("an unknown taxonomy", { "taxonomy_id" => "99999" })
add_search_products.call("no results", { "query" => "zzzzzz" })
add_search_products.call("filetypes filter leaves the filetype facet unfiltered", { "filetypes" => "svg" })
add_search_products.call("taxonomy descendants", { "taxonomy_id" => design.id, "include_taxonomy_descendants" => true })

normalize_cases = []
$statements.clear
EsProxy.on = true
valid_tokens = TaxonomyAttribute.valid_filter_tokens.to_a.sort
EsProxy.on = false
valid_tokens_sql = $statements.dup
[
  ["tags string", { "tags" => "Ruby-On Rails, icons " }],
  ["tags hash", { "tags" => { "a" => "Foo-Bar", "b" => " Baz  Qux " } }],
  ["tags array with nested values", { "tags" => ["a", ["b", "c"], { "x" => 1 }, 3, nil, 4.5, true] }],
  ["filetypes string", { "filetypes" => " SVG , Png" }],
  ["taxonomy attribute filters string", { "taxonomy_attribute_filters" => "format:svg, animated:true , bogus:1" }],
  ["taxonomy attribute filters hash", { "taxonomy_attribute_filters" => { "0" => "format:svg", "1" => ["animated:true"], "2" => { "x" => "y" }, "3" => " format:png " } }],
  ["taxonomy attribute filters over the cap", { "taxonomy_attribute_filters" => ["format:svg"] * 3 + ["junk"] * 30 }],
  ["ids string", { "ids" => "a, b ,c" }],
  ["curated product ids string", { "curated_product_ids" => "x, y" }],
  ["curated product ids empty string", { "curated_product_ids" => "" }],
  ["curated product ids hash", { "curated_product_ids" => { "0" => "x", "1" => "y" } }],
  ["scalars from arrays", { "query" => ["a", "b"], "rating" => [4], "min_price" => [["x"]], "sort" => ["newest"], "from" => ["5"], "size" => "50", "taxonomy_id" => ["3"], "user_id" => [7], "min_reviews_count" => { "a" => 1 } }],
  ["scalars", { "query" => "x", "rating" => 4, "min_price" => "1.5", "recommended_by" => "r", "from" => "7", "size" => "100000" }],
  ["negative size", { "size" => "-5" }],
  ["blank from and size", { "from" => "", "size" => "" }],
  ["taxonomy as array", { "taxonomy" => ["a/b"] }],
  ["taxonomy as number", { "taxonomy" => 5 }],
  ["taxonomy as hash", { "taxonomy" => { "a" => "b" } }],
  ["search hash is dropped", { "search" => { "term" => { "a" => 1 } } }],
  ["search string is dropped", { "search" => "x" }],
  ["exclude ids with nested values", { "exclude_ids" => ["1", ["2"], 3] }],
].each do |name, params|
  built = ActionController::Parameters.new(params)
  result = begin
    harness.normalize_search_param_values!(built)
    built.to_unsafe_h
  rescue StandardError => e
    { "error" => { "class" => e.class.name, "message" => e.message } }
  end
  normalize_cases << { "name" => name, "params" => params, "result" => result }
end

output = {
  "index" => Link.index_name,
  "valid_filter_tokens" => valid_tokens,
  "valid_filter_tokens_sql" => valid_tokens_sql,
  "taxonomy_descendants" => descendants,
  "taxonomies" => { "design" => design.id, "icons" => icons.id, "fonts" => fonts.id, "serif" => serif.id, "films" => films.id },
  "taxonomy_attributes" => TaxonomyAttribute.order(:id).map { |a| a.attributes.slice("taxonomy_id", "name", "label", "value_type", "values", "position", "active") },
  "search_cases" => search_cases,
  "search_products_cases" => search_products_cases,
  "normalize_cases" => normalize_cases,
}
File.write(File.join(__dir__, "discover-search.golden.json"), JSON.pretty_generate(output) + "\n")
puts "wrote #{search_cases.size} search, #{search_products_cases.size} search_products, #{normalize_cases.size} normalize cases"
