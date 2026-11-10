# frozen_string_literal: true

require "spec_helper"

# Signed-in visits to the Payouts page, recorded for the Next.js port (PARITY_RECORD=1) through the full Rack
# stack after a real login. Replayed by nextjs/parity/__tests__/checkout-payouts.replay.test.ts, which sends the
# last request of each example.
#
# Run with TZ=UTC: the payout schedule reads Date.today. Dates of past payouts are whole days from the day of
# the request (the replay moves the recorded strings by the days since); the dates of the upcoming payout depend
# on the weekday, so the replay leaves them out and nextjs/scripts/golden/payout-schedule.rb pins them.
describe "Payouts page when signed in", type: :request do
  include Parity::SignedInDashboard

  let(:seller) { create(:user, name: "Payouts Seller", username: "payoutsseller") }
  let(:product) { create(:product, user: seller, name: "Payout product") }

  # The Gumroad-held Stripe account the balance factory books to.
  before { create(:merchant_account, user: nil) }

  def sale(price: 1000, fee: 100, **columns)
    create(:free_purchase, link: product).tap do |purchase|
      purchase.update_columns(price_cents: price, fee_cents: fee, total_transaction_cents: price, displayed_price_cents: price, **columns)
    end
  end

  def balance(amount_cents: 1000, days_ago: 20, **attributes)
    create(:balance, user: seller, amount_cents:, date: Date.current - days_ago, **attributes)
  end

  def completed_payment(days_ago:, amount_cents: 5000, bank_account: nil, **attributes)
    create(
      :payment_completed,
      user: seller, amount_cents:, processor: PayoutProcessorType::STRIPE, currency: Currency::USD, bank_account:,
      stripe_transfer_id: "tr_payout_#{days_ago}", stripe_connect_account_id: "acct_payout_#{days_ago}",
      created_at: days_ago.days.ago, payout_period_end_date: Date.current - days_ago - 3, **attributes
    )
  end

  def visit_payouts(**params)
    log_in(seller)
    get balance_path(params)
  end

  def props = inertia_props_of(response)

  describe "the upcoming payout" do
    it "reports an empty balance as not payable", parity: true do
      visit_payouts

      expect(response).to be_successful
      expect(props["next_payout_period_data"]).to include("status" => "not_payable", "balance_cents" => 0, "is_user_payable" => false)
      expect(props["past_payout_period_data"]).to eq([])
    end

    it "reports a balance below the minimum as not payable", parity: true do
      balance(amount_cents: 500)

      visit_payouts

      expect(props["next_payout_period_data"]).to include("status" => "not_payable", "balance_cents" => 500)
    end

    it "breaks down the sales, refunds, chargebacks, credits and affiliate fees of the period", parity: true do
      create(:ach_account, user: seller)
      settled = balance(amount_cents: 9000, days_ago: 20)
      recent = balance(amount_cents: 4000, days_ago: 1)
      first_sale = sale(price: 5000, fee: 500, purchase_success_balance_id: settled.id)
      sale(price: 3000, fee: 300, tax_cents: 150, purchase_success_balance_id: settled.id, flags: Purchase.flag_mapping["flags"][:was_discover_fee_charged])
      refunded = sale(price: 2000, fee: 200, affiliate_credit_cents: 100, purchase_success_balance_id: recent.id, purchase_refund_balance_id: settled.id, stripe_partially_refunded: true)
      create(:refund, purchase: refunded, amount_cents: 500, fee_cents: 50, seller_id: seller.id)
      charged_back = sale(price: 1500, fee: 150, purchase_success_balance_id: recent.id, purchase_chargeback_balance_id: settled.id, chargeback_date: 3.days.ago)
      create(:credit, user: seller, balance: settled, amount_cents: 250, crediting_user: seller)
      first_sale.update_columns(affiliate_credit_cents: 400)
      charged_back.touch

      visit_payouts

      expect(response).to be_successful
      expect(props["next_payout_period_data"]).to include("is_user_payable" => true, "status" => "payable", "type" => "standard", "payout_method_type" => "bank")
    end

    it "includes the PayPal sales of the period", parity: true do
      seller.update!(payment_address: "seller-paypal@example.com")
      balance(amount_cents: 12_000, days_ago: 30)
      sale(price: 4000, fee: 400, charge_processor_id: "paypal", succeeded_at: 5.days.ago)
      refunded = sale(price: 2000, fee: 200, charge_processor_id: "paypal", succeeded_at: 6.days.ago)
      create(:refund, purchase: refunded, amount_cents: 2000, fee_cents: 200, seller_id: seller.id)

      visit_payouts

      expect(props["next_payout_period_data"]).to include("payout_method_type" => "paypal", "paypal_address" => "seller-paypal@example.com")
    end

    it "pays a UK bank account on its own weekday", parity: true do
      create(:uk_bank_account, user: seller)
      balance(amount_cents: 20_000, days_ago: 15)

      visit_payouts

      expect(props["next_payout_period_data"]).to include("payout_method_type" => "bank", "payout_currency" => "gbp")
    end

    it "shows a monthly payout schedule", parity: true do
      seller.update!(payout_frequency: "monthly")
      create(:ach_account, user: seller)
      balance(amount_cents: 30_000, days_ago: 40)

      visit_payouts

      expect(response).to be_successful
    end

    it "marks the period paused while payouts are paused", parity: true do
      seller.update!(payouts_paused_internally: true)
      create(:ach_account, user: seller)
      balance(amount_cents: 30_000, days_ago: 40)

      visit_payouts

      expect(props).to include("payouts_status" => "paused", "payouts_paused_by" => "admin")
    end

    it "shows a seller-visible payout note and hides an internal one", parity: true do
      create(:ach_account, user: seller)
      balance(amount_cents: 600, days_ago: 10)
      seller.add_payout_note(content: "Internal bank sync problem", seller_visible: false)
      seller.add_payout_note(content: "Your payout on July 3, 2025 was skipped because your balance of $6 was below the $10 minimum.")

      visit_payouts

      expect(props["next_payout_period_data"]).to include("skipped_payout_date" => "July 3, 2025")
    end

    it "keeps a payout note when the balance clears the minimum", parity: true do
      create(:ach_account, user: seller)
      balance(amount_cents: 20_000, days_ago: 10)
      seller.add_payout_note(content: "Payout via Stripe is waiting on your bank details.")

      visit_payouts

      expect(props["next_payout_period_data"]["payout_note"]).to eq("Payout is waiting on your bank details.")
    end

    it "hides the legacy under-review note of a seller that was never reviewed", parity: true do
      balance(amount_cents: 600, days_ago: 10)
      seller.add_payout_note(content: "Payout on June 5, 2025 was skipped because the account was under review.")

      visit_payouts

      expect(props["next_payout_period_data"]["payout_note"]).to be_nil
    end

    it "does not offer the upcoming payout while a standard payout is processing", parity: true do
      create(:ach_account, user: seller)
      create(:payment, user: seller, state: "processing", processor: PayoutProcessorType::STRIPE, currency: Currency::USD, created_at: 2.days.ago, payout_period_end_date: Date.current - 5)
      balance(amount_cents: 20_000, days_ago: 1)

      visit_payouts

      expect(props["next_payout_period_data"]).to be_nil
      expect(props["processing_payout_periods_data"].size).to eq(1)
    end
  end

  describe "past payouts" do
    let(:bank) { create(:ach_account, user: seller) }

    before do
      (1..7).each do |index|
        paid_balance = create(:balance, user: seller, amount_cents: 1000 * index, date: Date.current - (index * 7) - 4, state: "paid")
        sale(price: 1000 * index, fee: 100 * index, purchase_success_balance_id: paid_balance.id)
        payment = completed_payment(days_ago: index * 7, amount_cents: 900 * index, bank_account: bank)
        payment.balances << paid_balance
      end
    end

    it "lists the newest payouts with a pagination footer", parity: true do
      visit_payouts

      expect(props["past_payout_period_data"].size).to eq(3)
      expect(props["pagination"]).to eq("pages" => 3, "page" => 1)
    end

    it "shows a later page", parity: true do
      visit_payouts(page: 2)

      expect(props["pagination"]).to eq("pages" => 3, "page" => 2)
    end

    it "clamps a page past the last one", parity: true do
      visit_payouts(page: 99)

      expect(props["pagination"]).to eq("pages" => 3, "page" => 3)
    end

    it "treats page zero as the first page", parity: true do
      visit_payouts(page: 0)

      expect(props["pagination"]).to eq("pages" => 3, "page" => 1)
    end

    it "adds the Gumroad fee kept by an instant payout and its arrival date", parity: true do
      payment = completed_payment(days_ago: 1, amount_cents: 7000, bank_account: bank)
      payment.update!(payout_type: Payouts::PAYOUT_TYPE_INSTANT, gumroad_fee_cents: 70, arrival_date: Time.utc(2030, 1, 2).to_i)

      visit_payouts

      expect(props["past_payout_period_data"].first).to include("type" => "instant", "fees_cents" => 70)
    end

    it "serves a partial reload of the next page as JSON", parity: true do
      log_in(seller)

      get balance_path(page: 2), headers: {
        "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "X-Inertia-Partial-Component" => "Payouts/Index",
        "X-Inertia-Partial-Data" => "past_payout_period_data,pagination"
      }

      expect(response).to be_successful
      expect(response.parsed_body["mergeProps"]).to eq(["past_payout_period_data"])
    end

    it "labels a payout sent to PayPal", parity: true do
      create(:payment_completed, user: seller, amount_cents: 1200, processor: PayoutProcessorType::PAYPAL, payment_address: "old-paypal@example.com", currency: Currency::USD, created_at: 3.days.ago, payout_period_end_date: Date.current - 6)

      visit_payouts

      expect(props["past_payout_period_data"].first).to include("payout_method_type" => "paypal")
    end

    it "labels a payout from before payout methods were recorded", parity: true do
      create(:payment_completed, user: seller, amount_cents: 1200, processor: PayoutProcessorType::PAYPAL, payment_address: nil, currency: Currency::USD, created_at: 3.days.ago, payout_period_end_date: Date.current - 6)

      visit_payouts

      expect(props["past_payout_period_data"].first).to include("payout_method_type" => "legacy-na")
    end
  end

  describe "the chargeback-rate payout reserve" do
    def hold_for_chargeback_rate!
      seller.update!(payouts_paused_internally: true, payouts_paused_by: User::PAYOUT_PAUSE_SOURCE_SYSTEM)
      seller.comments.create!(
        content: "Payouts automatically paused due to chargeback rate.",
        comment_type: Comment::COMMENT_TYPE_ON_PROBATION,
        author_name: User::SYSTEM_PAYOUT_PAUSE_COMMENT_AUTHORS[:high_chargeback_rate]
      )
    end

    it "pays the whole rows that fit under 75 percent and reports the reserve", parity: true do
      create(:ach_account, user: seller)
      4.times { |i| balance(amount_cents: 100_00, days_ago: 20 - i) }
      hold_for_chargeback_rate!

      visit_payouts

      expect(props).to include("payout_reserve_percent" => 25, "payouts_status" => "paused")
      expect(props["next_payout_period_data"]).to include("payout_cents" => 300_00, "payout_reserve_cents" => 100_00, "payout_waiting_cents" => 0, "payout_reserve_percent" => 25)
    end

    it "puts the whole-row leftover on the waiting line", parity: true do
      create(:ach_account, user: seller)
      3.times { |i| balance(amount_cents: 100_00, days_ago: 20 - i) }
      hold_for_chargeback_rate!

      visit_payouts

      expect(props["next_payout_period_data"]).to include("payout_cents" => 200_00, "payout_reserve_cents" => 75_00, "payout_waiting_cents" => 25_00)
    end

    it "pays nothing when the fitting rows are below the minimum", parity: true do
      create(:ach_account, user: seller)
      balance(amount_cents: 60_00, days_ago: 20)
      balance(amount_cents: 70_00, days_ago: 19)
      hold_for_chargeback_rate!

      visit_payouts

      expect(props["next_payout_period_data"]).to include("payout_cents" => 0, "payout_reserve_cents" => 32_50, "payout_waiting_cents" => 97_50)
    end

    it "anchors the reserve on what was already paid under the hold", parity: true do
      create(:ach_account, user: seller)
      hold_for_chargeback_rate!
      paid = balance(amount_cents: 75_00, days_ago: 30)
      paid.mark_processing!
      paid.mark_paid!
      create(:payment_completed, user: seller, amount_cents: 75_00, created_at: 1.minute.from_now).balances << paid
      balance(amount_cents: 25_00, days_ago: 20)
      balance(amount_cents: 80_00, days_ago: 19)

      visit_payouts

      expect(props["next_payout_period_data"]).to include("payout_reserve_cents" => 45_00)
    end
  end

  describe "other sections" do
    it "enables the tax center link for a seller in the United States", parity: true do
      create(:user_compliance_info, user: seller)

      visit_payouts

      expect(props["tax_center_enabled"]).to eq(true)
    end

    it "shows the scheduled payout of a suspended seller", parity: true do
      create(:scheduled_payout, user: seller, status: "pending", payout_amount_cents: 12_345, scheduled_at: 3.days.from_now)
      seller.update_columns(user_risk_state: "suspended_for_fraud")

      visit_payouts

      expect(props["scheduled_payout"]).to include("status" => "pending", "payout_amount_cents" => 12_345)
    end
  end

  describe "a seller whose balance stats are cached" do
    before do
      $redis.set(RedisKey.balance_stats_sales_caching_threshold, 1)
      LargeSeller.create!(user: seller, sales_count: 1)
      create(:ach_account, user: seller)
      balance(amount_cents: 12_000)
    end

    it "computes the periods live and queues the cache refresh while no blob exists", parity: true do
      visit_payouts

      expect(response).to be_successful
      expect(props["next_payout_period_data"]).to include("status" => "payable", "payout_cents" => 12_000)
      expect(UpdateUserBalanceStatsCacheWorker.jobs.map { _1["args"] }).to eq([[seller.id]])
    end

    it "computes the periods live and queues nothing for a seller excluded from caching", parity: true do
      $redis.sadd(RedisKey.balance_stats_users_excluded_from_caching, seller.id)

      visit_payouts

      expect(props["next_payout_period_data"]).to include("status" => "payable", "payout_cents" => 12_000)
      expect(UpdateUserBalanceStatsCacheWorker.jobs).to be_empty
    end

    describe "with a cached blob" do
      let(:blob_key) { "balance_stats_for_user_#{seller.id}_v2" }

      it "serves the next period from the blob, not from the ledger, and queues the refresh", parity: true do
        UserBalanceStatsService.new(user: seller).write_cache
        balance(amount_cents: 3_000, days_ago: 21)

        visit_payouts

        expect(response).to be_successful
        expect(props["next_payout_period_data"]).to include("status" => "payable", "payout_cents" => 12_000, "stripe_connect_routing_active" => false)
        expect(UpdateUserBalanceStatsCacheWorker.jobs.map { _1["args"] }).to eq([[seller.id]])
      end

      it "serves a processing payout from the blob and no next period", parity: true do
        payment = create(
          :payment, user: seller, amount_cents: 4_000, processor: PayoutProcessorType::STRIPE, currency: Currency::USD,
                    bank_account: seller.active_bank_account, stripe_transfer_id: "tr_cached", stripe_connect_account_id: "acct_cached",
                    created_at: 1.day.ago, payout_period_end_date: Date.current - 10
        )
        UserBalanceStatsService.new(user: seller).write_cache
        payment.update_columns(amount_cents: 4_500)

        visit_payouts

        expect(props["next_payout_period_data"]).to be_nil
        expect(props["processing_payout_periods_data"].map { _1["payout_cents"] }).to eq([4_000])
      end

      it "computes the periods live when the blob cannot be parsed", parity: true do
        $redis.set(blob_key, "{not json")

        visit_payouts

        expect(props["next_payout_period_data"]).to include("status" => "payable", "payout_cents" => 12_000)
        expect(UpdateUserBalanceStatsCacheWorker.jobs.map { _1["args"] }).to eq([[seller.id]])
      end
    end
  end

  describe "team members" do
    %w[accountant admin support].each do |role|
      it "lets #{role} see the payouts", parity: true do
        member = create(:user, name: "Team #{role}")
        membership = create(:team_membership, user: member, seller:, role:)
        log_in(member)
        switch_to(membership)

        get balance_path

        expect(response).to be_successful
      end
    end

    it "sends marketing to the dashboard", parity: true do
      member = create(:user, name: "Team marketing")
      membership = create(:team_membership, user: member, seller:, role: "marketing")
      log_in(member)
      switch_to(membership)

      get balance_path

      expect(response).to redirect_to(dashboard_path)
      expect(flash[:alert]).to eq("Your current role as Marketing cannot perform this action.")
    end
  end

  it "answers an Inertia visit with the page as JSON", parity: true do
    log_in(seller)

    inertia_visit balance_path

    expect(response).to be_successful
    expect(response.parsed_body["props"]).to include("next_payout_period_data", "pagination")
  end
end
