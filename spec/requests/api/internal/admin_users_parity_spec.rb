# frozen_string_literal: true

require "spec_helper"

# Api::Internal::Admin::UsersController through the whole stack, on the API host with a per-actor token. Recorded for the Next.js
# port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/ws18u-admin-users.replay.test.ts. The "hands a ..." examples are
# requests the port leaves to Rails: the replay asserts they reach the stand-in Rails untouched and write nothing.
describe "Internal admin API users", type: :request do
  let(:admin) { create(:admin_user, name: "Admin User", email: "admin@example.com") }
  let(:headers) { { "Authorization" => "Bearer per-actor-token", "Host" => API_DOMAIN } }
  let(:user) { create(:user, email: "seller@example.com") }

  before do
    create(:admin_api_token, actor_user: admin, token_hash: AdminApiToken.hash_token("per-actor-token"))
  end

  describe "GET affiliates" do
    it "lists the affiliates a seller granted, newest first", parity: true do
      affiliate_user = create(:user, email: "affiliate@example.com", name: "Affiliate Person")
      product = create(:product, user:, name: "Guide")
      direct = create(:direct_affiliate, seller: user, affiliate_user:, affiliate_basis_points: 1000, products: [product], created_at: 2.hours.ago)
      collaborator = create(:collaborator, seller: user, affiliate_user: create(:user, email: "collab@example.com"), apply_to_all_products: true, affiliate_basis_points: 2000, created_at: 1.hour.ago)

      get "/internal/admin/users/affiliates", params: { user_id: user.external_id, direction: "granted" }, headers: headers

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["affiliates"].map { _1["id"] }).to eq([collaborator.external_id, direct.external_id])
    end

    it "lists the sellers a user is an affiliate for", parity: true do
      seller = create(:user, email: "owner@example.com", username: "owner")
      create(:direct_affiliate, seller:, affiliate_user: user, affiliate_basis_points: 500, products: [create(:product, user: seller)])

      get "/internal/admin/users/affiliates", params: { user_id: user.external_id, direction: "received" }, headers: headers

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["affiliates"].sole["counterparty"]["email"]).to eq("owner@example.com")
    end

    it "pages the affiliates with a signed cursor", parity: true do
      3.times { |index| create(:direct_affiliate, seller: user, affiliate_user: create(:user), products: [create(:product, user:)], created_at: (index + 1).hours.ago) }

      get "/internal/admin/users/affiliates", params: { user_id: user.external_id, direction: "granted", limit: 2 }, headers: headers
      cursor = response.parsed_body["pagination"]["next"]
      get "/internal/admin/users/affiliates", params: { user_id: user.external_id, direction: "granted", limit: 2, cursor: }, headers: headers

      expect(response.parsed_body["affiliates"].length).to eq(1)
    end
  end

  describe "GET compliance_info" do
    it "reads the compliance info of a seller whose address has no state", parity: true do
      create(:user_compliance_info, user:, state: nil, individual_tax_id: "123-45-6789", nationality: "US")

      get "/internal/admin/users/compliance_info", params: { user_id: user.external_id }, headers: headers

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["compliance_info"]["tax_ids"]).to eq("individual_last_four" => "6789", "business_last_four" => nil)
    end

    it "lists the open info requests of a user with no compliance info", parity: true do
      create(:user_compliance_info_request, user:, field_needed: UserComplianceInfoFields::Individual::TAX_ID, state: "requested", due_at: 3.days.ago, created_at: 5.days.ago)
      create(:user_compliance_info_request, user:, field_needed: UserComplianceInfoFields::Individual::FIRST_NAME, state: "provided", provided_at: 1.day.ago)

      get "/internal/admin/users/compliance_info", params: { user_id: user.external_id }, headers: headers

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["info_requests"].sole["overdue"]).to be(true)
    end

    it "reads a compliance info address with a state", parity: true do
      create(:user_compliance_info, user:, state: "California")

      get "/internal/admin/users/compliance_info", params: { user_id: user.external_id }, headers: headers

      expect(response.parsed_body["compliance_info"]["address"]["state_code"]).to eq("CA")
    end

    it "reads a business address with a state", parity: true do
      create(:user_compliance_info_business, user:, state: nil, business_state: "California")

      get "/internal/admin/users/compliance_info", params: { user_id: user.external_id }, headers: headers

      expect(response.parsed_body["compliance_info"]["business_address"]["state_code"]).to eq("CA")
    end
  end

  describe "GET unpaid_balance" do
    it "adds up what is still refundable on purchases credited to an unpaid balance", parity: true do
      create(:merchant_account, user: nil)
      product = create(:product, user:)
      balance = create(:balance, user:)
      purchase = build(:purchase, seller: user, link: product, price_cents: 1500, gumroad_tax_cents: 200, purchase_state: "successful", purchase_success_balance: balance)
      purchase.save!(validate: false)
      build(:refund, purchase:, amount_cents: 500, gumroad_tax_cents: 100).save!(validate: false)

      get "/internal/admin/users/unpaid_balance", params: { user_id: user.external_id }, headers: headers

      expect(response.parsed_body).to include("count" => 1, "total_amount_cents" => 1100, "currency" => "usd")
    end
  end

  describe "POST update_watch" do
    it "changes the threshold and notes of the active watch", parity: true do
      create(:watched_user, user:, revenue_threshold_cents: 20_000, notes: "Old note")

      post "/internal/admin/users/update_watch", params: { user_id: user.external_id, revenue_threshold: "350.505", notes: "New note" }, headers: headers

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["watched_user"]).to include("revenue_threshold_cents" => 35_051, "notes" => "New note")
    end

    it "writes nothing when the watch already has the threshold and notes", parity: true do
      create(:watched_user, user:, revenue_threshold_cents: 20_000, notes: "Same")

      post "/internal/admin/users/update_watch", params: { user_id: user.external_id, revenue_threshold: "200", notes: "Same" }, headers: headers

      expect(response).to have_http_status(:ok)
    end

    it "reads a threshold written with an exponent", parity: true do
      create(:watched_user, user:)

      post "/internal/admin/users/update_watch", params: { user_id: user.external_id, revenue_threshold: "1e2" }, headers: headers

      expect(response.parsed_body["watched_user"]["revenue_threshold_cents"]).to eq(10_000)
    end
  end

  describe "POST unwatch" do
    it "removes the user from the watchlist", parity: true do
      create(:watched_user, user:)

      post "/internal/admin/users/unwatch", params: { user_id: user.external_id }, headers: headers

      expect(response).to have_http_status(:ok)
      expect(user.reload.active_watched_user).to be_nil
    end
  end

  describe "POST watch" do
    it "hands a new watch to Rails", parity: true do
      post "/internal/admin/users/watch", params: { user_id: user.external_id, revenue_threshold: "200", notes: "Review" }, headers: headers

      expect(response).to have_http_status(:ok)
      expect(user.reload.active_watched_user.revenue_threshold_cents).to eq(20_000)
    end

    it "refuses a user who is already being watched", parity: true do
      create(:watched_user, user:)

      post "/internal/admin/users/watch", params: { user_id: user.external_id, revenue_threshold: "200" }, headers: headers

      expect(response).to have_http_status(:unprocessable_entity)
    end
  end
end
