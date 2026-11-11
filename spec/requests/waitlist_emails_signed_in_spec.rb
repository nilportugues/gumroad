# frozen_string_literal: true

require "spec_helper"

# POST /products/:product_id/waitlist_email.json (Products::WaitlistEmailsController#create), recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/waitlist-emails.replay.test.ts, which sends the last request of each
# example. Node answers the policy, the 404 and the refusals, and the edit url of a launch email that exists; an example named
# "hands a ..." is one Node leaves to Rails whole because it would build the draft.
describe "Product waitlist email", type: :request do
  include Parity::AudienceSignedIn

  # A team member's account may email without the sales threshold, so no sales have to be indexed.
  let(:seller) { create(:user, name: "Waitlist Seller", is_team_member: true) }
  let(:product) { create(:product, user: seller, name: "Waitlisted product", unique_permalink: "waitme", created_at: Time.utc(2025, 1, 1)) }
  let(:json_headers) { { "Accept" => "application/json, text/html", "Content-Type" => "application/json" } }

  before { host! DOMAIN }

  def start_email(permalink = product.unique_permalink)
    post "/products/#{permalink}/waitlist_email.json", params: {}.to_json, headers: json_headers.merge("X-CSRF-Token" => csrf_token)
  end

  def team_member(role)
    member = create(:user, name: "#{role.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  context "when signed in as the seller" do
    before { log_in(seller) }

    it "answers the edit url of the email that exists", parity: true do
      email = WaitlistLaunchEmail.new(product:).find_or_create_email!

      start_email

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to eq("success" => true, "edit_url" => "/emails/#{email.external_id}/edit")
    end

    it "answers the email of this product when another product has one too", parity: true do
      other = create(:product, user: seller, name: "Other waitlisted", unique_permalink: "otherwait", created_at: Time.utc(2025, 1, 2))
      WaitlistLaunchEmail.new(product: other).find_or_create_email!
      email = WaitlistLaunchEmail.new(product:).find_or_create_email!

      start_email

      expect(response.parsed_body).to eq("success" => true, "edit_url" => "/emails/#{email.external_id}/edit")
      expect(seller.installments.count).to eq(2)
    end

    it "answers the newest email when the product has two", parity: true do
      WaitlistLaunchEmail.new(product:).find_or_create_email!
      newest = seller.installments.new(name: "Second", message: "<p>Hi</p>", installment_type: Installment::FOLLOWER_TYPE, send_emails: true, shown_on_profile: false)
      newest.waitlisted_products = [product.unique_permalink]
      newest.json_data[WaitlistLaunchEmail::PRODUCT_KEY] = product.id
      newest.save!

      start_email

      expect(response.parsed_body).to eq("success" => true, "edit_url" => "/emails/#{newest.external_id}/edit")
    end

    it "hands the first press to Rails", parity: true do
      start_email

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to include("success" => true)
      expect(seller.installments.count).to eq(1)
    end

    it "hands a product whose only email was deleted to Rails", parity: true do
      WaitlistLaunchEmail.new(product:).find_or_create_email!.update_column(:deleted_at, Time.utc(2025, 2, 1))

      start_email

      expect(response).to have_http_status(:ok)
      expect(seller.installments.alive.count).to eq(1)
    end

    it "answers 404 for an unknown product", parity: true do
      start_email("nothere")

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a deleted product", parity: true do
      product.mark_deleted!

      start_email

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for the product of another seller", parity: true do
      other = create(:product, unique_permalink: "otherseller")

      start_email(other.unique_permalink)

      expect(response).to have_http_status(:not_found)
    end
  end

  context "when the seller cannot email yet" do
    let(:seller) { create(:user, name: "New Seller") }

    before { log_in(seller) }

    it "refuses a seller below the sales threshold", parity: true do
      start_email

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body).to eq("success" => false, "error" => "You can email your waitlist once you've made at least $100 in sales and received a payout.")
      expect(seller.installments.count).to eq(0)
    end

    # check_suspended answers a suspended seller's write before the action, so blocked_reason's own suspended message never shows.
    it "turns a suspended seller away before the action", parity: true do
      product
      seller.update_columns(user_risk_state: "suspended_for_tos_violation")

      start_email

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to eq("success" => false, "error_message" => "You can't perform this action because your account has been suspended.")
    end
  end

  context "when signed in as a team member" do
    it "lets a marketing member start the email", parity: true do
      team_member(:marketing)
      email = WaitlistLaunchEmail.new(product:).find_or_create_email!

      start_email

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to eq("success" => true, "edit_url" => "/emails/#{email.external_id}/edit")
    end

    it "refuses a support member", parity: true do
      team_member(:support)

      start_email

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body).to include("success" => false)
    end
  end
end
