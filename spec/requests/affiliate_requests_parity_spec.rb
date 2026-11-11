# frozen_string_literal: true

require "spec_helper"

# The guards, redirects and refusals of AffiliateRequestsController that Node answers (#new, #create, #update, #approve, #ignore and
# #approve_all), recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/affiliate-requests.replay.test.ts, which sends the last request of each example. An example named
# "hands a ..." records what Node passes to Rails whole.
describe "AffiliateRequestsController", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:named_seller, name: "Parity Seller") }
  let(:product) { create(:product, user: seller, name: "Affiliate product") }

  before { host! DOMAIN }

  def enable_self_service_products
    create(:self_service_affiliate_product, seller:, product:, enabled: true)
  end

  def affiliate_request_for(owner = seller, state: nil, email: "ada@example.com", name: "Ada Lovelace")
    owner.affiliate_requests.create!(name:, email:, promotion_text: "I have an audience").tap do |request|
      request.update_columns(state:) if state
    end
  end

  def as_team_member(role)
    member = create(:user, name: "#{role.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  # The session is made on the main domain, the request goes to the seller's host.
  def submit_request(on_host: seller.subdomain, **fields)
    token = csrf_token
    host!(on_host)
    post "/affiliate_requests", params: { authenticity_token: token, affiliate_request: fields }
  end

  def send_form(method, path, fields)
    token = csrf_token
    public_send(method, path, params: { authenticity_token: token, affiliate_request: fields })
  end

  describe "GET /:username/affiliates" do
    it "sends the visitor to the seller's subdomain", parity: true do
      enable_self_service_products

      get "/#{seller.username}/affiliates"

      expect(response).to have_http_status(:moved_permanently)
      expect(response.location).to eq("#{PROTOCOL}://#{seller.subdomain}/affiliates")
    end

    it "sends the visitor to the subdomain of a seller with no self-service product", parity: true do
      get "/#{seller.username}/affiliates"

      expect(response).to have_http_status(:moved_permanently)
    end

    it "finds the seller by external id", parity: true do
      get "/#{seller.external_id}/affiliates"

      expect(response).to have_http_status(:moved_permanently)
    end

    it "answers not found for a name nobody owns", parity: true do
      get "/nobody-here/affiliates"

      expect(response).to have_http_status(:not_found)
    end

    it "answers not found for a deleted account", parity: true do
      seller.update_columns(deleted_at: Time.utc(2025, 1, 1))

      get "/#{seller.username}/affiliates"

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "POST /affiliate_requests" do
    before { enable_self_service_products }

    it "lists what is missing from an empty request", parity: true do
      submit_request(name: "", email: "", promotion_text: "")

      expect(response).to redirect_to("http://#{seller.subdomain}/affiliates")
      expect(flash[:alert]).to eq("Name can't be blank, Email can't be blank, Promotion text can't be blank, and Email is invalid")
    end

    it "refuses an email that is not an address", parity: true do
      submit_request(name: "Ada", email: "not-an-email", promotion_text: "I have an audience")

      expect(response).to have_http_status(:found)
      expect(flash[:alert]).to eq("Email is invalid")
    end

    it "refuses a name that is too long", parity: true do
      submit_request(name: "A" * 101, email: "ada@example.com", promotion_text: "I have an audience")

      expect(response).to have_http_status(:found)
      expect(flash[:alert]).to eq("Name Your name is too long. Please try again with a shorter one.")
    end

    it "refuses a second request while the first one is waiting", parity: true do
      affiliate_request_for(email: "ada@example.com")

      submit_request(name: "Ada", email: "ada@example.com", promotion_text: "Again")

      expect(flash[:alert]).to eq("You have already requested to become an affiliate of this creator.")
    end

    it "refuses a second request while the first one is approved", parity: true do
      affiliate_request_for(email: "ada@example.com", state: "approved")

      submit_request(name: "Ada", email: "ADA@example.com", promotion_text: "Again")

      expect(flash[:alert]).to eq("You have already requested to become an affiliate of this creator.")
    end

    it "refuses the seller's own email", parity: true do
      submit_request(name: "Parity Seller", email: seller.email.upcase, promotion_text: "Myself")

      expect(flash[:alert]).to eq("You cannot request to become an affiliate of yourself.")
    end

    it "reads a missing field as blank", parity: true do
      submit_request(name: "Ada", email: "ada@example.com")

      expect(flash[:alert]).to eq("Promotion text can't be blank")
    end

    it "drops a field that is a hash", parity: true do
      submit_request(name: { first: "Ada" }, email: "ada@example.com", promotion_text: "I have an audience")

      expect(flash[:alert]).to eq("Name can't be blank")
    end

    it "answers not found when no self-service product is enabled", parity: true do
      seller.self_service_affiliate_products.update_all(enabled: false)

      submit_request(name: "Ada", email: "ada@example.com", promotion_text: "I have an audience")

      expect(response).to have_http_status(:not_found)
    end

    it "hands a request from a host nobody owns to Rails", parity: true do
      submit_request(on_host: Subdomain.from_username("no-such-seller").split(":").first, name: "Ada", email: "ada@example.com", promotion_text: "Hi")

      expect(response).to have_http_status(:not_found)
    end

    it "hands a valid request to Rails", parity: true do
      submit_request(name: "Ada", email: "ada@example.com", promotion_text: "I have an audience")

      expect(response).to have_http_status(:see_other)
      expect(seller.affiliate_requests.count).to eq(1)
    end

    it "hands a new request to Rails when the earlier one was ignored", parity: true do
      affiliate_request_for(email: "ada@example.com", state: "ignored")

      submit_request(name: "Ada", email: "ada@example.com", promotion_text: "Once more")

      expect(response).to have_http_status(:see_other)
      expect(seller.affiliate_requests.count).to eq(2)
    end

    it "hands a request with no affiliate_request parameter to Rails", parity: true do
      token = csrf_token
      host! seller.subdomain
      post "/affiliate_requests", params: { authenticity_token: token }

      expect(response).to have_http_status(:bad_request)
    end
  end

  describe "PATCH /affiliate_requests/:id" do
    let!(:pending_request) { affiliate_request_for }

    it "says an approved request was already processed when approving again", parity: true do
      pending_request.update_columns(state: "approved")
      log_in(seller)

      send_form(:patch, "/affiliate_requests/#{pending_request.external_id}", { action: "approve" })

      expect(response).to redirect_to("/affiliates")
      expect(flash[:alert]).to eq("Ada Lovelace's affiliate request has been already processed.")
    end

    it "says an ignored request was already processed when ignoring again", parity: true do
      pending_request.update_columns(state: "ignored")
      log_in(seller)

      send_form(:put, "/affiliate_requests/#{pending_request.external_id}", { action: "ignore" })

      expect(flash[:alert]).to eq("Ada Lovelace's affiliate request has been already processed.")
    end

    it "says an approved request was already processed when the requester has an account", parity: true do
      create(:user, email: pending_request.email)
      pending_request.update_columns(state: "approved")
      log_in(seller)

      send_form(:patch, "/affiliate_requests/#{pending_request.external_id}", { action: "ignore" })

      expect(flash[:alert]).to eq("Ada Lovelace's affiliate request has been already processed.")
    end

    it "names an action that does not exist", parity: true do
      log_in(seller)

      send_form(:patch, "/affiliate_requests/#{pending_request.external_id}", { action: "delete" })

      expect(response).to redirect_to("/affiliates")
      expect(flash[:alert]).to eq("delete is not a valid affiliate request action")
    end

    it "reads a missing action as blank", parity: true do
      log_in(seller)

      send_form(:patch, "/affiliate_requests/#{pending_request.external_id}", { other: "approve" })

      expect(flash[:alert]).to eq(" is not a valid affiliate request action")
    end

    it "sends a signed-out visitor to sign in", parity: true do
      send_form(:patch, "/affiliate_requests/#{pending_request.external_id}", { action: "approve" })

      expect(response).to redirect_to("/login?next=%2Faffiliate_requests%2F#{CGI.escape(pending_request.external_id)}")
    end

    it "lets a marketing member answer", parity: true do
      as_team_member(:marketing)

      send_form(:patch, "/affiliate_requests/#{pending_request.external_id}", { action: "delete" })

      expect(flash[:alert]).to eq("delete is not a valid affiliate request action")
    end

    it "refuses a support member", parity: true do
      as_team_member(:support)

      send_form(:patch, "/affiliate_requests/#{pending_request.external_id}", { action: "approve" })

      expect(response).to have_http_status(:found)
      expect(response.location).to end_with("/dashboard")
      expect(flash[:alert]).to eq("Your current role as Support cannot perform this action.")
    end

    it "answers not found for another seller's request", parity: true do
      other_request = affiliate_request_for(create(:user, username: "otherseller", name: "Other Seller"))
      log_in(seller)

      send_form(:patch, "/affiliate_requests/#{other_request.external_id}", { action: "approve" })

      expect(response).to have_http_status(:not_found)
    end

    it "answers not found for an id that does not exist", parity: true do
      log_in(seller)

      send_form(:patch, "/affiliate_requests/not-an-id", { action: "approve" })

      expect(response).to have_http_status(:not_found)
    end

    it "hands a pending request's approval to Rails", parity: true do
      log_in(seller)

      send_form(:patch, "/affiliate_requests/#{pending_request.external_id}", { action: "approve" })

      expect(response).to have_http_status(:see_other)
      expect(flash[:notice]).to eq("Approved Ada Lovelace's request!")
    end

    it "hands a pending request's ignore to Rails", parity: true do
      log_in(seller)

      send_form(:patch, "/affiliate_requests/#{pending_request.external_id}", { action: "ignore" })

      expect(response).to have_http_status(:see_other)
      expect(pending_request.reload.state).to eq("ignored")
    end

    it "hands a request with no affiliate_request parameter to Rails", parity: true do
      log_in(seller)
      token = csrf_token

      patch "/affiliate_requests/#{pending_request.external_id}", params: { authenticity_token: token }

      expect(response).to have_http_status(:bad_request)
    end
  end

  describe "GET /affiliate_requests/:id/approve and /ignore" do
    let!(:pending_request) { affiliate_request_for }

    it "sends a signed-out visitor to sign in", parity: true do
      get "/affiliate_requests/#{pending_request.external_id}/approve"

      expect(response).to redirect_to("/login?next=%2Faffiliate_requests%2F#{CGI.escape(pending_request.external_id)}%2Fapprove")
    end

    it "answers not found for another seller's request", parity: true do
      other_request = affiliate_request_for(create(:user, username: "otherseller", name: "Other Seller"))
      log_in(seller)

      get "/affiliate_requests/#{other_request.external_id}/ignore"

      expect(response).to have_http_status(:not_found)
    end

    it "hands the approval link to Rails", parity: true do
      log_in(seller)

      get "/affiliate_requests/#{pending_request.external_id}/approve"

      expect(response.body).to include(CGI.escapeHTML("Approved Ada Lovelace's affiliate request."))
    end

    it "hands the ignore link of a request that was already processed to Rails", parity: true do
      pending_request.update_columns(state: "ignored")
      log_in(seller)

      get "/affiliate_requests/#{pending_request.external_id}/ignore"

      expect(response.body).to include("has been already processed")
    end
  end

  describe "POST /affiliate_requests/approve_all" do
    it "tells the seller everything is approved when nothing is pending", parity: true do
      log_in(seller)

      send_form(:post, "/affiliate_requests/approve_all", {})

      expect(response).to have_http_status(:see_other)
      expect(flash[:notice]).to eq("Approved all pending affiliate requests!")
    end

    it "does not count requests that were already processed", parity: true do
      affiliate_request_for(state: "approved")
      affiliate_request_for(email: "grace@example.com", state: "ignored")
      log_in(seller)

      send_form(:post, "/affiliate_requests/approve_all", {})

      expect(flash[:notice]).to eq("Approved all pending affiliate requests!")
    end

    it "does not count another seller's pending request", parity: true do
      affiliate_request_for(create(:user, username: "otherseller", name: "Other Seller"))
      log_in(seller)

      send_form(:post, "/affiliate_requests/approve_all", {})

      expect(flash[:notice]).to eq("Approved all pending affiliate requests!")
    end

    it "sends a signed-out visitor to sign in", parity: true do
      send_form(:post, "/affiliate_requests/approve_all", {})

      expect(response).to redirect_to("/login?next=%2Faffiliate_requests%2Fapprove_all")
    end

    it "refuses a support member", parity: true do
      as_team_member(:support)

      send_form(:post, "/affiliate_requests/approve_all", {})

      expect(response.location).to end_with("/dashboard")
      expect(flash[:alert]).to eq("Your current role as Support cannot perform this action.")
    end

    it "hands pending requests to Rails", parity: true do
      pending_request = affiliate_request_for
      log_in(seller)

      send_form(:post, "/affiliate_requests/approve_all", {})

      expect(response).to have_http_status(:see_other)
      expect(pending_request.reload.state).to eq("approved")
    end
  end
end
