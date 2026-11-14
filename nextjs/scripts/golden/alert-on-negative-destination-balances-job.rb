# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/alert-on-negative-destination-balances-job.golden.json: AlertOnNegativeDestinationBalancesJob
# run by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). The candidate scan (`candidate_pairs`,
# a keyset walk over unpaid balances grouped by seller and merchant account) reads nothing but `balances`. A scan with no candidate ends
# the run with no alert; a scan with one goes on to read the merchant account, seller and ledger of each, which Node hands back to Rails
# whole. Those cases are recorded up to `MerchantAccount.find_by`, which a marker exception stands in for. A run is checked to hold
# nothing but SELECT, SET and SHOW statements. Run it like pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/alert-on-negative-destination-balances-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[balances].freeze

Rails.logger = ActiveSupport::Logger.new(nil)
Time.zone = "UTC"

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

MerchantAccount.singleton_class.prepend(Module.new do
  def find_by(*) = raise(HandBackMarker)
end)

$balance_id = 0
def balance(user_id, holding, usd = holding, date: "2026-10-01", merchant_account_id: 7, state: "unpaid")
  { id: ($balance_id += 1), user_id:, merchant_account_id:, state:, date:, amount_cents: usd, holding_amount_cents: holding, created_at: SEEDED_AT, updated_at: SEEDED_AT }
end

def run(name, balances = [], now: NOW)
  $balance_id = 0
  rows = balances.call
  hands_back = false
  result = capture(name, now:, tables: TABLES, seed: { balances: rows }, sidekiq: true, job: "AlertOnNegativeDestinationBalancesJob", args: [], case_now: now.to_f) do
    AlertOnNegativeDestinationBalancesJob.new.perform
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  unless result["statements"].all? { |s| s["sql"].match?(/\A\s*(SELECT|SET|SHOW)\b/i) }
    raise "#{name}: a write ran before the marker"
  end
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("no balances", -> { [] })
cases << run("only positive unpaid balances", -> { [balance(1, 500), balance(2, 100)] })
cases << run("a negative balance that is already paid", -> { [balance(1, -500, state: "paid")] })
cases << run("a negative balance that is processing", -> { [balance(1, -500, state: "processing")] })
cases << run("a negative balance that is forfeited", -> { [balance(1, -500, state: "forfeited")] })
cases << run("a negative balance with no merchant account", -> { [balance(1, -500, merchant_account_id: nil)] })
cases << run("a negative destination matched by a negative USD ledger", -> { [balance(1, -500, -300)] })
cases << run("a negative destination matched by negative USD ledgers for two sellers", -> { [balance(1, -500, -300), balance(2, -900, -100, merchant_account_id: 8)] })
cases << run("a negative destination netted to nothing by a positive one", -> { [balance(1, -500, 500), balance(1, 500, 500, date: "2026-10-02")] })
cases << run("a negative destination with no USD movement", -> { [balance(1, -500, 0)] })
cases << run("a negative destination with a positive USD ledger", -> { [balance(1, -500, 400)] })
cases << run("a negative destination before the cutoff only", -> { [balance(1, -500, 400, date: "2026-10-20"), balance(1, 900, 400, date: "2026-11-02")] })
cases << run("a negative destination after the cutoff only", -> { [balance(1, -1500, 400, date: "2026-11-03"), balance(1, 900, 400, date: "2026-10-20")] })
cases << run("a negative destination on the cutoff date", -> { [balance(1, -500, 400, date: "2026-10-30")] })
cases << run("a negative destination the day after the cutoff", -> { [balance(1, -500, 400, date: "2026-10-31")] })
cases << run("a netted pair before a qualifying pair", -> { [balance(1, -500, -300), balance(2, -500, 400)] })
cases << run("a qualifying pair before a netted pair", -> { [balance(1, -500, 400), balance(2, -500, -300)] })
cases << run("two merchant accounts of one seller, the first netted", -> { [balance(1, -500, -300, merchant_account_id: 7), balance(1, -500, 400, merchant_account_id: 8)] })
cases << run("two merchant accounts of one seller, the second netted", -> { [balance(1, -500, 400, merchant_account_id: 7), balance(1, -500, -300, merchant_account_id: 8)] })
cases << run("several netted pairs", -> { (1..6).map { |user| balance(user, -100 * user, -50 * user) } })
cases << run("many positive pairs and a netted one", -> { (1..8).map { |user| balance(user, user.odd? ? 100 : -100, user.odd? ? 100 : -100) } })
cases << run("a netted pair in the cycle window only", -> { [balance(1, -500, -300, date: "2026-10-20"), balance(1, 100, 100, date: "2026-11-03")] })
cases << run("a window where the cycle nets and the whole ledger qualifies", -> { [balance(1, -500, -300, date: "2026-10-20"), balance(1, -100, 900, date: "2026-11-03")] })
cases << run("a seller with a high id and a negative balance", -> { [balance(2_000_000_000, -500, 400)] })

# next_scheduled_payout_end_date moves the cycle cutoff with the day of the week.
(0..6).each do |offset|
  now = Time.utc(2026, 11, 1 + offset, 23, 59, 59, 500_000)
  cases << run("no balances on #{now.strftime("%A")} #{now.to_date}", -> { [] }, now:)
  cases << run("a netted pair on #{now.strftime("%A")} #{now.to_date}", -> { [balance(1, -500, -300, date: "2026-10-28")] }, now:)
  cases << run("a qualifying pair on #{now.strftime("%A")} #{now.to_date}", -> { [balance(1, -500, 400, date: "2026-10-28")] }, now:)
end
cases << run("no balances at midnight on a Friday", -> { [] }, now: Time.utc(2026, 11, 6, 0, 0, 0))
cases << run("no balances on New Year's Day", -> { [] }, now: Time.utc(2027, 1, 1, 8, 0, 0))
cases << run("no balances on a leap day", -> { [] }, now: Time.utc(2028, 2, 29, 8, 0, 0))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
