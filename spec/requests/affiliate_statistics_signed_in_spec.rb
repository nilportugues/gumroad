# frozen_string_literal: true

require "spec_helper"

# GET /affiliates/:id/statistics, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/ws12d.replay.test.ts. The clock is frozen at the instant that replay runs at.
describe "Affiliate statistics", type: :request do
  include Parity::AudienceSignedIn

  let(:frozen_at) { Time.utc(2026, 3, 7, 20, 0, 0) }
  let(:seller) { create(:user, name: "Affiliate Seller") }
  let(:affiliate_user) { create(:affiliate_user, name: "Affiliate Person") }
  let(:affiliate) { create(:direct_affiliate, seller:, affiliate_user:) }
  let(:alpha) { create(:product, user: seller, name: "Alpha", unique_permalink: "alpha", price_cents: 500) }
  let(:beta) { create(:product, user: seller, name: "Beta", unique_permalink: "beta", price_cents: 1_500) }
  let(:gamma) { create(:product, user: seller, name: "Gamma", unique_permalink: "gamma", price_cents: 250) }

  before do
    travel_to(frozen_at)
    host! DOMAIN
  end

  after { travel_back }

  # The purchase factories charge a card, which the credit does not need.
  def credit(product, price_cents: product.price_cents, for_affiliate: affiliate, **purchase_attributes)
    purchase = build(:purchase, link: product, seller:, price_cents:, purchase_state: "successful", **purchase_attributes)
    purchase.save!(validate: false)
    create(:affiliate_credit, affiliate: for_affiliate, affiliate_user: for_affiliate.affiliate_user, purchase:, seller:, link: product)
  end

  def fetch_statistics(id = affiliate.external_id)
    get "/affiliates/#{id}/statistics", headers: { "Accept" => "application/json, text/html" }
  end

  it "totals what the affiliate sold per product", parity: true do
    create(:product_affiliate, affiliate:, product: alpha, affiliate_basis_points: 1000)
    create(:product_affiliate, affiliate:, product: beta, affiliate_basis_points: 1000)
    credit(alpha)
    credit(alpha, price_cents: 700)
    credit(beta)
    log_in(seller)

    fetch_statistics

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to eq(
      "total_volume_cents" => 2_700,
      "products" => {
        ObfuscateIds.encrypt_numeric(alpha.id).to_s => { "volume_cents" => 1_200, "sales_count" => 2 },
        ObfuscateIds.encrypt_numeric(beta.id).to_s => { "volume_cents" => 1_500, "sales_count" => 1 },
      }
    )
  end

  it "answers an empty hash for an affiliate with no sales", parity: true do
    create(:product_affiliate, affiliate:, product: alpha, affiliate_basis_points: 1000)
    log_in(seller)

    fetch_statistics

    expect(response.parsed_body).to eq("total_volume_cents" => 0, "products" => {})
  end

  it "answers an empty hash for an affiliate with no products", parity: true do
    log_in(seller)

    fetch_statistics

    expect(response.parsed_body).to eq("total_volume_cents" => 0, "products" => {})
  end

  it "leaves out refunded, charged back and unsuccessful sales and counts a reversed chargeback", parity: true do
    create(:product_affiliate, affiliate:, product: alpha, affiliate_basis_points: 1000)
    credit(alpha)
    credit(alpha, price_cents: 300, stripe_refunded: true)
    credit(alpha, price_cents: 310, chargeback_date: frozen_at)
    credit(alpha, price_cents: 320, chargeback_date: frozen_at, chargeback_reversed: true)
    credit(alpha, price_cents: 330, purchase_state: "failed")
    log_in(seller)

    fetch_statistics

    expect(response.parsed_body).to eq("total_volume_cents" => 820, "products" => { ObfuscateIds.encrypt_numeric(alpha.id).to_s => { "volume_cents" => 820, "sales_count" => 2 } })
  end

  it "leaves out products the affiliate is no longer assigned and credits of other affiliates", parity: true do
    create(:product_affiliate, affiliate:, product: alpha, affiliate_basis_points: 1000)
    other = create(:direct_affiliate, seller:, affiliate_user: create(:affiliate_user, name: "Other Person"))
    create(:product_affiliate, affiliate: other, product: alpha, affiliate_basis_points: 1000)
    credit(alpha)
    credit(gamma)
    credit(alpha, price_cents: 900, for_affiliate: other)
    log_in(seller)

    fetch_statistics

    expect(response.parsed_body).to eq("total_volume_cents" => 500, "products" => { ObfuscateIds.encrypt_numeric(alpha.id).to_s => { "volume_cents" => 500, "sales_count" => 1 } })
  end

  it "lists the products in the order of their first sale", parity: true do
    [gamma, beta, alpha].each { |product| create(:product_affiliate, affiliate:, product:, affiliate_basis_points: 1000) }
    [beta, alpha, gamma].each { |product| credit(product) }
    log_in(seller)

    fetch_statistics

    expect(response.parsed_body["products"].keys).to eq([beta, alpha, gamma].map { |product| ObfuscateIds.encrypt_numeric(product.id).to_s })
  end

  it "answers for an affiliate who was removed", parity: true do
    create(:product_affiliate, affiliate:, product: alpha, affiliate_basis_points: 1000)
    credit(alpha)
    affiliate.update_columns(deleted_at: frozen_at)
    log_in(seller)

    fetch_statistics

    expect(response.parsed_body).to eq("total_volume_cents" => 500, "products" => { ObfuscateIds.encrypt_numeric(alpha.id).to_s => { "volume_cents" => 500, "sales_count" => 1 } })
  end

  it "answers a seller's own team members who may see affiliates", parity: true do
    create(:product_affiliate, affiliate:, product: alpha, affiliate_basis_points: 1000)
    credit(alpha)
    member = create(:user, name: "Support Member")
    membership = create(:team_membership, user: member, seller:, role: :support)
    log_in(member)
    switch_to(membership)

    fetch_statistics

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body["total_volume_cents"]).to eq(500)
  end

  it "answers 404 for an unknown affiliate", parity: true do
    log_in(seller)

    fetch_statistics("notanaffiliate")

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 for another seller's affiliate", parity: true do
    other_affiliate = create(:direct_affiliate, seller: create(:user, name: "Other Seller"), affiliate_user:)
    log_in(seller)

    fetch_statistics(other_affiliate.external_id)

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 for a collaborator id", parity: true do
    collaborator = create(:collaborator, seller:)
    log_in(seller)

    fetch_statistics(collaborator.external_id)

    expect(response).to have_http_status(:not_found)
  end

  it "hands a request for another format to Rails", parity: true do
    log_in(seller)

    get "/affiliates/#{affiliate.external_id}/statistics", headers: { "Accept" => "application/xml" }

    expect(response).to have_http_status(:ok)
  end
end
