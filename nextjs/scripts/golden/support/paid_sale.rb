# frozen_string_literal: true

# Shared by the golden generators for the post-charge half of a paid purchase (purchase-seller-balance.rb,
# processor-payment-intent.rb, ...): the lane's Rails booted with the factories, a random source that counts, Sidekiq pushes
# recorded as `job` entries, and `sale`, which seeds a $5 purchase (built without validation, since the purchase factories
# charge a card) held by Gumroad's Stripe account or a seller's own.

require_relative "rails_cases"
require "factory_bot_rails"
include RailsCases
include FactoryBot::Syntax::Methods

FactoryBot.definition_file_paths << Rails.root.join("spec", "support", "factories")
FactoryBot.reload

NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = Time.utc(2026, 11, 4, 9, 0, 0)
KEEP = %w[schema_migrations ar_internal_metadata].freeze
ALL_TABLES = (ActiveRecord::Base.connection.tables - KEEP).freeze

ActiveRecord::Base.connection.execute("SET FOREIGN_KEY_CHECKS = 0")
Rails.logger = ActiveSupport::Logger.new(nil)
ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = nil

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

class JobMarker
  def call(worker_class, job, *)
    RailsRecorder.log << { "job" => (job["wrapped"] || worker_class.to_s), "queue" => job["queue"], "args" => job["args"], "at" => job["at"] } if RailsRecorder.log
    yield
  end
end
Sidekiq.configure_client { |config| config.client_middleware { |chain| chain.add JobMarker } }

# Every Flipper read, in the order it happened (the flags themselves live in the lane's scratch Redis).
module FlipperRecorder
  def active?(feature_name, actor = nil)
    result = super
    RailsRecorder.log << { "flipper" => feature_name.to_s, "actor" => actor && "#{actor.class.name};#{actor.id}", "result" => result } if RailsRecorder.log
    result
  end
end
Feature.singleton_class.prepend(FlipperRecorder)

capture_elasticsearch!
capture_http!

def dump_rows(table)
  c = ActiveRecord::Base.connection
  order = c.column_exists?(table, "id") ? "id" : "1"
  c.select_all("SELECT * FROM #{c.quote_table_name(table)} ORDER BY #{order}").to_a
end

def marker(name, phase) = (RailsRecorder.log << { "marker" => name, "phase" => phase } if RailsRecorder.log)

# Truncating every table per case takes a minute; only the tables the last case left rows in need it.
$dirty = ALL_TABLES.dup

def universe
  $dirty.each { ActiveRecord::Base.connection.execute("TRUNCATE TABLE #{ActiveRecord::Base.connection.quote_table_name(_1)}") }
  $random_seq = 1000
  srand(42)
  Faker::Config.random = Random.new(42)
  travel_to(SEEDED_AT) { yield }
  User.update_all(encrypted_password: "$2a$04$seeded", otp_secret_key: "SEEDED")
  rows = ALL_TABLES.to_h { [_1, dump_rows(_1)] }.reject { |_, table_rows| table_rows.empty? }
  $dirty = rows.keys | %w[balances balance_transactions versions]
  rows
end

# Seeds a $5 purchase sold by a seller, held by Gumroad's Stripe account unless `account:` says otherwise (:gumroad,
# :seller_connect or :none), and yields (purchase, seller, merchant_account) to add rows. Returns the seed as table => rows.
def sale(account: :gumroad, price_cents: 500, fee_cents: 145, succeeded_at: SEEDED_AT, managed_currency: "usd", **purchase_attributes)
  universe do
    seller = create(:user, created_at: SEEDED_AT, updated_at: SEEDED_AT)
    product = create(:product, user: seller, unique_permalink: "paid", price_cents:, created_at: SEEDED_AT, updated_at: SEEDED_AT)
    merchant_account =
      case account
      when :gumroad then MerchantAccount.create!(charge_processor_id: "stripe", charge_processor_merchant_id: "acct_platform", charge_processor_alive_at: SEEDED_AT)
      when :seller_managed
        # A Stripe account Gumroad manages for the seller (holder_of_funds "stripe"): it has a user but is not a Connect account.
        MerchantAccount.create!(user: seller, charge_processor_id: "stripe", charge_processor_merchant_id: "acct_managed", charge_processor_alive_at: SEEDED_AT,
                                country: "US", currency: managed_currency)
      when :seller_connect
        MerchantAccount.create!(user: seller, charge_processor_id: "stripe", charge_processor_merchant_id: "acct_seller", charge_processor_alive_at: SEEDED_AT,
                                json_data: { "meta" => { "stripe_connect" => "true" } }, country: "US", currency: "usd")
      end
    purchase = build(:purchase, link: product, seller:, price_cents:, fee_cents:, total_transaction_cents: price_cents, displayed_price_cents: price_cents,
                                purchase_state: "in_progress", succeeded_at:, merchant_account:, charge_processor_id: "stripe",
                                created_at: SEEDED_AT, updated_at: SEEDED_AT, **purchase_attributes)
    purchase.save!(validate: false)
    yield purchase, seller, merchant_account if block_given?
  end
end

def flow(issued: ["usd", 500], settled: ["usd", 500], gumroad: ["usd", 500])
  FlowOfFunds.new(issued_amount: FlowOfFunds::Amount.new(currency: issued[0], cents: issued[1]),
                  settled_amount: FlowOfFunds::Amount.new(currency: settled[0], cents: settled[1]),
                  gumroad_amount: FlowOfFunds::Amount.new(currency: gumroad[0], cents: gumroad[1]))
end

def unpaid_balance(seller, merchant_account, date:, amount_cents: 1000, **attributes)
  Balance.create!(user: seller, merchant_account:, date:, currency: "usd", holding_currency: "usd", amount_cents:, holding_amount_cents: amount_cents, **attributes)
end
