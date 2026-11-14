# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/expiring-credit-card-message-worker.golden.json: ExpiringCreditCardMessageWorker run by the
# real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb), on the days named by each case's `now`. The mails
# are deliver_later pushes, visible in the scratch Redis. Run it like update-taxonomy-stats-job.rb.
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/expiring-credit-card-message-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[credit_cards users subscriptions].freeze
TEST_SUBSCRIPTION_FLAG = Subscription.flag_mapping["flags"][:is_test_subscription]

Rails.logger = ActiveSupport::Logger.new(nil)
ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = Logger.new(nil)
$uuid_seq = 0
SecureRandom.singleton_class.prepend(Module.new do
  def uuid = format("00000000-0000-4000-8000-%012x", ($uuid_seq += 1))
end)

def card_row(id, month: 12, year: 2026) = { id:, expiry_month: month, expiry_year: year }

def user_row(id, card: nil, **overrides) = { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, user_risk_state: "compliant", flags: 0, confirmed_at: SEEDED_AT, credit_card_id: card, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def subscription_row(id, user:, card:, **overrides) = { id:, user_id: user, credit_card_id: card, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def run(name, seed, now: NOW)
  $uuid_seq = 0
  result = capture(name, now:, tables: TABLES, seed:, sidekiq: true, job: "ExpiringCreditCardMessageWorker", args: [], at: now.to_f) do
    ExpiringCreditCardMessageWorker.new.perform
  end
  result.delete("seed")
  result
end

cases = []
cases << run("no cards", {})
cases << run("a card expiring next month with a subscription", { credit_cards: [card_row(1)], users: [user_row(1, card: 1)], subscriptions: [subscription_row(1, user: 1, card: 1)] })
cases << run("a card expiring this month is left alone", { credit_cards: [card_row(1, month: 11)], users: [user_row(1, card: 1)], subscriptions: [subscription_row(1, user: 1, card: 1)] })
cases << run("a card expiring in two months is left alone", { credit_cards: [card_row(1, month: 1, year: 2027)], users: [user_row(1, card: 1)], subscriptions: [subscription_row(1, user: 1, card: 1)] })
cases << run("a card expiring in December of another year is left alone", { credit_cards: [card_row(1, year: 2027)], users: [user_row(1, card: 1)], subscriptions: [subscription_row(1, user: 1, card: 1)] })
cases << run("a card without users", { credit_cards: [card_row(1)] })
cases << run("a user without a subscription", { credit_cards: [card_row(1)], users: [user_row(1, card: 1)] })
cases << run("a user without an email", { credit_cards: [card_row(1)], users: [user_row(1, card: 1, email: nil)], subscriptions: [subscription_row(1, user: 1, card: 1)] })
cases << run("a user whose pending email stands in", { credit_cards: [card_row(1)], users: [user_row(1, card: 1, email: nil, unconfirmed_email: "new@example.com")], subscriptions: [subscription_row(1, user: 1, card: 1)] })
cases << run("a user with an empty pending email and a blank email", { credit_cards: [card_row(1)], users: [user_row(1, card: 1, email: "", unconfirmed_email: "")], subscriptions: [subscription_row(1, user: 1, card: 1)] })
cases << run("subscriptions that are cancelled, failed, ended or test are skipped", { credit_cards: [card_row(1)], users: [user_row(1, card: 1)], subscriptions: [subscription_row(1, user: 1, card: 1, cancelled_at: SEEDED_AT), subscription_row(2, user: 1, card: 1, failed_at: SEEDED_AT), subscription_row(3, user: 1, card: 1, ended_at: SEEDED_AT), subscription_row(4, user: 1, card: 1, flags: TEST_SUBSCRIPTION_FLAG), subscription_row(5, user: 1, card: 1)] })
cases << run("a subscription charged to another card is skipped", { credit_cards: [card_row(1), card_row(2, month: 5)], users: [user_row(1, card: 1)], subscriptions: [subscription_row(1, user: 1, card: 2), subscription_row(2, user: 1, card: 1)] })
cases << run("two users and several subscriptions", { credit_cards: [card_row(1), card_row(2)], users: [user_row(1, card: 1), user_row(2, card: 1), user_row(3, card: 2)], subscriptions: [subscription_row(1, user: 1, card: 1), subscription_row(2, user: 1, card: 1), subscription_row(3, user: 2, card: 1), subscription_row(4, user: 3, card: 2)] })
cases << run("a subscription of another user on the card is not mailed", { credit_cards: [card_row(1)], users: [user_row(1, card: 1), user_row(2)], subscriptions: [subscription_row(1, user: 2, card: 1)] })
cases << run("in December the cutoff is January of the next year", { credit_cards: [card_row(1, month: 12, year: 2026), card_row(2, month: 1, year: 2027)], users: [user_row(1, card: 1), user_row(2, card: 2)], subscriptions: [subscription_row(1, user: 1, card: 1), subscription_row(2, user: 2, card: 2)] }, now: Time.utc(2026, 12, 15, 9, 0, 0))
cases << run("on the first of the month", { credit_cards: [card_row(1)], users: [user_row(1, card: 1)], subscriptions: [subscription_row(1, user: 1, card: 1)] }, now: Time.utc(2026, 11, 1, 0, 0, 0))
cases << run("on the last second of the month", { credit_cards: [card_row(1)], users: [user_row(1, card: 1)], subscriptions: [subscription_row(1, user: 1, card: 1)] }, now: Time.utc(2026, 11, 30, 23, 59, 59))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
