# frozen_string_literal: true

require "spec_helper"

# GET /mobile/sales/:id for a sale bought with a purchasing power parity discount: `Purchase#ppp_info` is the `ppp` key of
# `json_data_for_mobile(include_sale_details: true)`, read from the `purchasing_power_parity_infos` row and `ip_country`.
describe "Mobile API sales with a purchasing power parity discount", type: :request, elasticsearch_wait_for_refresh: true do
  include Parity::MobileApi

  let(:seller) { create(:user) }
  let(:product) { create(:product, user: seller) }
  let!(:credentials) { auth(seller) }

  def ppp_sale(factor: 0.6, discounted: true, **attributes)
    row = { link: product, ip_country: "Brazil" }.merge(attributes)
    purchase_row(**row, seller:, purchase_state: "successful", is_purchasing_power_parity_discounted: discounted).tap do |sale|
      PurchasingPowerParityInfo.create!(purchase: sale, factor:) unless factor.nil?
    end
  end

  def show(sale) = get("/mobile/sales/#{sale.external_id}", params: credentials)

  before { Purchase.__elasticsearch__.create_index!(force: true) }

  it "serves the country and the percentage the discount took off", parity: true do
    show(ppp_sale)

    expect(response.parsed_body["purchase"]["ppp"]).to eq("country" => "Brazil", "discount" => "40%")
  end

  it "rounds the percentage to a whole number", parity: true do
    show(ppp_sale(factor: 0.37))

    expect(response.parsed_body["purchase"]["ppp"]).to eq("country" => "Brazil", "discount" => "63%")
  end

  it "serves a discount of nothing when the factor is one", parity: true do
    show(ppp_sale(factor: 1))

    expect(response.parsed_body["purchase"]["ppp"]).to eq("country" => "Brazil", "discount" => "0%")
  end

  it "serves a null country when the sale has none", parity: true do
    show(ppp_sale(ip_country: nil))

    expect(response.parsed_body["purchase"]["ppp"]).to eq("country" => nil, "discount" => "40%")
  end

  it "leaves ppp out of a discounted sale that has no parity row", parity: true do
    show(ppp_sale(factor: nil))

    expect(response.parsed_body["purchase"]).not_to have_key("ppp")
  end

  it "leaves ppp out of a sale with a parity row that is not flagged as discounted", parity: true do
    show(ppp_sale(discounted: false))

    expect(response.parsed_body["purchase"]).not_to have_key("ppp")
  end

  it "serves a discounted sale together with an offer code", parity: true do
    priced = create(:product, user: seller, price_cents: 1000)
    code = create(:percentage_offer_code, user: seller, products: [priced], code: "tenoff", amount_percentage: 10)
    show(ppp_sale(link: priced, offer_code: code))

    expect(response.parsed_body["purchase"]).to include("ppp" => { "country" => "Brazil", "discount" => "40%" }, "offer_code" => { "code" => "tenoff", "displayed_amount_off" => "10%" })
  end
end
