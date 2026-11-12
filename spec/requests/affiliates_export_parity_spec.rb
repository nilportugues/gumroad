# frozen_string_literal: true

require "spec_helper"

# GET /affiliates/export, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/rest-sweep-2.replay.test.ts, which sends the last request of each example. Up to 500 live affiliates are
# streamed as a CSV; more are left to Exports::AffiliateExportWorker. A request that carries a Referer on the asynchronous path is
# `hands a ...` (`redirect_back` follows it only for the same host).
describe "Affiliates export", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:named_seller, name: "Export Seller", username: "exportseller") }
  let(:product) { create(:product, user: seller, name: "Exported product", price_cents: 5000) }
  let(:other_product) { create(:product, user: seller, name: "Second product, with a comma", price_cents: 5000) }
  let(:affiliate_user) { create(:named_user, name: "Parity Affiliate", email: "affiliate@example.com") }

  before { host! DOMAIN }

  def sale(of: product, price_cents: 5000, state: "successful", **attributes)
    build(:purchase, link: of, seller:, price_cents:, purchase_state: state, email: "buyer#{SecureRandom.hex(3)}@example.com", **attributes).tap { |purchase| purchase.save!(validate: false) }
  end

  def credit(affiliate, purchase)
    create(:affiliate_credit, affiliate:, affiliate_user: affiliate.affiliate_user, purchase:, seller:, link: purchase.link, amount_cents: 250)
  end

  def export_csv
    get "/affiliates/export"
    expect(response).to have_http_status(:ok)
    CSV.parse(response.body)
  end

  it "exports the live affiliates with their sales", parity: true do
    affiliate = create(:direct_affiliate, seller:, affiliate_user:, products: [product, other_product], destination_url: "https://example.com/landing", affiliate_basis_points: 1250)
    credit(affiliate, sale)
    credit(affiliate, sale(of: other_product, price_cents: 123_456))
    log_in(seller)

    rows = export_csv

    expect(rows.first).to eq(["Affiliate ID", "Name", "Email", "Fee", "Products", "Sales ($)", "Referral URL", "Destination URL", "Created At"])
    expect(rows.second[1..5]).to eq(["Parity Affiliate", "affiliate@example.com", "12 %", '["Exported product", "Second product, with a comma"]', "1,284.56"])
    expect(rows.last).to eq(["Totals", nil, nil, nil, nil, "1,284.56", nil, nil, nil])
    expect(response.headers["Content-Disposition"]).to include("Affiliates-exportseller_")
  end

  it "leaves refunded and charged back sales out of the sales column", parity: true do
    affiliate = create(:direct_affiliate, seller:, affiliate_user:, products: [product])
    credit(affiliate, sale)
    credit(affiliate, sale(price_cents: 7000, stripe_refunded: true))
    credit(affiliate, sale(price_cents: 3000, chargeback_date: 3.days.ago))
    reversed = sale(price_cents: 2000, chargeback_date: 3.days.ago)
    reversed.update_columns(flags: reversed.flags | Purchase.flag_mapping["flags"][:chargeback_reversed])
    credit(affiliate, reversed)
    credit(affiliate, sale(price_cents: 1000, state: "failed"))
    log_in(seller)

    rows = export_csv

    expect(rows.second[5]).to eq("70.00")
  end

  it "counts only the credits of the affiliate's own products", parity: true do
    affiliate = create(:direct_affiliate, seller:, affiliate_user:, products: [product])
    credit(affiliate, sale)
    credit(affiliate, sale(of: other_product, price_cents: 9900))
    log_in(seller)

    rows = export_csv

    expect(rows.second[5]).to eq("50.00")
  end

  it "leaves a deleted affiliate out and lists the others by id", parity: true do
    gone = create(:direct_affiliate, seller:, affiliate_user: create(:named_user, name: "Gone Affiliate"), products: [product])
    gone.update_columns(deleted_at: 1.day.ago)
    create(:direct_affiliate, seller:, affiliate_user:, products: [product])
    create(:direct_affiliate, seller:, affiliate_user: create(:named_user, name: nil, username: "usernameonly"), products: [])
    log_in(seller)

    rows = export_csv

    expect(rows.map { _1[1] }).to eq(["Name", "Parity Affiliate", "usernameonly", nil])
  end

  it "dates an affiliate in the affiliate's own time zone", parity: true do
    traveler = create(:named_user, name: "Pacific Affiliate", timezone: "Pacific Time (US & Canada)")
    affiliate = create(:direct_affiliate, seller:, affiliate_user: traveler, products: [product])
    affiliate.update_columns(created_at: Time.utc(2026, 3, 2, 3, 30))
    log_in(seller)

    rows = export_csv

    expect(rows.second.last).to eq("2026-03-01")
  end

  it "exports an empty list with only the header and the totals row", parity: true do
    log_in(seller)

    rows = export_csv

    expect(rows.size).to eq(2)
    expect(rows.last.first).to eq("Totals")
  end

  it "sends a signed-out visitor to sign in", parity: true do
    get "/affiliates/export"

    expect(response).to have_http_status(:found)
    expect(response.location).to start_with("#{PROTOCOL}://#{DOMAIN}/login")
  end

  it "lets a support team member export", parity: true do
    create(:direct_affiliate, seller:, affiliate_user:, products: [product])
    member = create(:user, name: "Support Member")
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_SUPPORT)
    log_in(member)
    switch_to(membership)

    export_csv
  end

  describe "with more than 500 live affiliates" do
    before do
      now = Time.current
      Affiliate.insert_all(Array.new(501) do |index|
        { type: "DirectAffiliate", seller_id: seller.id, affiliate_user_id: affiliate_user.id, affiliate_basis_points: 300, created_at: now, updated_at: now, flags: index.zero? ? 0 : 0 }
      end)
    end

    it "leaves the export to a job and tells the seller to expect an email", parity: true do
      log_in(seller)

      get "/affiliates/export"

      expect(response).to have_http_status(:found)
      expect(response.location).to eq("#{PROTOCOL}://#{DOMAIN}/affiliates")
      expect(flash[:warning]).to eq("You will receive an email with the data you've requested.")
    end

    it "hands a request with a Referer to Rails", parity: true do
      log_in(seller)

      get "/affiliates/export", headers: { "Referer" => "#{PROTOCOL}://#{DOMAIN}/affiliates?query=a" }

      expect(response).to have_http_status(:found)
      expect(response.location).to eq("#{PROTOCOL}://#{DOMAIN}/affiliates?query=a")
    end
  end
end
