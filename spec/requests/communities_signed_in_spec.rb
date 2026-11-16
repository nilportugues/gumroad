# frozen_string_literal: true

require "spec_helper"

# Signed-in visits to the Communities pages, recorded for the Next.js port (PARITY_RECORD=1) and replayed
# by nextjs/parity/__tests__/communities.replay.test.ts, which sends the last request of each example.
describe "Communities pages when signed in", type: :request do
  include Parity::SignedInDashboard

  let(:seller) { create(:user, name: "Community Seller") }
  let(:buyer) { create(:user, name: "Community Buyer") }
  let(:product) { create(:product, user: seller, name: "Community course", community_chat_enabled: true) }
  let!(:community) { create(:community, resource: product, seller:) }

  def post_message(content, at:, user: seller)
    create(:community_chat_message, community:, user:, content:, created_at: at, updated_at: at)
  end

  def scroll_headers(intent)
    { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "X-Inertia-Partial-Component" => "Communities/Index",
      "X-Inertia-Partial-Data" => "messages", "X-Inertia-Infinite-Scroll-Merge-Intent" => intent }
  end

  # Times are recorded as offsets from the request, rounded to the minute from a day on, so messages stay a
  # minute apart and within a day of it.
  let(:started_at) { Time.current.beginning_of_minute - 5.hours }

  def many_messages(count = 120)
    Array.new(count) { |i| post_message("Message #{i}", at: started_at + i.minutes, user: i.even? ? seller : buyer) }
  end

  def cursor_at(index) = (started_at + index.minutes).utc.iso8601

  it "sends a signed-out visitor to the login page", parity: true do
    get community_path(seller.external_id, community.external_id)

    expect(response).to have_http_status(:found)
    expect(response.location).to include("/login")
  end

  describe "GET /communities" do
    it "sends a visitor without a community to the dashboard", parity: true do
      log_in(create(:user, name: "No Communities"))

      get communities_path

      expect(response).to redirect_to(dashboard_path)
    end

    it "redirects to the first community", parity: true do
      log_in(seller)

      get communities_path

      expect(response).to redirect_to(community_path(seller.external_id, community.external_id))
    end

    it "redirects a buyer to the first community of a product they bought", parity: true do
      create(:free_purchase, link: product, purchaser: buyer, email: buyer.email)
      log_in(buyer)

      get communities_path

      expect(response).to redirect_to(community_path(seller.external_id, community.external_id))
    end
  end

  describe "GET /communities/:seller_id/:community_id" do
    it "shows the seller's community with its messages, unread counts and notification settings", parity: true do
      post_message("Welcome everyone", at: started_at)
      second = post_message("A question", at: started_at + 5.minutes, user: buyer)
      post_message("Another question", at: started_at + 6.minutes, user: buyer)
      create(:last_read_community_chat_message, user: seller, community:, community_chat_message: second)
      create(:community_notification_setting, user: seller, seller:, recap_frequency: "weekly")
      log_in(seller)

      get community_path(seller.external_id, community.external_id)

      expect(response).to be_successful
      props = inertia_props_of(response)
      expect(props["has_products"]).to be(true)
      expect(props["communities"].first).to include("name" => "Community course", "unread_count" => 1)
      expect(props["selectedCommunityId"]).to eq(community.external_id)
      expect(props["messages"].map { _1["content"] }).to eq(["Welcome everyone", "A question", "Another question"])
    end

    it "shows a buyer a community they can access", parity: true do
      create(:free_purchase, link: product, purchaser: buyer, email: buyer.email)
      post_message("Hello buyers", at: started_at)
      log_in(buyer)

      get community_path(seller.external_id, community.external_id)

      expect(response).to be_successful
      expect(inertia_props_of(response)["communities"].first["unread_count"]).to eq(1)
    end

    it "centers the first load on the cursor", parity: true do
      many_messages
      log_in(seller)

      get community_path(seller.external_id, community.external_id, cursor: cursor_at(60))

      expect(response).to be_successful
      expect(inertia_props_of(response)["messages"].size).to eq(100)
    end

    it "answers an Inertia visit with the page as JSON and the scroll metadata", parity: true do
      many_messages
      log_in(seller)

      inertia_visit community_path(seller.external_id, community.external_id, cursor: cursor_at(60))

      expect(response).to be_successful
      page = JSON.parse(response.body)
      expect(page["scrollProps"]["messages"]).to include("pageName" => "cursor", "reset" => false)
      expect(page["mergeProps"]).to eq(["messages"])
    end

    it "loads older messages for a prepend intent", parity: true do
      many_messages
      log_in(seller)

      get community_path(seller.external_id, community.external_id, cursor: cursor_at(50)), headers: scroll_headers("prepend")

      expect(response).to be_successful
      page = JSON.parse(response.body)
      expect(page["prependProps"]).to eq(["messages"])
      expect(page).not_to have_key("mergeProps")
    end

    it "loads newer messages for an append intent", parity: true do
      many_messages
      log_in(seller)

      get community_path(seller.external_id, community.external_id, cursor: cursor_at(60)), headers: scroll_headers("append")

      expect(response).to be_successful
      expect(JSON.parse(response.body)["mergeProps"]).to eq(["messages"])
    end

    it "marks a reset scroll prop", parity: true do
      many_messages
      log_in(seller)

      get community_path(seller.external_id, community.external_id), headers: scroll_headers("append").merge("X-Inertia-Reset" => "messages")

      expect(response).to be_successful
      page = JSON.parse(response.body)
      expect(page["scrollProps"]["messages"]["reset"]).to be(true)
      expect(page).not_to have_key("mergeProps")
    end

    it "sends a visitor who cannot access the community to the dashboard", parity: true do
      log_in(buyer)

      get community_path(seller.external_id, community.external_id)

      expect(response).to redirect_to(dashboard_path)
    end

    it "answers 404 for a community of another seller", parity: true do
      log_in(seller)

      get community_path(buyer.external_id, community.external_id)

      expect(response).to have_http_status(:not_found)
    end
  end
end
