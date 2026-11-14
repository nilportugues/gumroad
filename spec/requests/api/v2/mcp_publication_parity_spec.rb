# frozen_string_literal: true

require "spec_helper"

# The publish_product and unpublish_product tools of Mcp::Server (Link#publish! and #unpublish!) through the full Rack stack, recorded for
# the Next.js port and replayed by nextjs/parity/__tests__/api-v2-ws17c.replay.test.ts. Node publishes the products that
# api-v2 product_enable_parity_spec.rb shows it can; every other product goes to Rails whole, in an example named "hands ... back".
# `parity_timeline` records the order of the statements and jobs inside the publish.
describe "API v2 MCP product publication", type: :request, parity_timeline: true do
  let(:seller) { create(:user, username: "dude", name: "Dude") }
  let(:application) { create(:oauth_application, owner: create(:user)) }
  let(:rpc) { { "Content-Type" => "application/json" } }
  let!(:product) { create(:product, user: seller, name: "Pencil", unique_permalink: "pencilpk", description: "Writes", created_at: 2.days.ago, purchase_disabled_at: 1.day.ago) }
  let(:passed) { ContentModeration::ModerateRecordService::CheckResult.new(passed: true, reasons: []) }

  before { host! DOMAIN }

  def auth(scopes) = { "Authorization" => "Bearer #{create("doorkeeper/access_token", application:, resource_owner_id: seller.id, scopes:).token}" }

  def call_tool(name, arguments = {}, scopes: "edit_products")
    body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name:, arguments: } }
    post "/muse/v1/mcp", params: body.to_json, headers: rpc.merge(auth(scopes))
  end

  def publish(id = "pencilpk", **options) = call_tool("publish_product", { id: }, **options)

  describe "publish_product" do
    it "publishes a disabled product", parity: true do
      publish
      expect(product.reload.purchase_disabled_at).to be_nil
    end

    it "records the first publication of a draft", parity: true do
      product.update_columns(draft: true, purchase_disabled_at: nil)
      publish
      expect(product.reload.first_published_at).to be_present
    end

    it "keeps the date of the first publication when a product is published again", parity: true do
      product.update_columns(first_published_at: Time.utc(2025, 1, 1))
      publish
      expect(product.reload.first_published_at).to eq(Time.utc(2025, 1, 1))
    end

    it "publishes a product that is already published", parity: true do
      product.update_columns(purchase_disabled_at: nil)
      publish
    end

    it "keeps the flags another save wrote since the product was loaded", parity: true do
      product.update_columns(flags: product.flags | 1)
      publish
      expect(product.reload.flags & 1).to eq(1)
    end

    it "publishes the product of a verified seller while content moderation is on", parity: true do
      Feature.activate(:content_moderation)
      seller.update_columns(verified: true)
      publish
    end

    it "publishes by external id", parity: true do
      publish(product.external_id, scopes: "account")
    end

    it "reports a seller whose email is not confirmed as a tool error", parity: true do
      seller.update_columns(confirmed_at: nil)
      publish
      expect(product.reload.purchase_disabled_at).to be_present
    end

    it "reports a product unpublished by Gumroad as a tool error", parity: true do
      product.update_columns(flags: product.flags | (1 << 28))
      publish
    end

    it "reports a product on a sales hold as a tool error", parity: true do
      ProductSalesHold.create!(product:, held_by: create(:user))
      publish
    end

    it "reports a product that does not exist as a tool error", parity: true do
      publish("missing")
    end

    it "does not find the product of another seller", parity: true do
      publish(create(:product, user: create(:user)).external_id)
    end

    it "reports a seller with no payment method as a tool error", parity: true do
      seller.update_columns(payment_address: nil)
      publish
    end

    it "hands back a publish of a product with a discount code", parity: true do
      create(:offer_code, user: seller, products: [product], amount_cents: 1)
      publish
    end

    it "hands back a publish of an unverified seller's product while content moderation is on", parity: true do
      Feature.activate(:content_moderation)
      allow(ContentModeration::ModerateRecordService).to receive(:check).and_return(passed)
      publish
    end

    it "hands back a publish of a product that has sales", parity: true do
      build(:purchase, link: product, purchase_state: "successful").save!(validate: false)
      publish
    end

    it "hands back a publish of a tiered membership", parity: true do
      membership = create(:membership_product, user: seller, name: "Club", unique_permalink: "clubpass", purchase_disabled_at: 1.day.ago)
      publish(membership.unique_permalink)
    end

    it "hands back a publish of a seller whose videos are transcoded", parity: true do
      seller.update_columns(tier_state: User::TIER_3)
      publish
    end

    it "asks a publish with a token that cannot edit products to step up", parity: true do
      publish(scopes: "view_public")
    end
  end

  describe "unpublish_product" do
    def unpublish(id = "pencilpk", **options) = call_tool("unpublish_product", { id: }, **options)

    it "unpublishes a published product", parity: true do
      product.update_columns(purchase_disabled_at: nil)
      unpublish
      expect(product.reload.purchase_disabled_at).to be_present
    end

    it "keeps the time a product was already unpublished", parity: true do
      unpublish
    end

    it "unpublishes a draft", parity: true do
      product.update_columns(draft: true, purchase_disabled_at: nil)
      unpublish
    end

    it "unpublishes by external id", parity: true do
      product.update_columns(purchase_disabled_at: nil)
      unpublish(product.external_id, scopes: "account")
    end

    it "reports a product that does not exist as a tool error", parity: true do
      unpublish("missing")
    end

    it "hands back an unpublish of a tiered membership", parity: true do
      membership = create(:membership_product, user: seller, name: "Club", unique_permalink: "clubpass")
      unpublish(membership.unique_permalink)
    end

    it "asks an unpublish with a token that cannot edit products to step up", parity: true do
      unpublish(scopes: "view_public")
    end
  end
end
