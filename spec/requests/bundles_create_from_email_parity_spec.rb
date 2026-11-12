# frozen_string_literal: true

require "spec_helper"

# GET /bundles/create_from_email, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/rest-sweep-4.replay.test.ts, which sends the last request of each example. Node answers the refusals ahead of
# the first write (a link whose type the marketing email never sends or whose price is under the currency minimum, and the policy
# refusal); an example named "hands a ..." is the creation of the bundle, which Node leaves to Rails whole.
describe "Bundles create from email", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:named_seller, name: "Bundle Mailer") }
  let!(:product) { create(:product, user: seller, name: "First product") }
  let!(:second_product) { create(:product, user: seller, name: "Second product") }

  before { host! DOMAIN }

  def create_from_email(params)
    get "/bundles/create_from_email", params:, headers: { "Accept" => "text/html, application/xhtml+xml" }
  end

  it "refuses a bundle type the marketing email never sends", parity: true do
    log_in(seller)

    expect { create_from_email(type: "classic", price: 500, products: [product.external_id]) }.not_to change { Link.count }

    expect(response).to redirect_to("/products")
    expect(flash[:alert]).to eq("This bundle link is no longer valid. Use New product to create a bundle.")
  end

  it "refuses a price under the currency minimum", parity: true do
    log_in(seller)

    expect { create_from_email(type: Product::BundlesMarketing::YEAR_BUNDLE, price: 50, products: [product.external_id]) }.not_to change { Link.count }

    expect(response).to redirect_to("/products")
    expect(flash[:alert]).to eq("This bundle link is no longer valid. Use New product to create a bundle.")
  end

  it "refuses a user who may not create products", parity: true do
    accountant = create(:user, name: "Bundle Accountant")
    membership = create(:team_membership, user: accountant, seller:, role: TeamMembership::ROLE_ACCOUNTANT)
    log_in(accountant)
    switch_to(membership)

    expect { create_from_email(type: Product::BundlesMarketing::BEST_SELLING_BUNDLE, price: 500, products: [product.external_id]) }.not_to change { Link.count }

    expect(response).to have_http_status(:redirect)
  end

  it "hands the creation of the bundle to Rails", parity: true do
    log_in(seller)

    create_from_email(type: Product::BundlesMarketing::BEST_SELLING_BUNDLE, price: 500, products: [product.external_id, second_product.external_id])

    bundle = Link.order(:id).last
    expect(response).to redirect_to("/bundles/#{bundle.external_id}/product/edit")
    expect(bundle.bundle_products.count).to eq(2)
  end
end
