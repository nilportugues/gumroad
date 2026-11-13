# frozen_string_literal: true

require "spec_helper"

# GET /bundles/create_from_email, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/rest-sweep-4.replay.test.ts, which sends the last request of each example. Node answers the refusals ahead of
# the first write (the policy refusal and a link Rails cannot save) and creates the draft bundle with its products; the replay also
# reads the Elasticsearch document back, since an index write is not in the recorded db. An example named "hands a ..." is one Node
# leaves to Rails whole.
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

  def best_selling(products, price: 500)
    create_from_email(type: Product::BundlesMarketing::BEST_SELLING_BUNDLE, price:, products:)
  end

  def created_bundle
    Link.order(:id).last
  end

  it "creates the draft bundle with the products the seller owns", parity: true do
    log_in(seller)

    expect { best_selling([product.external_id, second_product.external_id]) }.to change { Link.count }.by(1)

    bundle = created_bundle
    expect(response).to redirect_to("/bundles/#{bundle.external_id}/product/edit")
    expect(bundle).to have_attributes(name: "Best Selling Bundle", draft: true, is_bundle: true, native_type: "bundle", price_cents: 500)
    expect(bundle.bundle_products.map(&:product)).to match_array([product, second_product])
  end

  it "names a year bundle", parity: true do
    log_in(seller)

    create_from_email(type: Product::BundlesMarketing::YEAR_BUNDLE, price: 700, products: [product.external_id])

    expect(created_bundle.name).to eq(Product::BundlesMarketing::BUNDLE_NAMES[Product::BundlesMarketing::YEAR_BUNDLE])
  end

  it "names an everything bundle", parity: true do
    log_in(seller)

    create_from_email(type: Product::BundlesMarketing::EVERYTHING_BUNDLE, price: 900, products: [product.external_id])

    expect(created_bundle.name).to eq(Product::BundlesMarketing::BUNDLE_NAMES[Product::BundlesMarketing::EVERYTHING_BUNDLE])
  end

  it "keeps the first variant of a versioned product", parity: true do
    versioned = create(:product_with_digital_versions, user: seller, name: "Versioned product")
    log_in(seller)

    best_selling([versioned.external_id, product.external_id])

    expect(created_bundle.bundle_products.find_by(product: versioned).variant).to eq(versioned.alive_variants.first)
  end

  it "ignores products that belong to another seller and ids that match nothing", parity: true do
    stranger = create(:product, user: create(:user, name: "Other Mailer"), name: "Stranger product")
    log_in(seller)

    best_selling([stranger.external_id, "unknownproduct", product.external_id, product.external_id])

    expect(response).to redirect_to("/bundles/#{created_bundle.external_id}/product/edit")
    expect(created_bundle.bundle_products.map(&:product)).to eq([product])
  end

  it "creates a bundle with no products when the link carries none", parity: true do
    log_in(seller)

    create_from_email(type: Product::BundlesMarketing::BEST_SELLING_BUNDLE, price: 500)

    expect(response).to redirect_to("/bundles/#{created_bundle.external_id}/product/edit")
    expect(created_bundle.bundle_products.count).to eq(0)
  end

  it "bundles a deleted product too", parity: true do
    product.mark_deleted!
    log_in(seller)

    best_selling([product.external_id])

    expect(created_bundle.bundle_products.map(&:product)).to eq([product])
  end

  STALE_LINK_ALERT = "This bundle link is no longer valid. Use New product to create a bundle."

  def expect_refused_with(member)
    log_in(seller)

    expect { best_selling([product.external_id, member.external_id]) }.not_to change { [Link.count, BundleProduct.count] }

    expect(response).to redirect_to("/products")
    expect(flash[:alert]).to eq(STALE_LINK_ALERT)
  end

  it "refuses a bundle that would hold a subscription", parity: true do
    expect_refused_with(create(:membership_product, user: seller, name: "Membership"))
  end

  it "refuses a bundle that would hold a call", parity: true do
    seller.update_columns(created_at: 60.days.ago)

    expect_refused_with(create(:call_product, user: seller, name: "Call"))
  end

  it "refuses a bundle that would hold another bundle", parity: true do
    expect_refused_with(create(:product, :bundle, user: seller, name: "Inner bundle"))
  end

  it "refuses a price above what an unverified seller may charge", parity: true do
    seller.update!(verified: false)
    log_in(seller)

    expect { best_selling([product.external_id], price: 600_000) }.not_to change { Link.count }

    expect(response).to redirect_to("/products")
  end

  it "hands a bundle priced at zero to Rails", parity: true do
    log_in(seller)

    best_selling([product.external_id], price: 0)

    expect(created_bundle.customizable_price).to be(true)
  end

  it "hands a product with SKUs to Rails", parity: true do
    skus = create(:physical_product, user: seller, name: "SKU product", skus_enabled: true)
    log_in(seller)

    best_selling([skus.external_id])

    expect(response).to have_http_status(:redirect)
  end
end
