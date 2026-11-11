# frozen_string_literal: true

require "spec_helper"

# Settings::GuardiansController, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/settings-guardians.replay.test.ts, which sends the last request of each example. Node serves the refusals;
# a save, which encrypts the tax id and queues SyncGuardianToStripeJob, is handed to Rails ("hands a ..." examples).
describe "Legal guardians when signed in", type: :request do
  include Parity::SignedInDashboard

  let(:seller) { create(:user, name: "Minor Seller", username: "minorseller") }
  let(:minor_birthday) { 15.years.ago.to_date }
  let(:guardian_params) do
    {
      guardian: {
        first_name: "Dana", last_name: "Okafor", email: "dana@example.com", phone: "4155550123", date_of_birth: "1984-06-02",
        street_address: "1 Market St", city: "San Francisco", state: "CA", zip_code: "94107",
        individual_tax_id: "000000000", accept_terms: "true"
      }
    }
  end

  def submit(method, path, as: seller, membership: nil, body: guardian_params)
    log_in(as)
    switch_to(membership) if membership
    public_send(method, path, params: body.to_json,
                              headers: { "Accept" => "application/json", "Content-Type" => "application/json", "X-CSRF-Token" => csrf_token })
  end

  def create_guardian(**options) = submit(:post, settings_guardians_path, **options)
  def update_guardian(id, **options) = submit(:patch, settings_guardian_path(id), **options)

  describe "a seller aged 13-17 in the United States" do
    before { create(:user_compliance_info, user: seller, birthday: minor_birthday) }

    it "hands a create to Rails", parity: true do
      create_guardian

      expect(response).to have_http_status(:created)
      expect(seller.guardians.alive.count).to eq(1)
      expect(SyncGuardianToStripeJob.jobs.size).to eq(1)
    end

    it "hands an update of the guardian to Rails", parity: true do
      guardian = create(:guardian, user: seller)
      seller.alive_user_compliance_info.update!(guardian_id: guardian.id)

      update_guardian(guardian.external_id, body: { guardian: { city: "Berkeley" } })

      expect(response).to have_http_status(:ok)
      expect(guardian.reload.city).to eq("Berkeley")
    end

    it "hands a create whose body has no guardian to Rails", parity: true do
      create_guardian(body: {})

      expect(response).to have_http_status(:bad_request)
    end

    it "answers 404 for a guardian that does not exist", parity: true do
      update_guardian("bogus")

      expect(response).to have_http_status(:not_found)
      expect(response.body).to eq("")
    end

    it "answers 404 for the guardian of another seller", parity: true do
      other = create(:guardian, user: create(:user))

      update_guardian(other.external_id)

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a guardian that was deleted", parity: true do
      guardian = create(:guardian, user: seller, deleted_at: Time.current)

      update_guardian(guardian.external_id)

      expect(response).to have_http_status(:not_found)
    end

    it "hands a create by a team admin to Rails", parity: true do
      admin = create(:user, name: "Team admin")
      membership = create(:team_membership, user: admin, seller:, role: "admin")

      create_guardian(as: admin, membership:)

      expect(response).to have_http_status(:created)
      expect(seller.comments.last.content).to eq("Legal guardian added by team admin #{admin.email}")
    end

    it "answers 401 JSON to marketing", parity: true do
      member = create(:user, name: "Team marketing")
      membership = create(:team_membership, user: member, seller:, role: "marketing")

      create_guardian(as: member, membership:)

      expect(response).to have_http_status(:unauthorized)
      expect(seller.guardians).to be_empty
    end

    it "answers 401 before 404 to marketing for a guardian that does not exist", parity: true do
      member = create(:user, name: "Team marketing")
      membership = create(:team_membership, user: member, seller:, role: "marketing")

      update_guardian("bogus", as: member, membership:)

      expect(response).to have_http_status(:unauthorized)
    end

    it "answers 403 JSON to a seller without an email address", parity: true do
      log_in(seller)
      seller.update_columns(email: nil, unconfirmed_email: nil)

      post settings_guardians_path, params: guardian_params.to_json,
                                    headers: { "Accept" => "application/json", "Content-Type" => "application/json", "X-CSRF-Token" => csrf_token }

      expect(response).to have_http_status(:forbidden)
    end

    it "hands a seller paid through a Brazilian connected account to Rails", parity: true do
      create(:merchant_account_stripe_connect, user: seller, country: "BR")
      seller.update!(check_merchant_account_is_linked: true)

      create_guardian

      expect(response).to have_http_status(:created)
    end

    it "answers 403 to a seller paid through a connected account", parity: true do
      create(:merchant_account_stripe_connect, user: seller, country: "US")
      seller.update!(check_merchant_account_is_linked: true)

      create_guardian

      expect(response).to have_http_status(:forbidden)
      expect(response.parsed_body).to eq("error" => "A legal guardian isn't required on this account.")
    end

    it "answers 403 on an update to a seller paid through a connected account", parity: true do
      create(:merchant_account_stripe_connect, user: seller, country: "US")
      seller.update!(check_merchant_account_is_linked: true)

      update_guardian("bogus")

      expect(response).to have_http_status(:forbidden)
    end
  end

  describe "a seller who needs no guardian" do
    it "answers 403 to an adult", parity: true do
      create(:user_compliance_info, user: seller, birthday: 30.years.ago.to_date)

      create_guardian

      expect(response).to have_http_status(:forbidden)
      expect(response.parsed_body).to eq("error" => "A legal guardian isn't required on this account.")
      expect(seller.guardians).to be_empty
    end

    it "answers 403 to a minor in a country with no guardian path", parity: true do
      create(:user_compliance_info, user: seller, birthday: 15.years.ago.to_date, country: "Brazil", state: "SP", zip_code: "01000-000")

      create_guardian

      expect(response).to have_http_status(:forbidden)
    end

    it "answers 403 to a seller with no compliance information", parity: true do
      create_guardian

      expect(response).to have_http_status(:forbidden)
    end

    it "answers 403 on an update before looking for the guardian", parity: true do
      create(:user_compliance_info, user: seller, birthday: 30.years.ago.to_date)

      update_guardian("bogus")

      expect(response).to have_http_status(:forbidden)
    end
  end
end
