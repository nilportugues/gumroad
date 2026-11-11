# frozen_string_literal: true

require "spec_helper"

# Integrations::CircleController, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/ws10-triage.replay.test.ts, which sends the last request of each example. An example named "hands ..." is one Node
# leaves to Rails: the replay asserts it reached Rails and wrote nothing.
describe "Circle integration setup calls", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:named_seller, name: "Circle Seller") }
  let(:json) { { "Accept" => "application/json" } }
  let(:unsuccessful) { instance_double(HTTParty::Response, success?: false) }

  before do
    host! DOMAIN
    log_in(seller)
  end

  describe "GET /integrations/circle/communities" do
    it "answers failure without asking Circle when the API key is missing", parity: true do
      get "/integrations/circle/communities", headers: json

      expect(response.parsed_body).to eq("success" => false)
    end

    it "answers failure for a blank API key", parity: true do
      get "/integrations/circle/communities", params: { api_key: "  " }, headers: json

      expect(response.parsed_body).to eq("success" => false)
    end

    it "hands a request with an API key to Rails", parity: true do
      allow_any_instance_of(CircleApi).to receive(:get_communities).and_return(unsuccessful)

      get "/integrations/circle/communities", params: { api_key: "circle-key" }, headers: json

      expect(response.parsed_body).to eq("success" => false)
    end
  end

  describe "GET /integrations/circle/space_groups" do
    it "answers failure when the community is missing", parity: true do
      get "/integrations/circle/space_groups", params: { api_key: "circle-key" }, headers: json

      expect(response.parsed_body).to eq("success" => false)
    end

    it "answers failure when the API key is missing", parity: true do
      get "/integrations/circle/space_groups", params: { community_id: "7" }, headers: json

      expect(response.parsed_body).to eq("success" => false)
    end

    it "hands a request with a community and an API key to Rails", parity: true do
      allow_any_instance_of(CircleApi).to receive(:get_space_groups).and_return(unsuccessful)

      get "/integrations/circle/space_groups", params: { api_key: "circle-key", community_id: "7" }, headers: json

      expect(response.parsed_body).to eq("success" => false)
    end
  end

  describe "GET /integrations/circle/communities_and_space_groups" do
    it "answers failure when both are missing", parity: true do
      get "/integrations/circle/communities_and_space_groups", headers: json

      expect(response.parsed_body).to eq("success" => false)
    end

    it "answers failure when the community is blank", parity: true do
      get "/integrations/circle/communities_and_space_groups", params: { api_key: "circle-key", community_id: "" }, headers: json

      expect(response.parsed_body).to eq("success" => false)
    end

    it "hands a request with a community and an API key to Rails", parity: true do
      allow_any_instance_of(CircleApi).to receive(:get_communities).and_return(unsuccessful)
      allow_any_instance_of(CircleApi).to receive(:get_space_groups).and_return(unsuccessful)

      get "/integrations/circle/communities_and_space_groups", params: { api_key: "circle-key", community_id: "7" }, headers: json

      expect(response.parsed_body).to eq("success" => false)
    end
  end

  it "hands a request that does not ask for JSON to Rails", parity: true do
    get "/integrations/circle/communities"

    expect(response.parsed_body).to eq("success" => false)
  end
end
