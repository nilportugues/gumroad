# frozen_string_literal: true

require "spec_helper"

# Subscribing to a seller (FollowersController#create and #from_embed_form with Follower::CreateService), recorded for the Next.js
# port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/audience-mutations.replay.test.ts. The CAPTCHA check passes in the test
# environment, so the examples that need one for a seller who is not reviewed are hand-backs: Node cannot ask Google.
describe "Subscribing to a seller", type: :request do
  include Parity::AudienceSignedIn

  let!(:seller) { create(:user, name: "Followed Seller", username: "followedseller", user_risk_state: "compliant") }
  let(:json_headers) { { "Accept" => "application/json", "Content-Type" => "application/json" } }

  before { host! DOMAIN }

  # Midday, so the replay clock (which seeds times in whole hours) cannot move the date.
  def follow(email, confirmed_at: nil, user: seller, **attributes)
    create(:follower, user:, email:, confirmed_at:, created_at: Time.utc(2025, 1, 1, 12), **attributes)
  end

  def subscribe(path, params, headers: json_headers, as_json: true)
    token = csrf_token
    if as_json
      post path, params: params.to_json, headers: headers.merge("X-CSRF-Token" => token)
    else
      post path, params: params.merge(authenticity_token: token), headers:
    end
  end

  describe "POST /follow" do
    it "asks a visitor to confirm, answering the form with a redirect", parity: true do
      subscribe(follow_user_path, { seller_id: seller.external_id, email: "visitor@example.com" }, headers: {}, as_json: false)

      expect(response).to redirect_to("/subscribe")
      expect(response).to have_http_status(:see_other)
      expect(flash[:notice]).to eq("Check your inbox to confirm your follow request to Followed Seller.")
      expect(Follower.find_by(email: "visitor@example.com")).to have_attributes(followed_id: seller.id, confirmed_at: nil, source: nil)
      mail_job = ActiveJob::Base.queue_adapter.enqueued_jobs.find { _1[:args].first(2) == %w[FollowerMailer confirm_follower] }
      expect(mail_job[:queue]).to eq("critical")
    end

    it "answers JSON with the message", parity: true do
      subscribe(follow_user_path, { seller_id: seller.external_id, email: "visitor@example.com" })

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to eq("success" => true, "message" => "Check your inbox to confirm your follow request to Followed Seller.")
    end

    it "links the follow to the account that has the email", parity: true do
      buyer = create(:user, email: "buyer@example.com")

      subscribe(follow_user_path, { seller_id: seller.external_id, email: "buyer@example.com" })

      expect(response).to have_http_status(:ok)
      expect(Follower.find_by(email: "buyer@example.com").follower_user_id).to eq(buyer.id)
    end

    it "confirms the follow of a signed-in visitor with a verified email", parity: true do
      visitor = create(:user, email: "member@example.com")
      log_in(visitor)

      subscribe(follow_user_path, { seller_id: seller.external_id, email: "member@example.com" })

      expect(response.parsed_body).to eq("success" => true, "message" => "You are now following Followed Seller!")
      expect(Follower.find_by(email: "member@example.com").confirmed_at).to be_present
    end

    it "schedules the workflow emails when a signed-in visitor with a verified email follows", parity: true do
      workflow = create(:follower_workflow, seller:)
      installment = create(:workflow_installment, workflow:, seller:, link: workflow.link, name: "Welcome", message: "<p>Hello</p>", published_at: Time.utc(2025, 2, 1))
      installment.installment_rule.update_columns(delayed_delivery_time: 3600, time_period: "hour")
      visitor = create(:user, email: "member@example.com")
      log_in(visitor)

      subscribe(follow_user_path, { seller_id: seller.external_id, email: "member@example.com" })

      expect(response.parsed_body).to eq("success" => true, "message" => "You are now following Followed Seller!")
      expect(SendWorkflowInstallmentWorker.jobs.size).to eq(1)
    end

    it "revives a follower who had been removed", parity: true do
      follower = follow("returning@example.com", deleted_at: Time.utc(2025, 2, 5, 12), source: Follower::From::PROFILE_PAGE)

      subscribe(follow_user_path, { seller_id: seller.external_id, email: "returning@example.com" })

      expect(response).to have_http_status(:ok)
      expect(follower.reload).to have_attributes(deleted_at: nil, confirmed_at: nil, source: nil)
    end

    it "asks a confirmed follower to confirm again", parity: true do
      follower = follow("confirmed@example.com", confirmed_at: Time.utc(2025, 1, 2, 12))

      subscribe(follow_user_path, { seller_id: seller.external_id, email: "confirmed@example.com" })

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["message"]).to eq("You are now following Followed Seller!")
      expect(follower.reload.confirmed_at).to eq(Time.utc(2025, 1, 2, 12))
    end

    it "refuses an email that is not valid", parity: true do
      subscribe(follow_user_path, { seller_id: seller.external_id, email: "not-an-email" })

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body).to eq("success" => false, "message" => "Email invalid.")
      expect(Follower.where(followed_id: seller.id)).to be_empty
    end

    it "sends the HTML form back to the subscribe page with the error", parity: true do
      subscribe(follow_user_path, { seller_id: seller.external_id, email: "not-an-email" }, headers: {}, as_json: false)

      expect(response).to redirect_to("/subscribe")
      expect(response).to have_http_status(:found)
      expect(flash[:alert]).to eq("Email invalid.")
    end

    it "answers an unknown seller with the generic failure", parity: true do
      subscribe(follow_user_path, { seller_id: "unknownseller", email: "visitor@example.com" })

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body).to eq("success" => false, "message" => "Sorry, something went wrong.")
    end

    it "answers a blank email with the generic failure", parity: true do
      subscribe(follow_user_path, { seller_id: seller.external_id, email: "" }, headers: {}, as_json: false)

      expect(response).to redirect_to("/subscribe")
      expect(flash[:alert]).to eq("Sorry, something went wrong.")
    end

    it "hands a suspended seller to Rails, which refuses the follow after the CAPTCHA", parity: true do
      seller.update_columns(user_risk_state: "suspended_for_tos_violation")

      subscribe(follow_user_path, { seller_id: seller.external_id, email: "visitor@example.com" })

      expect(response).to have_http_status(:unprocessable_entity)
      expect(Follower.where(followed_id: seller.id)).to be_empty
    end

    it "hands a seller who needs a CAPTCHA to Rails", parity: true do
      seller.update_columns(user_risk_state: "not_reviewed")

      subscribe(follow_user_path, { seller_id: seller.external_id, email: "visitor@example.com" })

      expect(response).to have_http_status(:ok)
    end

    it "hands a waitlist signup to Rails", parity: true do
      product = create(:product, user: seller)

      subscribe(follow_user_path, { seller_id: seller.external_id, email: "visitor@example.com", product_id: product.external_id })

      expect(response).to have_http_status(:ok)
    end

    it "hands a seller under a newsletter cutover to Rails", parity: true do
      FeatureAnnouncementNewsletterCutover.create!(seller:, state: "rolled_back", cutoff_at: Time.utc(2025, 1, 1, 12))

      subscribe(follow_user_path, { seller_id: seller.external_id, email: "visitor@example.com" })

      expect(response).to have_http_status(:ok)
    end

    it "refuses the fourth request of a minute from one address with a 429", parity: true do
      Rack::Attack.cache.store.flushdb
      # The counter is keyed by the minute window: start early in one so the requests cannot straddle two.
      sleep(61 - Time.now.sec) if Time.now.sec > 45
      headers = json_headers.merge("CF-Connecting-IP" => "203.0.113.9")

      3.times do |i|
        subscribe(follow_user_path, { seller_id: seller.external_id, email: "visitor#{i}@example.com" }, headers:)
        expect(response).to have_http_status(:ok)
      end

      subscribe(follow_user_path, { seller_id: seller.external_id, email: "visitor4@example.com" }, headers:)

      expect(response).to have_http_status(:too_many_requests)
      expect(Follower.where(followed_id: seller.id).count).to eq(3)
    end

    # Rack::Attack reads form and query parameters only, so a JSON body counts for the address alone; a form counts for the address and the seller.
    it "refuses the fourth form of a minute for one seller with a 429", parity: true do
      Rack::Attack.cache.store.flushdb
      other = create(:user, name: "Other Seller", username: "otherseller", user_risk_state: "compliant")
      headers = { "CF-Connecting-IP" => "203.0.113.10" }

      3.times { |i| subscribe(follow_user_path, { seller_id: seller.external_id, email: "visitor#{i}@example.com" }, headers:, as_json: false) }
      subscribe(follow_user_path, { seller_id: other.external_id, email: "visitor@example.com" }, headers:, as_json: false)
      expect(response).to have_http_status(:see_other)

      subscribe(follow_user_path, { seller_id: seller.external_id, email: "visitor9@example.com" }, headers:, as_json: false)
      expect(response).to have_http_status(:too_many_requests)
    end
  end

  describe "POST /follow_from_embed_form" do
    it "answers JSON with the message and records the embed form as the source", parity: true do
      subscribe(follow_user_from_embed_form_path, { seller_id: seller.external_id, email: "visitor@example.com" })

      expect(response.parsed_body).to eq("success" => true, "message" => "Check your inbox to confirm your follow request to Followed Seller.")
      expect(Follower.find_by(email: "visitor@example.com").source).to eq(Follower::From::EMBED_FORM)
    end

    it "refuses an email that is not valid", parity: true do
      subscribe(follow_user_from_embed_form_path, { seller_id: seller.external_id, email: "not-an-email" })

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body).to eq("success" => false, "message" => "Email invalid.")
    end

    it "revives a follower who had been removed", parity: true do
      follower = follow("returning@example.com", deleted_at: Time.utc(2025, 2, 5, 12), source: Follower::From::PROFILE_PAGE)

      subscribe(follow_user_from_embed_form_path, { seller_id: seller.external_id, email: "returning@example.com" })

      expect(response).to have_http_status(:ok)
      expect(follower.reload).to have_attributes(deleted_at: nil, source: Follower::From::EMBED_FORM)
    end

    # The HTML answer is the Followers/FromEmbedForm Inertia page; a mutation cannot render a page in Node yet, so these hand back, and
    # followers-embed-form.test.ts compares the props Node builds with the ones recorded here.
    def embed_form_props
      JSON.parse(CGI.unescapeHTML(response.body[/data-page="([^"]*)"/, 1])).fetch("props").slice("success", "message", "confirmed", "subscribe_url", "waitlist_url")
    end

    it "hands a form post of the embed form to Rails", parity: true do
      subscribe(follow_user_from_embed_form_path, { seller_id: seller.external_id, email: "visitor@example.com" }, headers: {}, as_json: false)

      expect(response).to have_http_status(:ok)
      expect(embed_form_props).to eq("success" => true, "message" => "Check your inbox to confirm your follow request to Followed Seller.", "confirmed" => false)
    end

    it "hands the embed form result of a signed-in visitor with a verified email to Rails", parity: true do
      log_in(create(:user, email: "member@example.com"))

      subscribe(follow_user_from_embed_form_path, { seller_id: seller.external_id, email: "member@example.com" }, headers: {}, as_json: false)

      expect(embed_form_props).to eq("success" => true, "message" => "You are now following Followed Seller!", "confirmed" => true)
    end

    it "hands the embed form of a seller who needs a CAPTCHA to Rails, pointing at the seller's subscribe page", parity: true do
      seller.update_columns(user_risk_state: "not_reviewed")

      subscribe(follow_user_from_embed_form_path, { seller_id: seller.external_id, email: "visitor@example.com" }, headers: {}, as_json: false)

      expect(embed_form_props).to eq("success" => false, "message" => "Please subscribe from Followed Seller's subscribe page so we can confirm you're not a bot.", "subscribe_url" => "#{seller.subdomain_with_protocol}/subscribe", "waitlist_url" => nil)
      expect(Follower.where(followed_id: seller.id)).to be_empty
    end

    it "hands the embed form of a seller with no name or username who needs a CAPTCHA to Rails", parity: true do
      seller.update_columns(user_risk_state: "not_reviewed", username: nil, name: nil)

      subscribe(follow_user_from_embed_form_path, { seller_id: seller.external_id, email: "visitor@example.com" }, headers: {}, as_json: false)

      expect(embed_form_props).to eq("success" => false, "message" => "Please subscribe from #{seller.external_id}'s subscribe page so we can confirm you're not a bot.", "subscribe_url" => "#{seller.subdomain_with_protocol}/subscribe", "waitlist_url" => nil)
    end

    it "hands a request for an unknown seller to Rails", parity: true do
      subscribe(follow_user_from_embed_form_path, { seller_id: "unknownseller", email: "visitor@example.com" })

      expect(response).to have_http_status(:not_found)
    end

    it "refuses the fourth request of a minute from one address with a 429", parity: true do
      Rack::Attack.cache.store.flushdb
      sleep(61 - Time.now.sec) if Time.now.sec > 45
      headers = json_headers.merge("CF-Connecting-IP" => "203.0.113.11")

      3.times do |i|
        subscribe(follow_user_from_embed_form_path, { seller_id: seller.external_id, email: "visitor#{i}@example.com" }, headers:)
        expect(response).to have_http_status(:ok)
      end

      subscribe(follow_user_from_embed_form_path, { seller_id: seller.external_id, email: "visitor4@example.com" }, headers:)

      expect(response).to have_http_status(:too_many_requests)
    end
  end
end
