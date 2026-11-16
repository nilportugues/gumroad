# frozen_string_literal: true

require "spec_helper"

# The legacy shared admin token is the first token of the user GUMROAD_ADMIN_ID. The controller specs stub that constant
# to a fresh user's id, which a replayed server cannot reproduce; here the actor really is GUMROAD_ADMIN_ID. Recorded for the
# Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/ws17e-admin-api.replay.test.ts.
describe "Internal admin API with the legacy admin token", type: :request do
  let(:legacy_actor) { create(:admin_user, id: GUMROAD_ADMIN_ID, name: "Admin User", email: "admin@example.com") }
  let(:headers) { { "Authorization" => "Bearer test-admin-token", "Host" => API_DOMAIN } }

  before do
    create(:admin_api_token, actor_user: legacy_actor, token_hash: AdminApiToken.hash_token("test-admin-token"))
  end

  it "answers whoami with a placeholder actor", parity: true do
    get "/internal/admin/whoami", headers: headers

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body["actor"]).to eq("external_id" => nil, "name" => "Legacy internal admin token", "email" => nil)
  end

  it "refuses an endpoint that needs a per-actor token", parity: true do
    post "/internal/admin/stranded_buyers/recover", params: { email: "buyer@example.com" }, headers: headers

    expect(response).to have_http_status(:unauthorized)
    expect(response.parsed_body).to eq("success" => false, "message" => "per-actor admin token is required")
  end

  it "accepts the legacy token on an endpoint that does not need a per-actor token", parity: true do
    get "/internal/admin/stranded_buyers/scan", headers: headers

    expect(response).to have_http_status(:ok)
  end
end
