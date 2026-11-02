# frozen_string_literal: true

require "spec_helper"

# The read side of the store Agent chat (Api::Internal::AgentConversationsController), recorded for the Next.js port (PARITY_RECORD=1) and
# replayed by nextjs/parity/__tests__/internal-api.replay.test.ts, which sends the last request of each example. "hands a ..." examples are
# requests the port hands back to Rails.
describe "Internal agent conversations", type: :request, elasticsearch_wait_for_refresh: true do
  include Parity::AudienceSignedIn

  JSON_ACCEPT_AGENT = { "Accept" => "application/json" }.freeze

  let(:seller) { create(:user, name: "Agent Seller") }

  before do
    host! DOMAIN
    Purchase.__elasticsearch__.create_index!(force: true)
    $redis.flushdb
  end

  # User#eligible_for_store_agent?: a completed payout and $100 of sales in the purchases index.
  def earn_access(user)
    create(:payment_completed, user:)
    product = create(:product, user:, name: "Earner", unique_permalink: "earner", created_at: Time.utc(2025, 1, 1))
    build(:purchase, link: product, seller: user, price_cents: 20_000).tap { |row| row.save!(validate: false) }
    index_model_records(Purchase)
  end

  def conversation_with(*messages, title: "Sales questions", **attributes)
    conversation = create(:ai_conversation, seller:, title:, **attributes)
    messages.each { |message| create(:ai_message, ai_conversation: conversation, **message) }
    conversation
  end

  def get_json(path, params = {}) = get(path, params:, headers: JSON_ACCEPT_AGENT)

  def log_in_as_member(role)
    member = create(:user, name: "#{role.to_s.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  describe "GET /internal/agent/conversations/latest" do
    it "answers no conversation for a seller who never chatted", parity: true do
      earn_access(seller)
      log_in(seller)

      get_json("/internal/agent/conversations/latest")

      expect(response.parsed_body).to eq("success" => true, "conversation" => nil)
    end

    it "resumes the conversation touched last with its transcript", parity: true do
      earn_access(seller)
      older = conversation_with({ content: "Older question" }, title: "Older")
      older.update_columns(updated_at: Time.utc(2025, 2, 1))
      conversation_with(
        { content: "How are my sales doing?" },
        { role: "assistant", content: "You made $200.", metadata: { objects: [{ type: "product", name: "Earner" }] } },
        { content: "Make a code" },
        { role: "assistant", content: "Shall I?", metadata: { proposed_action: { endpoint: "create_offer_code", params: { name: "LAUNCH" } }, action_status: "applied", objects: [] } },
      )
      log_in(seller)

      get_json("/internal/agent/conversations/latest")

      expect(response.parsed_body["conversation"]["title"]).to eq("Sales questions")
      expect(response.parsed_body["conversation"]["messages"].size).to eq(4)
    end

    it "hydrates only the newest hundred messages", parity: true do
      earn_access(seller)
      conversation = create(:ai_conversation, seller:, title: "Long chat")
      (1..102).each { |index| create(:ai_message, ai_conversation: conversation, content: "Message #{index}", created_at: Time.utc(2025, 3, 1) + index.minutes) }
      log_in(seller)

      get_json("/internal/agent/conversations/latest")

      messages = response.parsed_body["conversation"]["messages"]
      expect(messages.size).to eq(100)
      expect(messages.first["content"]).to eq("Message 3")
    end

    it "skips a deleted conversation", parity: true do
      earn_access(seller)
      conversation_with({ content: "Gone" }, title: "Deleted", deleted_at: Time.utc(2025, 2, 1))
      log_in(seller)

      get_json("/internal/agent/conversations/latest")

      expect(response.parsed_body["conversation"]).to be_nil
    end

    it "does not show another seller's conversation", parity: true do
      earn_access(seller)
      create(:ai_conversation, seller: create(:user), title: "Theirs")
      log_in(seller)

      get_json("/internal/agent/conversations/latest")

      expect(response.parsed_body["conversation"]).to be_nil
    end

    it "lets an admin team member resume the chat", parity: true do
      earn_access(seller)
      conversation_with({ content: "Hello" })
      log_in_as_member(TeamMembership::ROLE_ADMIN)

      get_json("/internal/agent/conversations/latest")

      expect(response.parsed_body["conversation"]["messages"].size).to eq(1)
    end

    it "answers 401 JSON to a seller who has not earned access", parity: true do
      log_in(seller)

      get_json("/internal/agent/conversations/latest")

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body["success"]).to be(false)
    end

    it "answers 401 JSON to a support team member", parity: true do
      earn_access(seller)
      log_in_as_member(TeamMembership::ROLE_SUPPORT)

      get_json("/internal/agent/conversations/latest")

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body["error"]).to eq("Your current role as Support cannot perform this action.")
    end

    it "answers 404 JSON to a signed-out visitor", parity: true do
      get_json("/internal/agent/conversations/latest")

      expect(response).to have_http_status(:not_found)
    end

    it "hands a conversation with a proposal still executing to Rails", parity: true do
      earn_access(seller)
      conversation_with({ role: "assistant", content: "Working", metadata: { proposed_action: { endpoint: "x" }, action_status: "executing" } })
      log_in(seller)

      get_json("/internal/agent/conversations/latest")

      expect(response).to have_http_status(:ok)
    end
  end

  describe "GET /internal/agent/actions/status" do
    let(:proposal) do
      conversation_with({ role: "assistant", content: "Shall I?", metadata: { proposed_action: { endpoint: "create_offer_code" }, objects: [{ type: "code" }] } }).ai_messages.first
    end

    it "reports a proposal as pending", parity: true do
      earn_access(seller)
      log_in(seller)

      get_json("/internal/agent/actions/status", proposal_message_id: proposal.external_id)

      expect(response.parsed_body).to eq("success" => true, "action_status" => "pending", "objects" => [{ "type" => "code" }])
    end

    it "reports an applied proposal", parity: true do
      earn_access(seller)
      proposal.update!(metadata: proposal.metadata.merge("action_status" => "applied"))
      log_in(seller)

      get_json("/internal/agent/actions/status", proposal_message_id: proposal.external_id)

      expect(response.parsed_body["action_status"]).to eq("applied")
    end

    it "answers 404 for a message without a proposal", parity: true do
      earn_access(seller)
      plain = conversation_with({ role: "assistant", content: "Just text" }).ai_messages.first
      log_in(seller)

      get_json("/internal/agent/actions/status", proposal_message_id: plain.external_id)

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for another seller's proposal", parity: true do
      earn_access(seller)
      other = create(:ai_conversation, seller: create(:user))
      foreign = create(:ai_message, ai_conversation: other, role: "assistant", metadata: { proposed_action: { endpoint: "x" } })
      log_in(seller)

      get_json("/internal/agent/actions/status", proposal_message_id: foreign.external_id)

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a user message", parity: true do
      earn_access(seller)
      user_message = conversation_with({ content: "Question", metadata: { proposed_action: { endpoint: "x" } } }).ai_messages.first
      log_in(seller)

      get_json("/internal/agent/actions/status", proposal_message_id: user_message.external_id)

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 without a proposal id", parity: true do
      earn_access(seller)
      log_in(seller)

      get_json("/internal/agent/actions/status")

      expect(response).to have_http_status(:not_found)
    end

    it "hands a proposal still executing to Rails", parity: true do
      earn_access(seller)
      proposal.update!(metadata: proposal.metadata.merge("action_status" => "executing"))
      log_in(seller)

      get_json("/internal/agent/actions/status", proposal_message_id: proposal.external_id)

      expect(response).to have_http_status(:ok)
    end
  end

  describe "GET /internal/agent/turns/:client_turn_id" do
    let(:turn_id) { "3f2b7c1e-8d4a-4f6b-9a10-5c2d7e8f9a0b" }

    it "returns the persisted turn", parity: true do
      earn_access(seller)
      conversation = conversation_with({ role: "assistant", content: "Done", metadata: { client_turn_id: turn_id, objects: [] } })
      log_in(seller)

      get_json("/internal/agent/turns/#{turn_id}")

      expect(response.parsed_body).to include("success" => true, "status" => "persisted", "conversation_id" => conversation.external_id)
    end

    it "does not look further back than an hour", parity: true do
      earn_access(seller)
      conversation = create(:ai_conversation, seller:)
      create(:ai_message, ai_conversation: conversation, role: "assistant", content: "Old", metadata: { client_turn_id: turn_id }, created_at: 2.hours.ago)
      log_in(seller)

      get_json("/internal/agent/turns/#{turn_id}")

      expect(response.parsed_body).to eq("success" => true, "status" => "unknown")
    end

    it "reports a turn that is still generating", parity: true do
      earn_access(seller)
      log_in(seller)
      $redis.set(RedisKey.agent_turn_status(seller.id, turn_id), "in_progress", ex: 180)

      get_json("/internal/agent/turns/#{turn_id}")

      expect(response.parsed_body).to eq("success" => true, "status" => "in_progress")
    end

    it "reports a turn that failed", parity: true do
      earn_access(seller)
      log_in(seller)
      $redis.set(RedisKey.agent_turn_status(seller.id, turn_id), "failed", ex: 600)

      get_json("/internal/agent/turns/#{turn_id}")

      expect(response.parsed_body).to eq("success" => true, "status" => "failed")
    end

    it "reports a turn nobody has heard of as unknown", parity: true do
      earn_access(seller)
      log_in(seller)
      $redis.set(RedisKey.agent_turn_status(seller.id, turn_id), "something-else")

      get_json("/internal/agent/turns/#{turn_id}")

      expect(response.parsed_body).to eq("success" => true, "status" => "unknown")
    end

    it "answers 400 for a malformed turn id", parity: true do
      earn_access(seller)
      log_in(seller)

      get_json("/internal/agent/turns/not-hex")

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body).to eq("success" => false, "error" => "Invalid turn id.")
    end

    it "does not return another seller's turn", parity: true do
      earn_access(seller)
      other = create(:ai_conversation, seller: create(:user))
      create(:ai_message, ai_conversation: other, role: "assistant", metadata: { client_turn_id: turn_id })
      log_in(seller)

      get_json("/internal/agent/turns/#{turn_id}")

      expect(response.parsed_body["status"]).to eq("unknown")
    end

    it "answers 401 JSON to a seller who has not earned access", parity: true do
      log_in(seller)

      get_json("/internal/agent/turns/#{turn_id}")

      expect(response).to have_http_status(:unauthorized)
    end
  end
end
