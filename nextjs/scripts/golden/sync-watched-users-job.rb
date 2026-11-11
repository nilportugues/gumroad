# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/sync-watched-users-job.golden.json: SyncWatchedUsersJob run by the real app against a
# scratch database as a Sidekiq job (support/sidekiq_executor.rb), Elasticsearch captured (EsCapture) and answered with the case's
# `es_bodies` in order (a seller search then an affiliate search per watched user). ErrorNotifier.notify is recorded under `errors`.
# Run it like update-taxonomy-stats-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases
capture_elasticsearch!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/sync-watched-users-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[watched_users users balances].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

$errors = []
ErrorNotifier.singleton_class.prepend(Module.new do
  def notify(*args, **kwargs, &block)
    $errors << [args.map { _1.respond_to?(:message) ? _1.message : _1.to_s }, kwargs.transform_values(&:to_s)]
    nil
  end
end)

SELLER_AGGS = %w[price_cents fee_cents amount_refunded_cents fee_refunded_cents affiliate_credit_amount_cents affiliate_credit_amount_partially_refunded_cents direct_affiliate_credit_amount_cents direct_affiliate_credit_amount_partially_refunded_cents].freeze

def user_row(id, **overrides) = { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, user_risk_state: "compliant", flags: 0, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def watched_row(id, user_id, **overrides) = { id:, user_id:, revenue_threshold_cents: 100_000, revenue_cents: 0, unpaid_balance_cents: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def balance_row(id, user_id, cents, state: "unpaid") = { id:, user_id:, state:, amount_cents: cents, currency: "usd", date: "2026-11-01", created_at: SEEDED_AT, updated_at: SEEDED_AT }

# What the purchases index answers for the seller search: the eight sums, `values` overriding by name.
def seller_answer(**values) = { "aggregations" => SELLER_AGGS.to_h { |name| ["#{name}_total", { "value" => values.fetch(name.to_sym, 0) }] } }

# And for the affiliate search: the credits the user earned as an affiliate.
def affiliate_answer(amount: 0, partially_refunded: 0)
  measures = { "amount_cents" => amount, "fee_cents" => 0, "amount_partially_refunded_cents" => partially_refunded, "fee_partially_refunded_cents" => 0 }
  { "aggregations" => %w[affiliate_credit direct_affiliate_credit].flat_map { |prefix| measures.map { |measure, value| ["#{prefix}_#{measure}_own", { "total" => { "value" => prefix == "affiliate_credit" ? value : 0 } }] } }.to_h }
end

def run(name, seed, es_bodies = [])
  $errors = []
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "SyncWatchedUsersJob", args: [], es_bodies:) do
    SyncWatchedUsersJob.new.perform
  end
  result.delete("seed")
  result["errors"] = $errors.dup
  result
end

cases = []
cases << run("no watched users", {})
cases << run("a watched user", { users: [user_row(1)], watched_users: [watched_row(1, 1)], balances: [balance_row(1, 1, 1250), balance_row(2, 1, 750), balance_row(3, 1, 9999, state: "paid")] },
             [seller_answer(price_cents: 10_000, fee_cents: 1_000), affiliate_answer])
cases << run("a watched user with no balances", { users: [user_row(1)], watched_users: [watched_row(1, 1)] }, [seller_answer(price_cents: 500), affiliate_answer])
cases << run("revenue as an affiliate counts", { users: [user_row(1)], watched_users: [watched_row(1, 1)] },
             [seller_answer(price_cents: 10_000, fee_cents: 1_000, amount_refunded_cents: 200, fee_refunded_cents: 20), affiliate_answer(amount: 3_000, partially_refunded: 500)])
cases << run("every seller sum", { users: [user_row(1)], watched_users: [watched_row(1, 1)] },
             [seller_answer(price_cents: 10_000, fee_cents: 1_000, amount_refunded_cents: 200, fee_refunded_cents: 20, affiliate_credit_amount_cents: 300, affiliate_credit_amount_partially_refunded_cents: 30,
                            direct_affiliate_credit_amount_cents: 400, direct_affiliate_credit_amount_partially_refunded_cents: 40), affiliate_answer])
cases << run("fractional sums are truncated", { users: [user_row(1)], watched_users: [watched_row(1, 1)] }, [seller_answer(price_cents: 1000.75, fee_cents: 100.5), affiliate_answer(amount: 10.9)])
cases << run("a negative total", { users: [user_row(1)], watched_users: [watched_row(1, 1)] }, [seller_answer(fee_cents: 500), affiliate_answer])
cases << run("an unchanged row keeps its timestamp except last_synced_at", { users: [user_row(1)], watched_users: [watched_row(1, 1, revenue_cents: 500, unpaid_balance_cents: 0, last_synced_at: "2026-11-04 12:30:45")] }, [seller_answer(price_cents: 500), affiliate_answer])
cases << run("a deleted watched user is skipped", { users: [user_row(1), user_row(2)], watched_users: [watched_row(1, 1, deleted_at: SEEDED_AT), watched_row(2, 2)] }, [seller_answer(price_cents: 100), affiliate_answer])
cases << run("only deleted watched users", { users: [user_row(1)], watched_users: [watched_row(1, 1, deleted_at: SEEDED_AT)] })
cases << run("three watched users", { users: [user_row(1), user_row(2), user_row(3)], watched_users: [watched_row(3, 3), watched_row(1, 1), watched_row(2, 2)], balances: [balance_row(1, 2, 400)] },
             [seller_answer(price_cents: 1), affiliate_answer, seller_answer(price_cents: 2), affiliate_answer, seller_answer(price_cents: 3), affiliate_answer])
cases << run("two watched users for one user", { users: [user_row(1)], watched_users: [watched_row(1, 1), watched_row(2, 1)] }, [seller_answer(price_cents: 5), affiliate_answer, seller_answer(price_cents: 5), affiliate_answer])
cases << run("a watched user whose user is gone", { watched_users: [watched_row(1, 99)] })
cases << run("a gone user does not stop the next watched user", { users: [user_row(2)], watched_users: [watched_row(1, 99), watched_row(2, 2)] }, [seller_answer(price_cents: 7), affiliate_answer])
cases << run("a zero revenue threshold", { users: [user_row(1)], watched_users: [watched_row(1, 1, revenue_threshold_cents: 0)] }, [seller_answer(price_cents: 5), affiliate_answer])
cases << run("a negative revenue threshold does not stop the next one", { users: [user_row(1), user_row(2)], watched_users: [watched_row(1, 1, revenue_threshold_cents: -5), watched_row(2, 2)] },
             [seller_answer(price_cents: 5), affiliate_answer, seller_answer(price_cents: 6), affiliate_answer])
cases << run("an answer without the seller aggregations", { users: [user_row(1)], watched_users: [watched_row(1, 1)] }, [{}])
cases << run("an answer missing one seller sum", { users: [user_row(1)], watched_users: [watched_row(1, 1)] }, [{ "aggregations" => seller_answer["aggregations"].reject { |k, _| k == "fee_cents_total" } }])
cases << run("an answer without the affiliate aggregations", { users: [user_row(1)], watched_users: [watched_row(1, 1)] }, [seller_answer(price_cents: 5), {}])
cases << run("a failed sync does not stop the next watched user", { users: [user_row(1), user_row(2)], watched_users: [watched_row(1, 1), watched_row(2, 2)] },
             [{}, seller_answer(price_cents: 9), affiliate_answer])
cases << run("a stored revenue is overwritten", { users: [user_row(1)], watched_users: [watched_row(1, 1, revenue_cents: 99_999, unpaid_balance_cents: 55_555)] }, [seller_answer(price_cents: 100), affiliate_answer])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
