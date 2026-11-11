# frozen_string_literal: true

require "spec_helper"

# Checkout::Upsells::PausesController (POST and DELETE /checkout/upsells/:upsell_id/pause), recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/ws20u.replay.test.ts, which sends the last request of each example. An upsell
# that no longer validates raises in Rails, so that example records what Node hands back.
describe "Checkout upsell pauses when signed in", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:named_seller) }
  let(:json_headers) { { "Accept" => "application/json", "Content-Type" => "application/json" } }

  before { host! DOMAIN }

  def make_upsell(name, **attributes)
    create(:upsell, { seller:, product: create(:product, user: seller, name: "#{name} product"), name:, updated_at: Time.utc(2025, 2, 1) }.merge(attributes))
  end

  def team_member(role)
    member = create(:user, name: "#{role.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  def pause(upsell)
    post checkout_upsell_pause_path(upsell.external_id), headers: json_headers.merge("X-CSRF-Token" => csrf_token)
  end

  def unpause(upsell)
    delete checkout_upsell_pause_path(upsell.external_id), headers: json_headers.merge("X-CSRF-Token" => csrf_token)
  end

  context "when signed in as the seller" do
    before { log_in(seller) }

    it "pauses an upsell", parity: true do
      upsell = make_upsell("Live")

      pause(upsell)

      expect(response).to have_http_status(:no_content)
      expect(upsell.reload.paused).to be(true)
    end

    it "pauses an upsell that is already paused", parity: true do
      upsell = make_upsell("Resting", paused: true)

      pause(upsell)

      expect(response).to have_http_status(:no_content)
      expect(upsell.reload.updated_at).to eq(Time.utc(2025, 2, 1))
    end

    it "unpauses an upsell", parity: true do
      upsell = make_upsell("Resting", paused: true)

      unpause(upsell)

      expect(response).to have_http_status(:no_content)
      expect(upsell.reload.paused).to be(false)
    end

    it "pauses a cross-sell with an offer code", parity: true do
      product = create(:product, user: seller, name: "Base product")
      upsell = make_upsell("Bundle offer", product:, cross_sell: true, offer_code: create(:offer_code, user: seller, products: [product], amount_cents: 200))

      pause(upsell)

      expect(response).to have_http_status(:no_content)
      expect(upsell.reload.paused).to be(true)
    end

    it "answers not found for a deleted upsell", parity: true do
      upsell = make_upsell("Removed", deleted_at: Time.utc(2025, 2, 2))

      pause(upsell)

      expect(response).to have_http_status(:not_found)
    end

    it "answers not found when unpausing a deleted upsell", parity: true do
      upsell = make_upsell("Removed", paused: true, deleted_at: Time.utc(2025, 2, 2))

      unpause(upsell)

      expect(response).to have_http_status(:not_found)
    end

    it "answers not found for another seller's upsell", parity: true do
      upsell = create(:upsell)

      pause(upsell)

      expect(response).to have_http_status(:not_found)
      expect(upsell.reload.paused).to be(false)
    end

    it "hands an upsell that no longer validates to Rails", parity: true do
      upsell = make_upsell("Original")
      twin = Upsell.new(seller:, product: upsell.product, name: "Twin", cross_sell: false)
      twin.save!(validate: false)

      pause(twin)

      expect(response).not_to have_http_status(:no_content)
      expect(twin.reload.paused).to be(false)
    end
  end

  context "when signed in as a team member" do
    it "refuses a support member the pause", parity: true do
      upsell = make_upsell("Protected")
      team_member("support")

      pause(upsell)

      expect(response).to have_http_status(:unauthorized)
      expect(upsell.reload.paused).to be(false)
    end

    it "lets a marketing member pause", parity: true do
      upsell = make_upsell("Marketed")
      team_member("marketing")

      pause(upsell)

      expect(response).to have_http_status(:no_content)
      expect(upsell.reload.paused).to be(true)
    end

    it "lets an admin unpause", parity: true do
      upsell = make_upsell("Administered", paused: true)
      team_member("admin")

      unpause(upsell)

      expect(response).to have_http_status(:no_content)
    end

    it "refuses an accountant the unpause", parity: true do
      upsell = make_upsell("Audited", paused: true)
      team_member("accountant")

      unpause(upsell)

      expect(response).to have_http_status(:unauthorized)
      expect(upsell.reload.paused).to be(true)
    end
  end
end
