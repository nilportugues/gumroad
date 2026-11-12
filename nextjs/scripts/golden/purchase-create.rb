# frozen_string_literal: true

# Produces nextjs/src/server/models/__fixtures__/purchase-create.golden.json: POST /orders for a free ($0, USD, one-time)
# product, driven through the real app (ActionDispatch::Integration::Session) against a scratch database, with every
# statement the mysql2 driver sent, every Sidekiq push and every Elasticsearch request recorded in the order Rails made them.
#
# `marker` entries are interleaved with the statements: the start and end of Order::CreateService#perform,
# Purchase::CreateService#perform, Order::ChargeService#perform and of each Purchase save (so the Node tests can replay one
# span), and `job` entries where a Sidekiq job was pushed (so the enqueue order against the writes is on record).
# Run it like fight-dispute-job.rb, with lane 24's databases:
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_test_24 TEST_DATABASE_NAME=gumroad_test_24 DISABLE_TEST_REDIS_ISOLATION=1 \
#     USE_DB_WORKER_REPLICAS=true REDIS_HOST=redis:6379/50 SIDEKIQ_REDIS_HOST=redis:6379/51 \
#     RPUSH_REDIS_HOST=redis:6379/52 RACK_ATTACK_REDIS_HOST=redis:6379/53 DISABLE_SPRING=1 \
#     bundle exec rails runner nextjs/scripts/golden/purchase-create.rb
require_relative "support/rails_cases"
require "factory_bot_rails"
include RailsCases
include FactoryBot::Syntax::Methods

FactoryBot.definition_file_paths << Rails.root.join("spec", "support", "factories")
FactoryBot.reload

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/purchase-create.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = Time.utc(2026, 1, 1)
KEEP = %w[schema_migrations ar_internal_metadata].freeze
ALL_TABLES = (ActiveRecord::Base.connection.tables - KEEP).freeze

# active_storage_attachments and _blobs reference each other, so a case cannot truncate either with the constraint on.
ActiveRecord::Base.connection.execute("SET FOREIGN_KEY_CHECKS = 0")

Rails.logger = ActiveSupport::Logger.new(nil)
ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = nil

# Anything random a request mints is a counter here, so a re-run writes the same bytes.
$random_seq = 0
SecureRandom.singleton_class.prepend(Module.new do
  def hex(n = nil)
    return super if n == 12 # RailsCases numbers jids

    $random_seq += 1
    format("%0#{(n || 16) * 2}x", $random_seq)
  end

  def uuid = format("00000000-0000-4000-8000-%012x", ($random_seq += 1))

  def random_number(n = 0)
    $random_seq += 1
    n.is_a?(Integer) && n.positive? ? $random_seq % n : $random_seq.fdiv(1_000_000)
  end

  def alphanumeric(n = 16, **) = ($random_seq += 1).to_s.rjust(n, "0")

  def urlsafe_base64(n = 16, *) = ($random_seq += 1).to_s.rjust(n, "a")
end)

module Marker
  def self.add(name, phase)
    RailsRecorder.log << { "marker" => name, "phase" => phase } if RailsRecorder.log
  end

  def self.around(klass, method, name)
    klass.prepend(Module.new do
      define_method(method) do |*args, **kwargs, &block|
        Marker.add(name, "start")
        super(*args, **kwargs, &block)
      ensure
        Marker.add(name, "end")
      end
    end)
  end
end
Marker.around(Order::CreateService, :perform, "Order::CreateService")
Marker.around(Purchase::CreateService, :perform, "Purchase::CreateService")
Marker.around(Order::ChargeService, :perform, "Order::ChargeService")

# A purchase's own saves (the commit hooks run inside them, so their statements fall in the span).
Purchase.prepend(Module.new do
  def save(*, **)
    Marker.add("Purchase#save", "start")
    super
  ensure
    Marker.add("Purchase#save", "end")
  end

  def save!(*, **)
    Marker.add("Purchase#save!", "start")
    super
  ensure
    Marker.add("Purchase#save!", "end")
  end
end)

class JobMarker
  def call(worker_class, job, *)
    RailsRecorder.log << { "job" => (job["wrapped"] || worker_class.to_s), "queue" => job["queue"] } if RailsRecorder.log
    yield
  end
end
Sidekiq.configure_client { |config| config.client_middleware { |chain| chain.add JobMarker } }

capture_elasticsearch!
capture_http!

JSON_HEADERS = {
  "Accept" => "application/json", "X-Requested-With" => "XMLHttpRequest", "Content-Type" => "application/json",
  "Referer" => "http://#{DOMAIN}/checkout"
}.freeze

def line(permalink, **extra)
  {
    uid: "uid-0", permalink:, is_multi_buy: false, is_preorder: false, is_rental: false, perceived_price_cents: 0, price_cents: 0,
    tip_cents: nil, quantity: 1, price_range: "", pay_in_installments: false, bundle_products: [], variants: [], call_start_time: "",
    discount_code: "", was_product_recommended: false, recommended_by: "", recommender_model_name: "", affiliate_id: "",
    url_parameters: "{}", referrer: "direct", is_purchasing_power_parity_discounted: false, accepts_purchasing_power_parity_discount: true,
    force_new_subscription: false, custom_fields: []
  }.merge(extra)
end

def order_body(*lines, **extra)
  {
    plugins: "", friend: "", url_parameters: "{}", locale: "en", email: "buyer@example.com", tax_country_election: "",
    is_gift: false, vat_id: "", "g-recaptcha-response": "", recaptcha_challenge_fallback: false, buyer_currency_quote: "",
    cc_zipcode_required: "false", purchase: {}, line_items: lines
  }.merge(extra)
end

# Builds the case's rows with the factories, then keeps them as the seed the Node run starts from.
def universe
  ALL_TABLES.each { ActiveRecord::Base.connection.execute("TRUNCATE TABLE #{ActiveRecord::Base.connection.quote_table_name(_1)}") }
  $random_seq = 1000
  srand(42)
  Faker::Config.random = Random.new(42)
  travel_to(SEEDED_AT) { yield }
  # bcrypt salts and the OTP secret are random per user, so the rows would differ between runs.
  User.update_all(encrypted_password: "$2a$04$seeded", otp_secret_key: "SEEDED")
  ALL_TABLES.to_h { [_1, dump_rows(_1)] }.reject { |_, rows| rows.empty? }
end

def dump_rows(table)
  c = ActiveRecord::Base.connection
  order = c.column_exists?(table, "id") ? "id" : "1"
  c.select_all("SELECT * FROM #{c.quote_table_name(table)} ORDER BY #{order}").to_a
end

def post_order(body, headers: {}, session: nil)
  session ||= ActionDispatch::Integration::Session.new(Rails.application).tap { _1.host!(DOMAIN) }
  session.post "/orders", params: body.to_json, headers: JSON_HEADERS.merge(headers)
  session
end

def case_for(name, seed:, body:, headers: {})
  $random_seq = 0
  result = capture(name, now: NOW, tables: ALL_TABLES, seed:) do
    session = post_order(body, headers:)
    raise "#{name}: #{session.response.status} #{session.response.body}" unless session.response.status == 200
  end
  result.merge("request" => body)
end

def product_universe(**product_attributes)
  universe do
    seller = create(:user, created_at: SEEDED_AT, updated_at: SEEDED_AT)
    create(:product, user: seller, unique_permalink: "freeone", price_cents: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT, **product_attributes)
    yield seller if block_given?
  end
end

cases = []
cases << case_for("signed-out buyer", seed: product_universe, body: order_body(line("freeone")))
cases << case_for("essentials only", seed: product_universe,
                                     body: { email: "buyer@example.com", cc_zipcode_required: "false", line_items: [{ uid: "uid-0", permalink: "freeone", perceived_price_cents: "0" }] })
cases << case_for("email owned by a confirmed account", seed: product_universe { create(:user, email: "owner@example.com") }, body: order_body(line("freeone"), email: "owner@example.com"))
cases << case_for("product with a file", seed: product_universe { |_| Link.find_by(unique_permalink: "freeone").product_files << create(:product_file, link: Link.find_by(unique_permalink: "freeone")) },
                                         body: order_body(line("freeone")))
cases << case_for("no refund policy", seed: product_universe { |seller| seller.update!(refund_policy_enabled: false) }, body: order_body(line("freeone")))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.iso8601(3), "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
