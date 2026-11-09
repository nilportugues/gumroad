# frozen_string_literal: true

require "spec_helper"

# The JSON endpoints around the product editor and the product page (TagsController#index, LinksController#cart_items_count,
# #increment_views and #track_user_action, Products::VariantsController, Products::OtherRefundPoliciesController and
# Products::AvailableOfferCodesController), recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/ws12c.replay.test.ts.
describe "Product editor JSON endpoints", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Editor Seller", is_team_member: true) }
  let(:product) { create(:product, user: seller, name: "Editable product", unique_permalink: "editprod", price_cents: 500, created_at: Time.utc(2025, 1, 1)) }
  let(:json_headers) { { "Accept" => "application/json, text/html", "Content-Type" => "application/json" } }
  let(:agent) { { "User-Agent" => "ParityBrowser/1.0" } }

  before { host! DOMAIN }

  def get_json(path, params = {})
    get path, params:, headers: { "Accept" => "application/json, text/html" }
  end

  def post_json(path, body = {}, extra = {})
    post path, params: body.to_json, headers: json_headers.merge("X-CSRF-Token" => csrf_token).merge(extra)
  end

  def team_member(role)
    member = create(:user, name: "#{role.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  describe "tags" do
    before do
      create(:tag, name: "music", taggings_count: 3)
      create(:tag, name: "muse", taggings_count: 7)
      create(:tag, name: "mural", taggings_count: 7)
      create(:tag, name: "art", taggings_count: 1)
    end

    it "lists tags starting with the text, most used first", parity: true do
      get tags_path, params: { text: "MU" }

      expect(response.parsed_body.map { _1["name"] }).to eq(%w[mural muse music])
      expect(response.parsed_body.first["uses"]).to eq(7)
    end

    it "lists the most used tags for an empty text", parity: true do
      get tags_path, params: { text: "" }

      expect(response.parsed_body.size).to eq(4)
    end

    it "answers failure without a text", parity: true do
      get tags_path

      expect(response.parsed_body).to eq("success" => false)
    end

    it "matches a text containing a LIKE wildcard as a pattern", parity: true do
      get tags_path, params: { text: "mur_l" }

      expect(response.parsed_body.map { _1["name"] }).to eq(%w[mural])
    end
  end

  describe "cart items count" do
    let(:guid) { "parity-browser-guid" }

    it "counts the alive lines of a guest cart", parity: true do
      cart = create(:cart, :guest, browser_guid: guid)
      create(:cart_product, cart:, product:)
      create(:cart_product, cart:, product: create(:product, user: seller), deleted_at: Time.current)
      cookies[:_gumroad_guid] = guid

      get_json cart_items_count_path

      expect(response.parsed_body).to eq("cart_items_count" => 1)
    end

    it "is zero for a visitor without a cart", parity: true do
      cookies[:_gumroad_guid] = guid

      get_json cart_items_count_path

      expect(response.parsed_body).to eq("cart_items_count" => 0)
    end

    it "counts the first alive cart of a signed-in user", parity: true do
      create(:cart_product, cart: create(:cart, user: seller), product:)
      log_in(seller)

      get_json cart_items_count_path

      expect(response.parsed_body).to eq("cart_items_count" => 1)
    end
  end

  describe "track_user_action" do
    it "records a permitted event for a visitor", parity: true do
      post_json track_user_action_link_path(product.unique_permalink), { event_name: "post_view", view_url: "/somewhere" }, agent

      expect(response.parsed_body).to eq("success" => true)
      expect(Event.last.link_id).to eq(product.id)
    end

    it "drops an event that is not permitted for a visitor", parity: true do
      post_json track_user_action_link_path(product.unique_permalink), { event_name: "add_product" }, agent

      expect(response.parsed_body).to eq("success" => true)
      expect(Event.count).to eq(0)
    end

    it "records any event for a signed-in buyer", parity: true do
      buyer = create(:user)
      log_in(buyer)

      post_json track_user_action_link_path(product.unique_permalink), { event_name: "add_product" }, agent

      expect(Event.last.user_id).to eq(buyer.id)
    end

    it "records nothing for the seller of the product", parity: true do
      log_in(seller)

      post_json track_user_action_link_path(product.unique_permalink), { event_name: "post_view" }, agent

      expect(response.parsed_body).to eq("success" => true)
      expect(Event.count).to eq(0)
    end

    it "answers 404 for an unknown product", parity: true do
      post_json track_user_action_link_path("nosuchprod"), { event_name: "post_view" }

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "increment_views" do
    it "queues a product page view for a visitor", parity: true do
      post_json increment_views_link_path(product.unique_permalink), { referrer: "https://example.com/post", view_url: "/l/editprod" }, agent

      expect(response.parsed_body).to eq("success" => true)
      expect(ElasticsearchIndexerWorker.jobs.size).to eq(1)
    end

    it "counts nothing for a crawler", parity: true do
      post_json increment_views_link_path(product.unique_permalink), {}, { "User-Agent" => "Googlebot/2.1" }

      expect(ElasticsearchIndexerWorker.jobs.size).to eq(0)
    end

    it "counts nothing for the seller", parity: true do
      log_in(seller)

      post_json increment_views_link_path(product.unique_permalink), {}, agent

      expect(ElasticsearchIndexerWorker.jobs.size).to eq(0)
    end

    it "counts a signed-in buyer's view with their id", parity: true do
      log_in(create(:user))

      post_json increment_views_link_path(product.unique_permalink), { was_product_recommended: "true" }, agent

      expect(ElasticsearchIndexerWorker.jobs.size).to eq(1)
    end

    it "never counts a GET without an analytics token", parity: true do
      get increment_views_link_path(product.unique_permalink), headers: { "Accept" => "application/json" }

      expect(response.parsed_body).to eq("success" => true)
      expect(ElasticsearchIndexerWorker.jobs.size).to eq(0)
    end
  end

  describe "variants" do
    it "lists the options of the first category in order", parity: true do
      category = create(:variant_category, link: product, title: "Size")
      create(:variant, variant_category: category, name: "Large", price_difference_cents: 200, max_purchase_count: 5, position_in_category: 1)
      create(:variant, variant_category: category, name: "Small", description: "The small one", position_in_category: 0)
      create(:variant, variant_category: category, name: "Gone", deleted_at: Time.current)
      create(:variant_category, link: product, title: "Color")
      log_in(seller)

      get_json link_variants_path(product.unique_permalink)

      expect(response.parsed_body.map { _1["name"] }).to eq(%w[Small Large])
      expect(response.parsed_body.last["quantity_left"]).to eq(5)
    end

    it "is empty for a product without options", parity: true do
      product
      log_in(seller)

      get_json link_variants_path(product.unique_permalink)

      expect(response.parsed_body).to eq([])
    end

    it "answers 404 for another seller's product", parity: true do
      other = create(:product, unique_permalink: "notmine")
      log_in(seller)

      get_json link_variants_path(other.unique_permalink)

      expect(response).to have_http_status(:not_found)
    end

    it "lets a support team member read them", parity: true do
      product
      team_member(TeamMembership::ROLE_SUPPORT)

      get_json link_variants_path(product.unique_permalink)

      expect(response).to have_http_status(:ok)
    end
  end

  describe "other refund policies" do
    it "lists the seller's other visible product-level policies, newest first", parity: true do
      older = create(:product, user: seller, name: "Older policy product")
      newer = create(:product, user: seller, name: "Newer policy product")
      archived = create(:product, user: seller, name: "Archived", archived: true)
      create(:product_refund_policy, product: older, seller:, max_refund_period_in_days: 7, updated_at: 2.days.ago.change(usec: 0))
      create(:product_refund_policy, product: newer, seller:, max_refund_period_in_days: 14, fine_print: nil, updated_at: 1.day.ago.change(usec: 0))
      create(:product_refund_policy, product: archived, seller:)
      create(:product_refund_policy, product:, seller:)
      log_in(seller)

      get_json product_other_refund_policies_path(product.unique_permalink, format: :json)

      expect(response.parsed_body.map { _1["product_name"] }).to eq(["Newer policy product", "Older policy product"])
      expect(response.parsed_body.first).to include("title" => "14-day money back guarantee", "fine_print" => nil)
    end

    it "refuses a seller without access to the product", parity: true do
      other = create(:product, unique_permalink: "notmine")
      log_in(create(:user))

      get_json product_other_refund_policies_path(other.unique_permalink, format: :json)

      expect(response).to have_http_status(:unauthorized)
    end

    it "answers 404 for an unknown product", parity: true do
      log_in(seller)

      get_json product_other_refund_policies_path("nosuchprod", format: :json)

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "available offer codes" do
    let(:product_code) { create(:offer_code, user: seller, products: [product], code: "pcode", name: "Spring sale", valid_at: 5.days.ago.change(usec: 0), created_at: 3.days.ago.change(usec: 0), expires_at: 10.days.from_now.change(usec: 0)) }
    let(:percent_code) { create(:percentage_offer_code, user: seller, products: [product], code: "half", name: "Half off", created_at: 2.days.ago.change(usec: 0), minimum_quantity: 2) }
    let(:universal_code) { create(:universal_offer_code, user: seller, code: "everything", name: "Sitewide spring", amount_percentage: 20, amount_cents: nil, currency_type: nil, created_at: 1.day.ago.change(usec: 0)) }

    before do
      product_code
      percent_code
      universal_code
      create(:offer_code, user: seller, products: [product], code: "newbies", new_customers_only: true)
      create(:offer_code, user: seller, products: [product], code: "gone", deleted_at: Time.current)
    end

    it "lists the newest codes first, without new-customer codes", parity: true do
      log_in(seller)
      get_json product_available_offer_codes_path(product.unique_permalink, format: :json)

      expect(response.parsed_body.map { _1["code"] }).to eq(%w[everything half pcode])
      expect(response.parsed_body.last["discount"]).to include("type" => "fixed", "cents" => 100)
    end

    it "filters by a name fragment", parity: true do
      log_in(seller)
      get_json product_available_offer_codes_path(product.unique_permalink, format: :json), query: " SPRING "

      expect(response.parsed_body.map { _1["code"] }).to eq(%w[everything pcode])
    end

    it "caps the unfiltered list at five", parity: true do
      log_in(seller)
      4.times { |i| create(:offer_code, user: seller, products: [product], code: "extra#{i}", created_at: (10 + i).days.ago.change(usec: 0)) }

      get_json product_available_offer_codes_path(product.unique_permalink, format: :json)

      expect(response.parsed_body.size).to eq(5)
    end

    it "refuses a role that cannot edit the product", parity: true do
      team_member(TeamMembership::ROLE_SUPPORT)

      get_json product_available_offer_codes_path(product.unique_permalink, format: :json)

      expect(response).to have_http_status(:unauthorized)
    end
  end
end
