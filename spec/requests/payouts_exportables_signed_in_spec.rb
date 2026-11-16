# frozen_string_literal: true

require "spec_helper"

# Payouts::ExportablesController#index, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/payouts-exportables.replay.test.ts, which sends the last request of each example. The clock is frozen
# at 2026-11-11 12:00 UTC (the replay freezes the same instant) because the payouts are bucketed by calendar year and the seeds travel as
# whole-hour offsets from it.
describe "Payouts exportables when signed in", type: :request do
  include Parity::SignedInDashboard

  def parity_now = Time.utc(2026, 11, 11, 12, 0, 0)

  before { travel_to(parity_now) }

  def json_headers = { "Accept" => "application/json" }

  let(:seller) { create(:user, name: "Exporting Seller", username: "exportingseller") }

  def payout(created_at, user: seller, factory: :payment_completed)
    create(factory, user:, amount_cents: 5000, processor: PayoutProcessorType::STRIPE, currency: Currency::USD, created_at:,
                    stripe_transfer_id: "tr_#{created_at.to_i}", stripe_connect_account_id: "acct_#{created_at.to_i}",
                    payout_period_end_date: created_at.to_date - 3)
  end

  def seed_payouts
    payout(Time.utc(2024, 3, 1, 12))
    payout(Time.utc(2024, 3, 2, 12))
    payout(Time.utc(2024, 11, 22, 8))
    payout(Time.utc(2023, 12, 31, 23, 0, 0))
    payout(Time.utc(2024, 1, 1, 0, 0, 0))
    payout(Time.utc(2022, 7, 14, 9))
  end

  def fetch(**params)
    log_in(seller)
    get payouts_exportables_path(params), headers: json_headers
  end

  it "lists the years with payouts and the payouts of the latest year", parity: true do
    seed_payouts

    fetch

    expect(response).to be_successful
    expect(response.parsed_body["years_with_payouts"]).to eq([2024, 2023, 2022])
    expect(response.parsed_body["selected_year"]).to eq(2024)
    expect(response.parsed_body["payouts_in_selected_year"].size).to eq(4)
  end

  it "lists the payouts of the requested year", parity: true do
    seed_payouts

    fetch(year: 2023)

    expect(response.parsed_body["selected_year"]).to eq(2023)
    expect(response.parsed_body["payouts_in_selected_year"].map { _1["date_formatted"] }).to eq(["December 31st, 2023"])
  end

  it "keeps a payout at the very start and the very end of a year in that year", parity: true do
    seed_payouts

    fetch(year: 2024)

    expect(response.parsed_body["payouts_in_selected_year"].map { _1["date_formatted"] }).to eq(
      ["November 22nd, 2024", "March 2nd, 2024", "March 1st, 2024", "January 1st, 2024"]
    )
  end

  it "falls back to the latest year when the requested year has no payouts", parity: true do
    seed_payouts

    fetch(year: 2021)

    expect(response.parsed_body["selected_year"]).to eq(2024)
  end

  it "falls back to the latest year when the year is not a number", parity: true do
    seed_payouts

    fetch(year: "abc")

    expect(response.parsed_body["selected_year"]).to eq(2024)
  end

  it "reads the leading digits of the requested year", parity: true do
    seed_payouts

    fetch(year: "2022abc")

    expect(response.parsed_body["selected_year"]).to eq(2022)
  end

  it "leaves out other states, other sellers and payouts before the oldest displayable period", parity: true do
    seed_payouts
    payout(Time.utc(2024, 5, 1, 12), factory: :payment_failed)
    payout(Time.utc(2025, 5, 1, 12), factory: :payment)
    payout(Time.utc(2024, 6, 1, 12), user: create(:user))
    payout(Time.utc(2012, 6, 1, 12))

    fetch(year: 2012)

    expect(response.parsed_body["years_with_payouts"]).to eq([2024, 2023, 2022])
    expect(response.parsed_body["payouts_in_selected_year"].size).to eq(4)
  end

  it "offers the current year to a seller without payouts", parity: true do
    fetch

    expect(response.parsed_body).to eq("years_with_payouts" => [Time.current.year], "selected_year" => Time.current.year, "payouts_in_selected_year" => [])
  end

  it "encodes the payout ids as external ids", parity: true do
    payment = payout(Time.utc(2024, 3, 1, 12))

    fetch

    expect(response.parsed_body["payouts_in_selected_year"]).to eq([{ "id" => payment.external_id, "date_formatted" => "March 1st, 2024" }])
  end

  describe "team members" do
    %w[accountant admin support].each do |role|
      it "lets #{role} list the payouts", parity: true do
        seed_payouts
        member = create(:user, name: "Team #{role}")
        membership = create(:team_membership, user: member, seller:, role:)
        log_in(member)
        switch_to(membership)

        get payouts_exportables_path, headers: json_headers

        expect(response).to be_successful
        expect(response.parsed_body["payouts_in_selected_year"].size).to eq(4)
      end
    end

    it "answers 401 JSON to marketing", parity: true do
      seed_payouts
      member = create(:user, name: "Team marketing")
      membership = create(:team_membership, user: member, seller:, role: "marketing")
      log_in(member)
      switch_to(membership)

      get payouts_exportables_path, headers: json_headers

      expect(response).to have_http_status(:unauthorized)
    end
  end

  it "answers 403 JSON to a seller without an email address", parity: true do
    log_in(seller)
    seller.update_columns(email: nil, unconfirmed_email: nil)

    get payouts_exportables_path, headers: json_headers

    expect(response).to have_http_status(:forbidden)
  end

  it "answers HTML requests through Rails", parity: true do
    log_in(seller)

    get payouts_exportables_path

    expect(response).to be_successful
  end
end
