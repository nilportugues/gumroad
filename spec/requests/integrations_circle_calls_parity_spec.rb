# frozen_string_literal: true

require "spec_helper"

# Integrations::CircleController when the request carries an API key: the calls to the Circle API behind the setup form, recorded for the
# Next.js port (PARITY_RECORD=1) with Circle stubbed by WebMock. The fixture keeps each call Rails made, and
# nextjs/parity/__tests__/integrations-providers.replay.test.ts replays the last request of each example against a stand-in that answers
# them in order and compares the calls Node makes. The guards that answer before Circle is asked are in integrations_circle_parity_spec.rb.
describe "Circle integration API calls", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:named_seller, name: "Circle Seller") }
  let(:json) { { "Accept" => "application/json" } }
  let(:json_headers) { { "Content-Type" => "application/json" } }
  let(:communities) { [{ id: 11, name: "Makers", slug: "makers", owner_id: 5 }, { id: 12, name: "Readers", extra: true }] }
  let(:groups) { [{ id: 21, name: "Paid", position: 1 }, { id: 22, name: "Free" }] }
  let(:base) { "https://app.circle.so/api/v1" }

  before do
    host! DOMAIN
    log_in(seller)
  end

  def stub_communities(status: 200, body: communities.to_json, headers: json_headers)
    WebMock.stub_request(:get, "#{base}/communities").with(headers: { "Authorization" => "Token circle-key" }).to_return(status:, headers:, body:)
  end

  def stub_groups(status: 200, body: groups.to_json, headers: json_headers)
    WebMock.stub_request(:get, "#{base}/space_groups").with(query: { community_id: "7" }, headers: { "Authorization" => "Token circle-key" }).to_return(status:, headers:, body:)
  end

  describe "GET /integrations/circle/communities" do
    def request_communities(params = { api_key: "circle-key" }) = get("/integrations/circle/communities", params:, headers: json)

    it "lists the name and id of each community", parity: true do
      stub_communities

      request_communities

      expect(response.parsed_body).to eq("success" => true, "communities" => [{ "name" => "Makers", "id" => 11 }, { "name" => "Readers", "id" => 12 }])
    end

    it "lists no communities for an empty list", parity: true do
      stub_communities(body: "[]")

      request_communities

      expect(response.parsed_body).to eq("success" => true, "communities" => [])
    end

    it "fails when Circle refuses the API key", parity: true do
      stub_communities(status: 401, body: { error: "Unauthorized" }.to_json)

      request_communities

      expect(response.parsed_body).to eq("success" => false)
    end

    it "fails when Circle answers an object instead of a list", parity: true do
      stub_communities(body: { communities: }.to_json)

      request_communities

      expect(response.parsed_body).to eq("success" => false)
    end

    it "fails when Circle answers text", parity: true do
      stub_communities(body: "[]", headers: { "Content-Type" => "text/plain" })

      request_communities

      expect(response.parsed_body).to eq("success" => false)
    end
  end

  describe "GET /integrations/circle/space_groups" do
    def request_groups(params = { api_key: "circle-key", community_id: "7" }) = get("/integrations/circle/space_groups", params:, headers: json)

    it "lists the name and id of each space group", parity: true do
      stub_groups

      request_groups

      expect(response.parsed_body).to eq("success" => true, "space_groups" => [{ "name" => "Paid", "id" => 21 }, { "name" => "Free", "id" => 22 }])
    end

    it "escapes the community in the query", parity: true do
      WebMock.stub_request(:get, "#{base}/space_groups").with(query: { community_id: "a b&c" }).to_return(status: 200, headers: json_headers, body: groups.to_json)

      request_groups(api_key: "circle-key", community_id: "a b&c")

      expect(response.parsed_body["success"]).to be(true)
    end

    it "fails when Circle refuses the request", parity: true do
      stub_groups(status: 404, body: {}.to_json)

      request_groups

      expect(response.parsed_body).to eq("success" => false)
    end

    it "fails when Circle answers an object instead of a list", parity: true do
      stub_groups(body: { space_groups: groups }.to_json)

      request_groups

      expect(response.parsed_body).to eq("success" => false)
    end
  end

  describe "GET /integrations/circle/communities_and_space_groups" do
    def request_both(params = { api_key: "circle-key", community_id: "7" }) = get("/integrations/circle/communities_and_space_groups", params:, headers: json)

    it "lists the communities and the space groups", parity: true do
      stub_communities
      stub_groups

      request_both

      expect(response.parsed_body).to eq("success" => true, "communities" => [{ "name" => "Makers", "id" => 11 }, { "name" => "Readers", "id" => 12 }],
                                         "space_groups" => [{ "name" => "Paid", "id" => 21 }, { "name" => "Free", "id" => 22 }])
    end

    it "asks for the space groups even when the communities call fails", parity: true do
      stub_communities(status: 500, body: "")
      stub_groups

      request_both

      expect(response.parsed_body).to eq("success" => false)
    end

    it "fails when the space groups call fails", parity: true do
      stub_communities
      stub_groups(status: 422, body: {}.to_json)

      request_both

      expect(response.parsed_body).to eq("success" => false)
    end

    it "fails when the communities answer is not a list", parity: true do
      stub_communities(body: { communities: }.to_json)
      stub_groups

      request_both

      expect(response.parsed_body).to eq("success" => false)
    end
  end
end
