# frozen_string_literal: true

# Golden vectors for nextjs/src/server/page-props/payouts/payout-schedule.ts: the real
# User::PayoutSchedule and PayoutsHelper date logic, on a stub seller whose ledger reads are canned.
#
#   RAILS_ENV=test bin/rails runner nextjs/scripts/golden/payout-schedule.rb
require "json"
require "active_support/testing/time_helpers"

Rails.application.eager_load!

class PayoutScheduleStubPayments
  def initialize(paid_today) = @paid_today = paid_today
  def where(*) = self
  def first = @paid_today ? Object.new : nil
end

class PayoutScheduleStub
  include User::PayoutSchedule
  include PayoutsHelper

  attr_reader :payout_frequency, :minimum_payout_amount_cents

  def initialize(frequency:, bank_account_type:, balances:, paid_today:, minimum:)
    @payout_frequency = frequency
    @bank_account_type = bank_account_type
    @balances = balances
    @paid_today = paid_today
    @minimum_payout_amount_cents = minimum
  end

  def active_bank_account = @bank_account_type && Struct.new(:type).new(@bank_account_type)
  def unpaid_balance_cents = @balances.sum { _1[1] }
  def unpaid_balance_cents_up_to_date(date) = @balances.select { _1[0] <= date }.sum { _1[1] }
  def payments = PayoutScheduleStubPayments.new(@paid_today)
  def current_payout_processor = PayoutProcessorType::STRIPE
end

include ActiveSupport::Testing::TimeHelpers

frequencies = %w[weekly monthly quarterly]
bank_account_types = [nil, "AchAccount", "UkBankAccount"]
# Balance offsets in days from the day the schedule is evaluated, with amounts in cents.
balance_sets = {
  "none" => [],
  "below_minimum" => [[-3, 500]],
  "settled" => [[-20, 6000], [-9, 7000]],
  "recent_only" => [[-1, 5000], [0, 6000]],
  "mixed" => [[-30, 900], [-8, 1000], [-2, 20_000], [3, 400]],
}
days = (Date.new(2026, 1, 20)..Date.new(2026, 4, 1)).to_a

cases = []
days.each do |day|
  travel_to(Time.utc(day.year, day.month, day.day, 12)) do
    frequencies.each do |frequency|
      bank_account_types.each do |bank_account_type|
        balance_sets.each do |name, offsets|
          [false, true].each do |paid_today|
            balances = offsets.map { |offset, cents| [day + offset, cents] }
            user = PayoutScheduleStub.new(frequency:, bank_account_type:, balances:, paid_today:, minimum: 1000)
            cycle = user.next_payout_cycle_date
            next_date = user.next_payout_date
            end_date = next_date && user.current_payout_end_date(user)
            ranges = next_date && !paid_today ? [nil, day - 9, day].map { user.displayable_payout_period_range(_1 && Struct.new(:payout_period_end_date).new(_1), end_date) } : nil
            cases << [day.to_s, frequency, bank_account_type, name, paid_today, cycle&.to_s, next_date&.to_s, end_date&.to_s, ranges]
          end
        end
      end
    end
  end
end

ordinals = (1..31).to_h { [_1, _1.ordinalize] }
File.write(Rails.root.join("nextjs/src/server/page-props/payouts/__fixtures__/payout-schedule.golden.json"), "#{JSON.generate({ "balanceSets" => balance_sets, "columns" => %w[today frequency bank_account_type balances paid_today cycle next end_date ranges], "cases" => cases, "ordinals" => ordinals })}\n")
