# frozen_string_literal: true

require "spec_helper"

# Api::V2::PayoutsController (#index, #show) and Api::V2::MediaController#index through the full Rack stack, recorded for the
# Next.js port (PARITY_RECORD=1). Upcoming payouts and include_transactions are handed back to Rails and have no examples here.
describe "API v2 payouts and media", type: :request do
  let(:seller) { create(:user, username: "dude", name: "Dude", email: "dude@example.com") }
  let(:merchant_account) { create(:merchant_account, user: seller) }
  let(:application) { create(:oauth_application, owner: create(:user)) }
  let(:bank) { create(:ach_account, user: seller) }

  before { host! API_DOMAIN }

  def auth(scopes = "view_payouts") = { "Authorization" => "Bearer #{create("doorkeeper/access_token", application:, resource_owner_id: seller.id, scopes:).token}" }

  def payout(days_ago:, **attributes)
    create(
      :payment_completed,
      user: seller, amount_cents: 900_00, processor: PayoutProcessorType::STRIPE, currency: Currency::USD, bank_account: bank,
      stripe_transfer_id: "tr_payout_#{days_ago}", stripe_connect_account_id: "acct_payout_#{days_ago}",
      created_at: days_ago.days.ago, payout_period_end_date: Date.current - days_ago - 3, **attributes
    )
  end

  def sale(**columns)
    create(:free_purchase).tap { _1.update_columns(price_cents: 1000, **columns) }
  end

  describe "GET /v2/payouts" do
    it "lists the past payouts without the upcoming ones", parity: true do
      payout(days_ago: 14)
      payout(days_ago: 7)
      create(:payment_completed, user: create(:user), amount_cents: 1_00, created_at: 3.days.ago)
      get "/v2/payouts", params: { include_upcoming: "false" }, headers: auth
    end

    it "pages through the payouts ten at a time", parity: true do
      (1..12).each { payout(days_ago: _1 * 7) }
      get "/v2/payouts", params: { include_upcoming: "false" }, headers: auth
    end

    it "filters by the after and before dates", parity: true do
      payout(days_ago: 30)
      payout(days_ago: 20)
      payout(days_ago: 10)
      get "/v2/payouts", params: { include_upcoming: "false", after: 25.days.ago.to_date.iso8601, before: 15.days.ago.to_date.iso8601 }, headers: auth
    end

    it "lists the payouts of a seller paid by PayPal", parity: true do
      payout(days_ago: 7, processor: PayoutProcessorType::PAYPAL, bank_account: nil, payment_address: "payee@example.com")
      get "/v2/payouts", params: { include_upcoming: "false" }, headers: auth
    end

    it "prefixes the bank account visual of a payout to a Polish IBAN", parity: true do
      payout(days_ago: 7, bank_account: create(:poland_bank_account, user: seller))
      get "/v2/payouts", params: { include_upcoming: "false" }, headers: auth
    end

    it "prefixes the bank account visual of a payout to a Bosnian account with BA", parity: true do
      payout(days_ago: 7, bank_account: create(:bosnia_and_herzegovina_bank_account, user: seller))
      get "/v2/payouts", params: { include_upcoming: "false" }, headers: auth
    end

    it "refuses an invalid before date", parity: true do
      get "/v2/payouts", params: { before: "2024-02-30" }, headers: auth
    end

    it "refuses an invalid after date", parity: true do
      get "/v2/payouts", params: { after: "2024-13-01" }, headers: auth
    end

    it "refuses an invalid page key", parity: true do
      get "/v2/payouts", params: { page_key: "garbage" }, headers: auth
    end

    it "serves /api/v2 on the main domain", parity: true do
      host! DOMAIN
      payout(days_ago: 7)
      get "/api/v2/payouts", params: { include_upcoming: "false" }, headers: auth
    end

    it "refuses a token without the view_payouts scope", parity: true do
      get "/v2/payouts", params: { include_upcoming: "false" }, headers: auth("view_sales")
    end
  end

  describe "GET /v2/payouts/:id" do
    it "returns a payout with its sold, refunded and disputed sales", parity: true do
      payment = payout(days_ago: 7)
      sold = create(:balance, user: seller, merchant_account:, amount_cents: 1000, date: Date.current - 11, state: "paid")
      refunded = create(:balance, user: seller, merchant_account:, amount_cents: -500, date: Date.current - 11, state: "paid")
      payment.balances << sold << refunded
      sale(purchase_success_balance_id: sold.id, created_at: 9.days.ago)
      sale(purchase_success_balance_id: sold.id, created_at: 10.days.ago)
      sale(purchase_refund_balance_id: refunded.id, created_at: 8.days.ago)
      get "/v2/payouts/#{payment.external_id}", headers: auth("view_payouts view_sales")
    end

    it "leaves the sales out for a token without view_sales", parity: true do
      payment = payout(days_ago: 7)
      payment.balances << create(:balance, user: seller, merchant_account:, amount_cents: 1000, date: Date.current - 11, state: "paid")
      get "/v2/payouts/#{payment.external_id}", headers: auth
    end

    it "leaves the sales out when include_sales is false", parity: true do
      get "/v2/payouts/#{payout(days_ago: 7).external_id}", params: { include_sales: "false" }, headers: auth("view_payouts view_sales")
    end

    it "returns the sale lists of a payout without balances", parity: true do
      get "/v2/payouts/#{payout(days_ago: 7).external_id}", headers: auth("account")
    end

    it "returns the payout of a seller paid by PayPal", parity: true do
      get "/v2/payouts/#{payout(days_ago: 7, processor: PayoutProcessorType::PAYPAL, bank_account: nil, payment_address: "payee@example.com").external_id}", headers: auth
    end

    it "does not find the payout of another seller", parity: true do
      other = create(:payment_completed, user: create(:user), amount_cents: 1_00, created_at: 3.days.ago)
      get "/v2/payouts/#{other.external_id}", headers: auth
    end

    it "does not find an unknown payout", parity: true do
      get "/v2/payouts/unknown", headers: auth
    end
  end

  describe "GET /v2/media" do
    def media_file(**attributes)
      create(:public_file, :with_audio, resource: seller, seller:, **attributes)
    end

    it "lists the seller's media newest first", parity: true do
      media_file(display_name: "First")
      media_file(display_name: "Second")
      get "/v2/media", headers: auth("view_profile")
    end

    it "skips deleted files and the files of other sellers", parity: true do
      media_file(display_name: "Kept")
      media_file(display_name: "Deleted", deleted_at: 1.day.ago)
      other = create(:user)
      create(:public_file, :with_audio, resource: other, seller: other, display_name: "Theirs")
      get "/v2/media", headers: auth("view_profile")
    end

    it "lists a file without an attachment", parity: true do
      create(:public_file, resource: seller, seller:, display_name: "Detached")
      get "/v2/media", headers: auth("view_profile")
    end

    it "lists nothing for a seller without media", parity: true do
      get "/v2/media", headers: auth("view_profile")
    end

    it "refuses a token without the view_profile scope", parity: true do
      get "/v2/media", headers: auth("view_public")
    end
  end
end
