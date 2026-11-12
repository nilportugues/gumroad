# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/cancel-subscriptions-for-product-worker.golden.json: CancelSubscriptionsForProductWorker
# run by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). The mail is a deliver_later push,
# visible in the scratch Redis. An active subscription runs the real Subscription#cancel_effective_immediately! against the seeded
# rows, with outbound HTTP answered by WebMock and recorded under `http`; Node hands those cases back after reading the
# subscriptions. Run it like seller-update-worker.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases
capture_http!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/cancel-subscriptions-for-product-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
FUTURE = "2026-12-01 00:00:00"
PAST = "2026-10-01 00:00:00"
TABLES = %w[links subscriptions versions].freeze
TEST_SUBSCRIPTION = Subscription.flag_mapping["flags"][:is_test_subscription]

Rails.logger = ActiveSupport::Logger.new(nil)
Stripe.api_base = "http://127.0.0.1:9"
Stripe.max_network_retries = 0
ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = Logger.new(nil)
$uuid_seq = 0
SecureRandom.singleton_class.prepend(Module.new do
  def uuid = format("00000000-0000-4000-8000-%012x", ($uuid_seq += 1))
end)

def link_row(id, **overrides) = { id:, user_id: 1, name: "Product #{id}", unique_permalink: "p#{id}", deleted_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
def sub_row(id, link: 1, **overrides) = { id:, link_id: link, user_id: 2, seller_id: 1, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def run(name, seed, args = [1])
  $uuid_seq = 0
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "CancelSubscriptionsForProductWorker", args:, at: NOW.to_f) do
    CancelSubscriptionsForProductWorker.new.perform(*args)
  end
  result.delete("seed")
  result
end

cases = []
cases << run("a product that does not exist", {}, [99])
cases << run("a product id of nil", { links: [link_row(1)] }, [nil])
cases << run("a product whose deletion was undone", { links: [link_row(1, deleted_at: nil)], subscriptions: [sub_row(1)] })
cases << run("a deleted product with no subscriptions", { links: [link_row(1)] })
cases << run("a deleted product given as a digit string", { links: [link_row(1)] }, ["1"])
cases << run("a deleted product with only test subscriptions", { links: [link_row(1)], subscriptions: [sub_row(1, flags: TEST_SUBSCRIPTION)] })
cases << run("a deleted product with only failed subscriptions", { links: [link_row(1)], subscriptions: [sub_row(1, failed_at: PAST)] })
cases << run("a deleted product with only ended subscriptions", { links: [link_row(1)], subscriptions: [sub_row(1, ended_at: PAST)] })
cases << run("a deleted product with only subscriptions cancelled in the past", { links: [link_row(1)], subscriptions: [sub_row(1, cancelled_at: PAST)] })
cases << run("a deleted product with a subscription cancelled right now", { links: [link_row(1)], subscriptions: [sub_row(1, cancelled_at: NOW.strftime("%Y-%m-%d %H:%M:%S.%6N"))] })
cases << run("subscriptions of another product", { links: [link_row(1), link_row(2)], subscriptions: [sub_row(1, link: 2)] })
cases << run("a deleted product with an active subscription", { links: [link_row(1)], subscriptions: [sub_row(1)] })
cases << run("a deleted product with a subscription cancelled in the future", { links: [link_row(1)], subscriptions: [sub_row(1, cancelled_at: FUTURE)] })
cases << run("a deleted product with a test and an active subscription", { links: [link_row(1)], subscriptions: [sub_row(1, flags: TEST_SUBSCRIPTION), sub_row(2)] })
cases << run("a deleted product with two active subscriptions", { links: [link_row(1)], subscriptions: [sub_row(2), sub_row(1)] })
cases << run("a product id given as a float", { links: [link_row(1)] }, [1.0])
cases << run("a product id given as a word", { links: [link_row(1)] }, ["abc"])

File.write(OUT, JSON.pretty_generate({ "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
