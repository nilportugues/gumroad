# frozen_string_literal: true

require "spec_helper"

# Payouts::ExportsController#create, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/payouts-exports.replay.test.ts, which sends the last request of each example. The clock is frozen
# (the replay freezes the same instant) because the payouts are seeded as whole-hour offsets from it.
describe "Payouts exports when signed in", type: :request do
  include Parity::SignedInDashboard

  def parity_now = Time.utc(2026, 11, 11, 12, 0, 0)

  before { travel_to(parity_now) }

  let(:seller) { create(:user, name: "Exporting Seller", username: "exportingseller") }

  def payout(created_at, user: seller, factory: :payment_completed)
    create(factory, user:, amount_cents: 5000, processor: PayoutProcessorType::STRIPE, currency: Currency::USD, created_at:,
                    stripe_transfer_id: "tr_#{created_at.to_i}", stripe_connect_account_id: "acct_#{created_at.to_i}",
                    payout_period_end_date: created_at.to_date - 3)
  end

  let!(:first_payout) { payout(Time.utc(2024, 3, 1, 12)) }
  let!(:second_payout) { payout(Time.utc(2025, 4, 2, 12)) }

  def export(payout_ids, as: seller, membership: nil)
    log_in(as)
    switch_to(membership) if membership
    post payouts_exports_path,
         params: { payout_ids: }.to_json,
         headers: { "Accept" => "application/json", "Content-Type" => "application/json", "X-CSRF-Token" => csrf_token }
  end

  it "queues the export of one payout for the signed-in account", parity: true do
    export([first_payout.external_id])

    expect(response).to have_http_status(:ok)
    expect(ExportPayoutData.jobs.map { _1["args"] }).to eq([[[first_payout.id], seller.id]])
  end

  it "queues the export of several payouts in id order", parity: true do
    export([second_payout.external_id, first_payout.external_id])

    expect(response).to have_http_status(:ok)
    expect(ExportPayoutData.jobs.map { _1["args"] }).to eq([[[first_payout.id, second_payout.id], seller.id]])
  end

  it "queues the export for a seller who is suspended", parity: true do
    seller.update_columns(user_risk_state: "suspended_for_fraud")

    export([first_payout.external_id])

    expect(response).to have_http_status(:ok)
    expect(ExportPayoutData.jobs.size).to eq(1)
  end

  describe "payouts that cannot be exported" do
    it "answers 422 without payout ids", parity: true do
      export([])

      expect(response).to have_http_status(:unprocessable_content)
      expect(response.parsed_body).to eq("error" => "Invalid payouts")
      expect(ExportPayoutData.jobs.size).to eq(0)
    end

    it "answers 422 when one of the ids is not a payout", parity: true do
      export([first_payout.external_id, "bogus"])

      expect(response).to have_http_status(:unprocessable_content)
      expect(ExportPayoutData.jobs.size).to eq(0)
    end

    it "answers 422 when an id is repeated", parity: true do
      export([first_payout.external_id, first_payout.external_id])

      expect(response).to have_http_status(:unprocessable_content)
    end

    it "answers 422 for the payout of another seller", parity: true do
      other = payout(Time.utc(2024, 5, 1, 12), user: create(:user))

      export([other.external_id])

      expect(response).to have_http_status(:unprocessable_content)
      expect(ExportPayoutData.jobs.size).to eq(0)
    end

    it "answers 422 for a payout that has not completed", parity: true do
      processing = payout(Time.utc(2024, 5, 1, 12), factory: :payment)

      export([processing.external_id])

      expect(response).to have_http_status(:unprocessable_content)
    end

    it "answers 422 for a payout before the oldest displayable period", parity: true do
      old = payout(Time.utc(2012, 6, 1, 12))

      export([old.external_id])

      expect(response).to have_http_status(:unprocessable_content)
    end

    it "answers 422 when the body has no payout ids", parity: true do
      log_in(seller)
      post payouts_exports_path, params: {}.to_json,
                                 headers: { "Accept" => "application/json", "Content-Type" => "application/json", "X-CSRF-Token" => csrf_token }

      expect(response).to have_http_status(:unprocessable_content)
    end
  end

  describe "team members" do
    %w[accountant admin support].each do |role|
      it "lets #{role} export", parity: true do
        member = create(:user, name: "Team #{role}")
        membership = create(:team_membership, user: member, seller:, role:)

        export([first_payout.external_id], as: member, membership:)

        expect(response).to have_http_status(:ok)
        expect(ExportPayoutData.jobs.map { _1["args"] }).to eq([[[first_payout.id], member.id]])
      end
    end

    it "answers 401 JSON to marketing", parity: true do
      member = create(:user, name: "Team marketing")
      membership = create(:team_membership, user: member, seller:, role: "marketing")

      export([first_payout.external_id], as: member, membership:)

      expect(response).to have_http_status(:unauthorized)
      expect(ExportPayoutData.jobs.size).to eq(0)
    end

    it "answers 422 before 401 to marketing when the ids are invalid", parity: true do
      member = create(:user, name: "Team marketing")
      membership = create(:team_membership, user: member, seller:, role: "marketing")

      export(["bogus"], as: member, membership:)

      expect(response).to have_http_status(:unprocessable_content)
    end
  end

  it "answers 403 JSON to a seller without an email address", parity: true do
    log_in(seller)
    seller.update_columns(email: nil, unconfirmed_email: nil)

    post payouts_exports_path, params: { payout_ids: [first_payout.external_id] }.to_json,
                               headers: { "Accept" => "application/json", "Content-Type" => "application/json", "X-CSRF-Token" => csrf_token }

    expect(response).to have_http_status(:forbidden)
  end

  it "queues the export of form-encoded payout ids", parity: true do
    log_in(seller)

    post payouts_exports_path, params: { payout_ids: [first_payout.external_id], authenticity_token: csrf_token }, headers: { "Accept" => "application/json" }

    expect(response).to have_http_status(:ok)
    expect(ExportPayoutData.jobs.size).to eq(1)
  end

  it "hands a numeric payout id to Rails", parity: true do
    export([123])

    expect(response).to have_http_status(:unprocessable_content)
  end
end
