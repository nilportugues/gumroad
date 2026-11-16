# frozen_string_literal: true

require "spec_helper"

# The product Share tab's marketing actions (Products::MarketingActionsController), recorded for the Next.js port (PARITY_RECORD=1) and
# replayed by nextjs/parity/__tests__/ws12m.replay.test.ts. Executing a live channel and the channel picker send mail, post to X or
# write drafts, so those examples record what Node hands back.
describe "Product marketing actions", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Marketing Seller", twitter_handle: "marketer") }
  let(:product) { create(:product, user: seller, name: "Launch product", unique_permalink: "launchme", price_cents: 500, created_at: Time.utc(2025, 1, 1)) }
  let(:holdout) { false }
  let(:json_headers) { { "Accept" => "application/json, text/html", "Content-Type" => "application/json" } }
  let(:base) { "/products/#{product.unique_permalink}/marketing_actions" }

  before do
    host! DOMAIN
    create(:marketing_holdout_assignment, user: seller, marketing_holdout: holdout)
    Feature.activate_user(:auto_marketing, seller)
  end

  def get_json(path)
    get path, headers: { "Accept" => "application/json, text/html" }
  end

  def post_json(path, body = {})
    post path, params: body.to_json, headers: json_headers.merge("X-CSRF-Token" => csrf_token)
  end

  def action_path(action, verb = nil) = [base, action.external_id, verb].compact.join("/") + ".json"

  def create_action(**attributes)
    create(:marketing_action, { user: seller, link: product, copy: "Launch product: a fresh start." }.merge(attributes))
  end

  def team_member(role)
    member = create(:user, name: "#{role.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  context "when signed in as the seller" do
    before { log_in(seller) }

    describe "show" do
      it "renders an action with its post text and confirmation token", parity: true do
        utm_link = create(:utm_link, seller:, target_resource_type: "product_page", target_resource_id: product.id, utm_source: "x", utm_medium: "social", utm_campaign: "launch", permalink: "launch01", title: "Launch")
        action = create_action(utm_link:)

        get_json action_path(action)

        expect(response).to have_http_status(:ok)
        expect(response.parsed_body).to include("status" => "recommended", "link_url" => utm_link.short_url, "copy" => "Launch product: a fresh start.")
      end

      it "renders an action without a link", parity: true do
        get_json action_path(create_action(channel: "instagram", status: "approved", approved_at: Time.utc(2025, 3, 1, 12)))

        expect(response.parsed_body).to include("link_url" => nil, "post_text" => "Launch product: a fresh start.", "approved_at" => "2025-03-01T12:00:00Z")
      end

      it "renders a posted action with its external url", parity: true do
        action = create_action(status: "posted", approved_at: Time.utc(2025, 3, 1), posted_at: Time.utc(2025, 3, 2), external_url: "https://x.example.com/posts/1", error_code: nil, copy: "Fish & <chips> é")

        get_json action_path(action)

        expect(response.parsed_body).to include("status" => "posted", "external_url" => "https://x.example.com/posts/1")
      end

      it "answers 404 for an action of another product", parity: true do
        other = create(:product, user: seller)
        action = create(:marketing_action, user: seller, link: other)

        get_json action_path(action)

        expect(response).to have_http_status(:not_found)
      end

      it "answers 404 for an unknown product", parity: true do
        get_json "/products/nothere/marketing_actions/#{create_action.external_id}.json"

        expect(response).to have_http_status(:not_found)
      end

      it "answers 404 for an unknown action", parity: true do
        get_json "#{base}/zzzzzzzzzzzzzzzzzzzzzz.json"

        expect(response).to have_http_status(:not_found)
      end

      it "refuses the action of another seller", parity: true do
        action = create_action(user: create(:user))

        get_json action_path(action)

        expect(response).to have_http_status(:unauthorized)
        expect(response.parsed_body).to include("success" => false)
      end

      it "answers 404 when the flag is off", parity: true do
        Feature.deactivate_user(:auto_marketing, seller)

        get_json action_path(create_action)

        expect(response).to have_http_status(:not_found)
      end
    end

    describe "approve" do
      it "approves a recommended action", parity: true do
        action = create_action

        post_json action_path(action, "approve")

        expect(response).to have_http_status(:ok)
        expect(action.reload).to be_approved
        expect(response.parsed_body).to include("status" => "approved", "approved_at" => be_present)
      end

      it "approves with edited copy", parity: true do
        action = create_action

        post_json action_path(action, "approve"), { copy: "Edited copy" }

        expect(action.reload).to have_attributes(status: "approved", copy: "Edited copy")
        expect(response.parsed_body["post_text"]).to eq("Edited copy")
      end

      it "approves again an action that is already approved", parity: true do
        action = create_action(status: "approved", approved_at: Time.utc(2025, 3, 1))

        post_json action_path(action, "approve"), { copy: "Second pass" }

        expect(response).to have_http_status(:ok)
        expect(action.reload).to have_attributes(status: "approved", copy: "Second pass")
      end

      it "approves with the copy it already has", parity: true do
        action = create_action

        post_json action_path(action, "approve"), { copy: action.copy }

        expect(action.reload).to be_approved
      end

      it "rejects over-length copy", parity: true do
        action = create_action

        post_json action_path(action, "approve"), { copy: "a" * 300 }

        expect(response).to have_http_status(:unprocessable_entity)
        expect(response.parsed_body).to eq("success" => false, "error" => "Copy is too long (maximum is 255 characters)")
        expect(action.reload.copy).to eq("Launch product: a fresh start.")
      end

      it "rejects blank copy", parity: true do
        action = create_action

        post_json action_path(action, "approve"), { copy: "   " }

        expect(response.parsed_body).to eq("success" => false, "error" => "Copy can't be blank")
        expect(action.reload).to be_recommended
      end

      it "rejects null copy", parity: true do
        action = create_action

        post_json action_path(action, "approve"), { copy: nil }

        expect(response).to have_http_status(:unprocessable_entity)
        expect(response.parsed_body["error"]).to eq("Copy can't be blank")
      end

      it "counts copy in characters, not bytes", parity: true do
        action = create_action

        post_json action_path(action, "approve"), { copy: "é" * 255 }

        expect(response).to have_http_status(:ok)
        expect(action.reload.copy.length).to eq(255)
      end

      it "keeps a queued action's copy frozen", parity: true do
        action = create_action(status: "queued", queued_at: Time.utc(2025, 3, 1))

        post_json action_path(action, "approve"), { copy: "Edited" }

        expect(response).to have_http_status(:ok)
        expect(response.parsed_body).to include("status" => "queued", "copy" => "Launch product: a fresh start.")
      end

      it "keeps a posted action as it is", parity: true do
        action = create_action(status: "posted", posted_at: Time.utc(2025, 3, 1))

        post_json action_path(action, "approve")

        expect(response.parsed_body["status"]).to eq("posted")
      end

      %w[cancelled failed].each do |status|
        it "refuses to approve a #{status} action", parity: true do
          action = create_action(status:)

          post_json action_path(action, "approve"), { copy: "Edited" }

          expect(response).to have_http_status(:unprocessable_entity)
          expect(response.parsed_body).to eq("success" => false, "error" => "This post can no longer be changed.")
          expect(action.reload.status).to eq(status)
        end
      end

      it "refuses to approve a blocked action", parity: true do
        action = create_action(status: "blocked", error_code: "email_eligibility_not_met", channel: "email")

        post_json action_path(action, "approve")

        expect(response.parsed_body["error"]).to eq("This post can no longer be changed.")
      end

      it "points an abandoned cart receipt to workflows", parity: true do
        action = create_action(channel: "abandoned_cart", status: "approved", approved_at: Time.utc(2025, 3, 1))

        post_json action_path(action, "approve"), { copy: "Different" }

        expect(response).to have_http_status(:unprocessable_entity)
        expect(response.parsed_body["error"]).to include("Workflows")
        expect(action.reload.copy).to eq("Launch product: a fresh start.")
      end

      it "answers 404 when the flag is off", parity: true do
        Feature.deactivate_user(:auto_marketing, seller)
        action = create_action

        post_json action_path(action, "approve")

        expect(response).to have_http_status(:not_found)
        expect(action.reload).to be_recommended
      end

      it "hands a copy that is not text to Rails", parity: true do
        action = create_action

        post_json action_path(action, "approve"), { copy: 12_345 }

        expect(response).to have_http_status(:ok)
        expect(action.reload.copy).to eq("12345")
      end
    end

    describe "cancel" do
      %w[recommended approved].each do |status|
        it "cancels a #{status} action", parity: true do
          action = create_action(status:, approved_at: (status == "approved" ? Time.utc(2025, 3, 1) : nil))

          post_json action_path(action, "cancel")

          expect(response).to have_http_status(:ok)
          expect(action.reload).to be_cancelled
          expect(response.parsed_body["status"]).to eq("cancelled")
        end
      end

      %w[queued posted cancelled blocked].each do |status|
        it "refuses to cancel a #{status} action", parity: true do
          action = create_action(status:, queued_at: (status == "queued" ? Time.utc(2025, 3, 1) : nil))

          post_json action_path(action, "cancel")

          expect(response).to have_http_status(:unprocessable_entity)
          expect(response.parsed_body).to eq("success" => false, "error" => "This post can no longer be cancelled.")
          expect(action.reload.status).to eq(status)
        end
      end

      it "points an abandoned cart receipt to workflows", parity: true do
        action = create_action(channel: "abandoned_cart", status: "approved", approved_at: Time.utc(2025, 3, 1))

        post_json action_path(action, "cancel")

        expect(response).to have_http_status(:unprocessable_entity)
        expect(action.reload).to be_approved
      end

      it "answers 404 when the flag is off", parity: true do
        Feature.deactivate_user(:auto_marketing, seller)
        action = create_action

        post_json action_path(action, "cancel")

        expect(response).to have_http_status(:not_found)
        expect(action.reload).to be_recommended
      end

      it "refuses the action of another seller", parity: true do
        action = create_action(user: create(:user))

        post_json action_path(action, "cancel")

        expect(response).to have_http_status(:unauthorized)
        expect(action.reload).to be_recommended
      end
    end

    describe "execute" do
      %w[instagram youtube tiktok abandoned_cart].each do |channel|
        it "says the #{channel} channel is coming soon", parity: true do
          action = create_action(channel:, status: "approved", approved_at: Time.utc(2025, 3, 1))

          post_json action_path(action, "execute")

          expect(response).to have_http_status(:unprocessable_entity)
          expect(response.parsed_body).to eq("success" => false, "error" => "This channel is coming soon.")
          expect(action.reload).to be_approved
        end
      end

      it "answers 404 when the flag is off", parity: true do
        Feature.deactivate_user(:auto_marketing, seller)

        post_json action_path(create_action, "execute")

        expect(response).to have_http_status(:not_found)
      end

      it "hands an X post to Rails", parity: true do
        WebMock.stub_request(:post, Marketing::XApi::TWEETS_URL).to_return(status: 403, body: "{}", headers: { "Content-Type" => "application/json" })
        action = create_action(status: "approved", approved_at: Time.utc(2025, 3, 1))

        post_json action_path(action, "execute")

        expect(response).to have_http_status(:ok)
        expect(response.parsed_body["action"]).to include("error_code" => "x_write_permission_missing")
      end

      it "hands a launch email to Rails", parity: true do
        create(:payment_completed, user: seller)
        allow_any_instance_of(User).to receive(:sales_cents_total).and_return(Installment::MINIMUM_SALES_CENTS_VALUE)

        post_json action_path(create_action(channel: "email"), "execute")

        expect(response).to have_http_status(:ok)
        expect(seller.installments.count).to eq(1)
      end
    end

    describe "index" do
      it "hands a channel picker request for a published product to Rails", parity: true do
        get_json "#{base}.json"

        expect(response).to have_http_status(:ok)
        expect(response.parsed_body["channels"].map { _1["channel"] }).to eq(%w[x instagram youtube tiktok email])
        expect(Marketing::Action.count).to eq(2)
      end

      it "answers 404 for a draft product", parity: true do
        product.update!(draft: true)

        get_json "#{base}.json"

        expect(response).to have_http_status(:not_found)
        expect(Marketing::Action.count).to eq(0)
      end

      it "answers 404 for the product of another seller", parity: true do
        other = create(:product, unique_permalink: "otherprod")

        get_json "/products/#{other.unique_permalink}/marketing_actions.json"

        expect(response).to have_http_status(:not_found)
      end

      it "answers 404 when the flag is off", parity: true do
        Feature.deactivate_user(:auto_marketing, seller)

        get_json "#{base}.json"

        expect(response).to have_http_status(:not_found)
      end

      it "answers 404 for an unknown product", parity: true do
        get_json "/products/nothere/marketing_actions.json"

        expect(response).to have_http_status(:not_found)
      end
    end
  end

  context "when the seller is held out" do
    let(:holdout) { true }

    before { log_in(seller) }

    it "answers 404 on a show", parity: true do
      get_json action_path(create_action)

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 on an approval without changing the action", parity: true do
      action = create_action

      post_json action_path(action, "approve")

      expect(response).to have_http_status(:not_found)
      expect(action.reload).to be_recommended
    end
  end

  context "when signed in as a team member" do
    it "lets a marketing member approve", parity: true do
      team_member(:marketing)
      action = create_action

      post_json action_path(action, "approve")

      expect(response).to have_http_status(:ok)
      expect(action.reload).to be_approved
    end

    it "lets an admin cancel", parity: true do
      team_member(:admin)
      action = create_action

      post_json action_path(action, "cancel")

      expect(response).to have_http_status(:ok)
      expect(action.reload).to be_cancelled
    end

    it "refuses a support member", parity: true do
      team_member(:support)
      action = create_action

      post_json action_path(action, "approve")

      expect(response).to have_http_status(:unauthorized)
      expect(action.reload).to be_recommended
    end

    it "refuses a support member the channel picker", parity: true do
      team_member(:support)

      get_json "#{base}.json"

      expect(response).to have_http_status(:unauthorized)
    end

    it "refuses an accountant a show", parity: true do
      team_member(:accountant)

      get_json action_path(create_action)

      expect(response).to have_http_status(:unauthorized)
    end
  end
end
