# frozen_string_literal: true

require "spec_helper"

# Api::V2::LinksController#enable (Link#publish!) through the full Rack stack, recorded for the Next.js port
# (nextjs/parity/__tests__/api-v2-ws17c.replay.test.ts). Node publishes a product whose content moderation passes without a model call
# (the :content_moderation flag off, or a verified seller), whose seller has no direct affiliate for all products, whose videos are not
# transcoded on publish and that is not physical; every other product goes to Rails whole, in an example named "hands a ... back to Rails".
# `parity_timeline` records the order of the statements and jobs inside the publish.
describe "API v2 product enable", type: :request, parity_timeline: true do
  include Parity::ApiV2Requests

  let(:seller) { create(:user) }
  let(:product) { create(:product, user: seller, name: "Pencil", description: "Writes", created_at: 2.days.ago, purchase_disabled_at: 1.day.ago) }
  let(:token) { api_token(seller, scopes: "edit_products") }
  let(:passed) { ContentModeration::ModerateRecordService::CheckResult.new(passed: true, reasons: []) }

  def enable(target = product, **options) = api_call(:put, "/products/#{target.external_id}/enable", token:, **options)

  it "refuses a read-only token", parity: true do
    api_call(:put, "/products/#{product.external_id}/enable", token: api_token(seller, scopes: "view_public"))

    expect(response).to have_http_status(:forbidden)
  end

  it "says the product was not found", parity: true do
    api_call(:put, "/products/missing/enable", token:)

    expect(response.parsed_body["message"]).to eq("The product was not found.")
  end

  it "does not find the product of another seller", parity: true do
    enable(create(:product, user: create(:user)), api_host: false)

    expect(response.parsed_body["message"]).to eq("The product was not found.")
  end

  it "enables a product that was disabled", parity: true do
    enable

    expect(response.parsed_body["success"]).to be(true)
    expect(product.reload.purchase_disabled_at).to be_nil
  end

  it "enables a product that has a taxonomy and shows its category", parity: true do
    product.update!(taxonomy: create(:taxonomy, parent: create(:taxonomy)))

    enable

    expect(response.parsed_body["product"]).to include("published" => true)
    expect(response.parsed_body["product"]["category"]).to be_present
  end

  it "enables a product by its permalink through the api prefix", parity: true do
    api_call(:put, "/products/#{product.unique_permalink}/enable", token:, api_host: false)

    expect(response.parsed_body["product"]["published"]).to be(true)
  end

  it "records the first publication of a draft", parity: true do
    product.update_columns(draft: true, purchase_disabled_at: nil)

    enable

    expect(product.reload.first_published_at).to be_present
    expect(product.draft).to be(false)
  end

  it "keeps the date of the first publication when a product is enabled again", parity: true do
    product.update_columns(first_published_at: Time.utc(2025, 1, 1))

    enable

    expect(product.reload.first_published_at).to eq(Time.utc(2025, 1, 1))
  end

  it "enables a product that is already published", parity: true do
    product.update_columns(purchase_disabled_at: nil)

    enable

    expect(response.parsed_body["success"]).to be(true)
  end

  it "keeps the flags another save wrote since the product was loaded", parity: true do
    product.update_columns(flags: product.flags | 1)

    enable

    expect(product.reload.flags & 1).to eq(1)
  end

  it "enables a product of a verified seller while content moderation is on", parity: true do
    Feature.activate(:content_moderation)
    seller.update_columns(verified: true)

    enable

    expect(response.parsed_body["success"]).to be(true)
  end

  it "refuses a seller whose email is not confirmed", parity: true do
    seller.update_columns(confirmed_at: nil)

    enable

    expect(response.parsed_body["message"]).to eq("You have to confirm your email address before you can do that.")
    expect(product.reload.purchase_disabled_at).to be_present
  end

  it "refuses a product unpublished by Gumroad", parity: true do
    product.update_columns(flags: product.flags | (1 << 28))

    enable

    expect(response.parsed_body["message"]).to eq("This product was unpublished by Gumroad and cannot be republished by the seller.")
  end

  it "refuses a product on a sales hold", parity: true do
    ProductSalesHold.create!(product:, held_by: create(:user))

    enable

    expect(response.parsed_body["message"]).to eq("This product was unpublished by Gumroad and cannot be republished by the seller.")
  end

  it "refuses a seller with no payment method", parity: true do
    seller.update_columns(payment_address: nil)

    enable

    expect(response.parsed_body["success"]).to be(false)
  end

  it "enables a product beside a discount code that keeps the price valid", parity: true do
    create(:offer_code, user: seller, products: [product], amount_cents: 1)

    enable

    expect(response.parsed_body["success"]).to be(true)
  end

  it "hands an enable of an unverified seller's product back to Rails while content moderation is on", parity: true do
    Feature.activate(:content_moderation)
    allow(ContentModeration::ModerateRecordService).to receive(:check).and_return(passed)

    enable

    expect(response.parsed_body["success"]).to be(true)
  end

  it "hands an enable of a deleted product back to Rails", parity: true do
    product.update_columns(deleted_at: 1.hour.ago)

    enable

    expect(response.parsed_body["success"]).to be(true)
  end

  it "hands an enable of a seller with a direct affiliate for all products back to Rails", parity: true do
    create(:direct_affiliate, seller:, apply_to_all_products: true)

    enable

    expect(response.parsed_body["success"]).to be(true)
  end

  it "hands an enable of a seller whose videos are transcoded back to Rails", parity: true do
    seller.update_columns(tier_state: User::TIER_3)

    enable

    expect(response.parsed_body["success"]).to be(true)
  end

  it "hands an enable of a product that has sales back to Rails", parity: true do
    build(:purchase, link: product, purchase_state: "successful").save!(validate: false)

    enable

    expect(response.parsed_body["success"]).to be(true)
  end

  it "hands an enable of a physical product back to Rails", parity: true do
    physical = create(:physical_product, user: seller, purchase_disabled_at: 1.day.ago)

    enable(physical)

    expect(response.parsed_body).to include("success")
  end

  it "hands an enable of a seller in the paid-publish experiment back to Rails", parity: true do
    Feature.activate_user(:seller_plan_gate, seller)
    product.update_columns(draft: true)

    enable

    expect(response.parsed_body["success"]).to be(true)
  end
end
