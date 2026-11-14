# frozen_string_literal: true

require "spec_helper"

# Posting, editing and removing chat messages, moving the read marker and saving the recap frequency the way the Inertia page does
# (JSON body, X-Inertia, the CSRF token in a header), recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/content-delivery-mutations.replay.test.ts, which sends the last request of each example.
describe "Communities mutations when signed in", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Community Seller") }
  let(:buyer) { create(:user, name: "Community Buyer") }
  let(:outsider) { create(:user, name: "Community Outsider") }
  let(:product) { create(:product, user: seller, name: "Community course", community_chat_enabled: true) }
  let!(:community) { create(:community, resource: product, seller:) }
  let(:started_at) { Time.current.beginning_of_minute - 5.hours }
  let(:inertia_headers) do
    { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml", "Content-Type" => "application/json",
      "Referer" => "http://#{DOMAIN}/communities" }
  end

  before do
    host! DOMAIN
    create(:free_purchase, link: product, purchaser: buyer, email: buyer.email)
  end

  def post_message(content, at:, user: seller)
    create(:community_chat_message, community:, user:, content:, created_at: at, updated_at: at)
  end

  def send_json(method, path, body = {})
    token = csrf_token
    public_send(method, path, params: body.to_json, headers: inertia_headers.merge("X-CSRF-Token" => token))
  end

  def community_url = community_path(seller.external_id, community.external_id)

  describe "chat messages" do
    it "posts a message as the seller", parity: true do
      log_in(seller)

      send_json(:post, community_chat_messages_path(community.external_id), community_chat_message: { content: "Welcome everyone" })

      expect(response).to redirect_to(community_url)
      expect(response).to have_http_status(:see_other)
      expect(CommunityChatMessage.last).to have_attributes(content: "Welcome everyone", user_id: seller.id)
    end

    it "posts a message as a buyer who bought the product", parity: true do
      log_in(buyer)

      send_json(:post, community_chat_messages_path(community.external_id), community_chat_message: { content: "Hello from a buyer" })

      expect(response).to redirect_to(community_url)
      expect(CommunityChatMessage.last.user_id).to eq(buyer.id)
    end

    it "answers with the validation error for an empty message", parity: true do
      log_in(seller)

      send_json(:post, community_chat_messages_path(community.external_id), community_chat_message: { content: "" })

      expect(response).to redirect_to(community_url)
      expect(flash[:alert]).to eq("Content can't be blank and Content is too short (minimum is 1 character)")
      expect(CommunityChatMessage.count).to eq(0)
    end

    it "answers with the validation error for a message that is too long", parity: true do
      log_in(seller)

      send_json(:post, community_chat_messages_path(community.external_id), community_chat_message: { content: "a" * 20_001 })

      expect(response).to redirect_to(community_url)
      expect(flash[:alert]).to eq("Content is too long (maximum is 20000 characters)")
    end

    it "sends a visitor who cannot access the community to the dashboard", parity: true do
      log_in(outsider)

      send_json(:post, community_chat_messages_path(community.external_id), community_chat_message: { content: "Let me in" })

      expect(response).to redirect_to(dashboard_path)
      expect(CommunityChatMessage.count).to eq(0)
    end

    it "answers 404 for an unknown community", parity: true do
      log_in(seller)

      send_json(:post, community_chat_messages_path("nope"), community_chat_message: { content: "Hello" })

      expect(response).to have_http_status(:not_found)
    end

    it "edits the author's own message", parity: true do
      message = post_message("First draft", at: started_at)
      log_in(seller)

      send_json(:patch, community_chat_message_path(community.external_id, message.external_id), community_chat_message: { content: "Second draft" })

      expect(response).to redirect_to(community_url)
      expect(message.reload.content).to eq("Second draft")
    end

    it "refuses to edit another user's message", parity: true do
      message = post_message("Seller note", at: started_at)
      log_in(buyer)

      send_json(:put, community_chat_message_path(community.external_id, message.external_id), community_chat_message: { content: "Hijacked" })

      expect(response).to redirect_to(dashboard_path)
      expect(message.reload.content).to eq("Seller note")
    end

    it "answers with the validation error when an edit empties the message", parity: true do
      message = post_message("First draft", at: started_at)
      log_in(seller)

      send_json(:patch, community_chat_message_path(community.external_id, message.external_id), community_chat_message: { content: "" })

      expect(response).to redirect_to(community_url)
      expect(message.reload.content).to eq("First draft")
    end

    it "removes the author's own message", parity: true do
      message = post_message("Oops", at: started_at, user: buyer)
      log_in(buyer)

      send_json(:delete, community_chat_message_path(community.external_id, message.external_id))

      expect(response).to redirect_to(community_url)
      expect(message.reload.deleted_at).to be_present
    end

    it "lets the seller remove a buyer's message", parity: true do
      message = post_message("Spam", at: started_at, user: buyer)
      log_in(seller)

      send_json(:delete, community_chat_message_path(community.external_id, message.external_id))

      expect(response).to redirect_to(community_url)
      expect(message.reload.deleted_at).to be_present
    end

    it "refuses to remove another buyer's message", parity: true do
      other = create(:user, name: "Other Buyer")
      create(:free_purchase, link: product, purchaser: other, email: other.email)
      message = post_message("Seller note", at: started_at)
      log_in(other)

      send_json(:delete, community_chat_message_path(community.external_id, message.external_id))

      expect(response).to redirect_to(dashboard_path)
      expect(message.reload.deleted_at).to be_nil
    end
  end

  describe "last read message" do
    it "records the first read marker", parity: true do
      message = post_message("Welcome", at: started_at)
      log_in(buyer)

      send_json(:post, community_last_read_chat_message_path(community.external_id), message_id: message.external_id)

      expect(response).to redirect_to(community_url)
      expect(LastReadCommunityChatMessage.last).to have_attributes(user_id: buyer.id, community_chat_message_id: message.id)
    end

    it "moves the marker forward", parity: true do
      first = post_message("One", at: started_at)
      second = post_message("Two", at: started_at + 5.minutes)
      create(:last_read_community_chat_message, user: buyer, community:, community_chat_message: first)
      log_in(buyer)

      send_json(:post, community_last_read_chat_message_path(community.external_id), message_id: second.external_id)

      expect(response).to redirect_to(community_url)
      expect(LastReadCommunityChatMessage.find_by(user: buyer).community_chat_message_id).to eq(second.id)
    end

    it "leaves the marker where it is for an older message", parity: true do
      first = post_message("One", at: started_at)
      second = post_message("Two", at: started_at + 5.minutes)
      create(:last_read_community_chat_message, user: buyer, community:, community_chat_message: second)
      log_in(buyer)

      send_json(:post, community_last_read_chat_message_path(community.external_id), message_id: first.external_id)

      expect(response).to redirect_to(community_url)
      expect(LastReadCommunityChatMessage.find_by(user: buyer).community_chat_message_id).to eq(second.id)
    end

    it "answers 404 for a message that is not in the community", parity: true do
      log_in(buyer)

      send_json(:post, community_last_read_chat_message_path(community.external_id), message_id: "nope")

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "notification settings" do
    it "creates the setting", parity: true do
      log_in(buyer)

      send_json(:put, community_notification_settings_path(community.external_id), recap_frequency: "weekly")

      expect(response).to redirect_to(community_url)
      expect(flash[:notice]).to eq("Changes saved!")
      expect(CommunityNotificationSetting.find_by(user: buyer, seller:).recap_frequency).to eq("weekly")
    end

    it "updates the setting", parity: true do
      create(:community_notification_setting, user: buyer, seller:, recap_frequency: "weekly")
      log_in(buyer)

      send_json(:patch, community_notification_settings_path(community.external_id), recap_frequency: "daily")

      expect(response).to redirect_to(community_url)
      expect(CommunityNotificationSetting.find_by(user: buyer, seller:).recap_frequency).to eq("daily")
    end

    it "turns the recap off", parity: true do
      create(:community_notification_setting, user: buyer, seller:, recap_frequency: "weekly")
      log_in(buyer)

      send_json(:patch, community_notification_settings_path(community.external_id), recap_frequency: nil)

      expect(response).to redirect_to(community_url)
      expect(CommunityNotificationSetting.find_by(user: buyer, seller:).recap_frequency).to be_nil
    end

    it "sends a visitor who cannot access the community to the dashboard", parity: true do
      log_in(outsider)

      send_json(:put, community_notification_settings_path(community.external_id), recap_frequency: "daily")

      expect(response).to redirect_to(dashboard_path)
      expect(CommunityNotificationSetting.count).to eq(0)
    end
  end
end
