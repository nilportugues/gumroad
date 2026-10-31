# frozen_string_literal: true

# Produces seller-updates-worker.golden.json by running the real app/sidekiq/seller_updates_worker.rb
# and the real User::Stats scope (app/modules/user/stats.rb, loaded as-is) on activerecord 8.1.3.1
# over an in-memory SQLite database seeded with a seller the scope matches, recording every SQL
# statement and SellerUpdateWorker enqueue the job makes.
#
#   GEM_PATH=<gems with activerecord 8.1.3.1 + sqlite3>:<gems with sidekiq 7.3.4> \
#     ruby nextjs/src/worker/jobs/__fixtures__/generate-seller-updates-golden.rb
gem "activerecord", "8.1.3.1"
gem "sidekiq", "7.3.4"
gem "fugit", "1.11.1"
require "json"
require "active_record"
require "sidekiq"
require "fugit"
require "yaml"

ROOT = File.expand_path("../../../../..", __dir__)
OUT = File.join(__dir__, "seller-updates-worker.golden.json")

ActiveRecord::Base.establish_connection(adapter: "sqlite3", database: ":memory:")
ActiveRecord::Schema.verbose = false
ActiveRecord::Schema.define do
  create_table(:users) { |t| t.string :email; t.timestamps }
  create_table(:links) { |t| t.integer :user_id }
  create_table(:purchases) do |t|
    t.integer :link_id
    t.integer :price_cents
    t.string :purchase_state
    t.boolean :stripe_refunded
    t.datetime :created_at
  end
end

module Rails
  def self.root = Pathname.new(ROOT)
end
module CurrencyHelper; end
class ApplicationRecord < ActiveRecord::Base
  self.abstract_class = true
end
class User < ApplicationRecord; end
load File.join(ROOT, "app/modules/user/stats.rb")
User.include(User::Stats)
load File.join(ROOT, "app/models/concerns/recurring_lock_ttl.rb")
load File.join(ROOT, "app/sidekiq/seller_updates_worker.rb")

ENQUEUED = []
class SellerUpdateWorker
  def self.perform_async(*args) = ENQUEUED << args
end

seller = User.create!(email: "seller@example.com")
connection = ActiveRecord::Base.connection
link_id = connection.insert("INSERT INTO links (user_id) VALUES (#{seller.id})")
connection.execute(
  "INSERT INTO purchases (link_id, price_cents, purchase_state, stripe_refunded, created_at) " \
  "VALUES (#{link_id}, 500, 'successful', 0, '#{Time.now.utc.strftime('%F %T')}')"
)

queries = []
ActiveSupport::Notifications.subscribe("sql.active_record") { |*, payload| queries << payload[:sql] }
error = nil
returned = nil
begin
  returned = SellerUpdatesWorker.new.perform
rescue => e
  error = "#{e.class}: #{e.message}"
end
ActiveSupport::Notifications.unsubscribe("sql.active_record")

File.write(OUT, JSON.pretty_generate(
  "queries_during_perform" => queries,
  "enqueued" => ENQUEUED,
  "error" => error,
  "returned_class" => returned.class.name,
  # The seller above is one the scope matches when the relation is loaded without the date filter.
  "matching_sellers_when_loaded_without_date" => User.by_sales_revenue(days_ago: nil, limit: nil).to_a.map(&:id),
  # The date the relation would filter on: `days_ago.to_i.days.ago` treats a Time as a day count.
  "date_filter_year_when_loaded" => (7.days.ago.to_i.days.ago.year rescue "raises"),
) + "\n")
puts File.read(OUT)
