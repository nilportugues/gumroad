# frozen_string_literal: true

require "spec_helper"

# GET and PATCH /products/:product_id/marketing_abandoned_cart.json (Products::MarketingAbandonedCartsController), recorded for the
# Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/ws12o.replay.test.ts, which sends the last request of each
# example. Node answers the 404s and the policy; an example named "hands a ..." passes them, and Node leaves it to Rails whole because
# the state renders the email preview and the toggle publishes or pauses a workflow.
describe "Products::MarketingAbandonedCartsController", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Cart Seller") }
  let(:product) { create(:product, user: seller, name: "Cart product", unique_permalink: "cartme", price_cents: 500, created_at: Time.utc(2025, 1, 1)) }
  let(:holdout) { false }
  let(:json_headers) { { "Accept" => "application/json, text/html", "Content-Type" => "application/json" } }

  before do
    host! DOMAIN
    create(:marketing_holdout_assignment, user: seller, marketing_holdout: holdout)
    Feature.activate_user(:auto_marketing, seller)
  end

  def path(permalink = product.unique_permalink) = "/products/#{permalink}/marketing_abandoned_cart.json"

  def show(permalink = product.unique_permalink)
    get path(permalink), headers: { "Accept" => "application/json, text/html" }
  end

  def toggle(body = { enabled: false }, permalink = product.unique_permalink)
    patch path(permalink), params: body.to_json, headers: json_headers.merge("X-CSRF-Token" => csrf_token)
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
      it "answers 404 for an unknown product", parity: true do
        show("nonexistent")

        expect(response).to have_http_status(:not_found)
      end

      it "answers 404 for the product of another seller", parity: true do
        other = create(:product, user: create(:user, name: "Other Seller"), unique_permalink: "othercart", created_at: Time.utc(2025, 1, 2))

        show(other.unique_permalink)

        expect(response).to have_http_status(:not_found)
      end

      it "answers 404 for a product that is not published", parity: true do
        product.update_column(:purchase_disabled_at, Time.utc(2025, 2, 1))

        show

        expect(response).to have_http_status(:not_found)
      end

      it "answers 404 for a draft product", parity: true do
        product.update_column(:draft, true)

        show

        expect(response).to have_http_status(:not_found)
      end

      it "hands a state request for a published product to Rails", parity: true do
        show

        expect(response).to have_http_status(:ok)
        expect(response.parsed_body).to include("available" => false, "enabled" => false)
      end
    end

    describe "update" do
      it "answers 404 for an unknown product", parity: true do
        toggle({ enabled: true }, "nonexistent")

        expect(response).to have_http_status(:not_found)
      end

      it "answers 404 for a product that is not published", parity: true do
        product.update_column(:purchase_disabled_at, Time.utc(2025, 2, 1))

        toggle

        expect(response).to have_http_status(:not_found)
      end

      it "hands a pause to Rails", parity: true do
        toggle({ enabled: false })

        expect(response).to have_http_status(:ok)
      end

      it "hands a refused activation to Rails", parity: true do
        toggle({ enabled: true, activation_token: "stale" })

        expect(response).to have_http_status(:unprocessable_entity)
        expect(Workflow.count).to eq(0)
      end
    end
  end

  context "when the seller is in the marketing holdout" do
    let(:holdout) { true }

    before { log_in(seller) }

    it "answers 404 to the state", parity: true do
      show

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 to a toggle", parity: true do
      toggle({ enabled: true })

      expect(response).to have_http_status(:not_found)
    end
  end

  context "when signed in as a team member" do
    it "refuses a support member the state", parity: true do
      team_member(TeamMembership::ROLE_SUPPORT)

      show

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body).to eq("success" => false, "error" => "Your current role as Support cannot perform this action.")
    end

    it "refuses an accountant member a toggle", parity: true do
      team_member(TeamMembership::ROLE_ACCOUNTANT)

      toggle({ enabled: false })

      expect(response).to have_http_status(:unauthorized)
    end

    it "hands a state request from a marketing member to Rails", parity: true do
      team_member(TeamMembership::ROLE_MARKETING)

      show

      expect(response).to have_http_status(:ok)
    end
  end
end
