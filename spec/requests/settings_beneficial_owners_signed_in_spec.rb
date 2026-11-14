# frozen_string_literal: true

require "spec_helper"

# Settings::BeneficialOwnersController, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/settings-guardians.replay.test.ts, which sends the last request of each example. Node serves the refusals; every
# action that reaches StripeBeneficialOwnersManager calls Stripe and is handed to Rails ("hands a ..." examples, with Stripe stubbed).
describe "Beneficial owners when signed in", type: :request do
  include Parity::SignedInDashboard

  let(:seller) { create(:user, name: "Business Seller", username: "businessseller") }
  let(:stripe_account_id) { "acct_test_beneficial" }
  let(:person_id) { "person_phil" }
  let(:person) do
    Stripe::StripeObject.construct_from(
      id: person_id, first_name: "Phil", last_name: "Owner",
      relationship: { representative: false, owner: true, director: true, percent_ownership: 33.33, title: "Director" },
      address: { line1: "2 High St", city: "London", country: "GB", postal_code: "EC2" },
      dob: { day: 2, month: 2, year: 1981 }, id_number_provided: true,
      verification: { status: "verified" }, requirements: { currently_due: [] }
    )
  end
  let(:owner_params) do
    {
      beneficial_owner: {
        first_name: "Phil", last_name: "Owner", email: "phil@example.com", phone: "+447700900000", id_number: "AB123456C", title: "Director",
        owner: "true", director: "true", executive: "false", percent_ownership: "33.33",
        dob: { day: "2", month: "2", year: "1981" },
        address: { line1: "2 High St", city: "London", state: "Greater London", postal_code: "EC2", country: "GB" }
      }
    }
  end

  def eligible_seller
    create(:user_compliance_info_business, user: seller, business_country: "United Kingdom", country: "United Kingdom")
    create(:merchant_account, user: seller, country: "GB", currency: "gbp", charge_processor_merchant_id: stripe_account_id)
  end

  def request_owners(method, path, as: seller, membership: nil, body: nil)
    log_in(as)
    switch_to(membership) if membership
    headers = { "Accept" => "application/json", "Content-Type" => "application/json", "X-CSRF-Token" => csrf_token }
    public_send(method, path, **(body ? { params: body.to_json } : {}), headers:)
  end

  describe "a business seller on a Gumroad-managed Stripe account" do
    before do
      eligible_seller
      allow(Stripe::Account).to receive(:list_persons).and_return({ "data" => [person] })
      allow(Stripe::Account).to receive(:retrieve_person).and_return(person)
      allow(Stripe::Account).to receive(:create_person).and_return(person)
      allow(Stripe::Account).to receive(:update_person).and_return(person)
      allow(Stripe::Account).to receive(:delete_person).and_return(Stripe::StripeObject.construct_from(id: person_id, deleted: true))
    end

    it "hands a list to Rails", parity: true do
      request_owners(:get, settings_beneficial_owners_path)

      expect(response).to have_http_status(:ok)
    end

    it "hands a create to Rails", parity: true do
      request_owners(:post, settings_beneficial_owners_path, body: owner_params)

      expect(response).to have_http_status(:created)
    end

    it "hands an update to Rails", parity: true do
      request_owners(:patch, settings_beneficial_owner_path(person_id), body: owner_params)

      expect(response).to have_http_status(:ok)
    end

    it "hands a removal to Rails", parity: true do
      request_owners(:delete, settings_beneficial_owner_path(person_id))

      expect(response).to have_http_status(:ok)
    end

    it "answers 401 JSON to marketing", parity: true do
      member = create(:user, name: "Team marketing")
      membership = create(:team_membership, user: member, seller:, role: "marketing")

      request_owners(:get, settings_beneficial_owners_path, as: member, membership:)

      expect(response).to have_http_status(:unauthorized)
    end

    it "answers 401 JSON to marketing on a removal", parity: true do
      member = create(:user, name: "Team marketing")
      membership = create(:team_membership, user: member, seller:, role: "marketing")

      request_owners(:delete, settings_beneficial_owner_path(person_id), as: member, membership:)

      expect(response).to have_http_status(:unauthorized)
    end

    it "answers 403 JSON to a seller without an email address", parity: true do
      log_in(seller)
      seller.update_columns(email: nil, unconfirmed_email: nil)

      get settings_beneficial_owners_path, headers: { "Accept" => "application/json", "X-CSRF-Token" => csrf_token }

      expect(response).to have_http_status(:forbidden)
    end
  end

  describe "a seller who cannot manage beneficial owners" do
    let(:refusal) { { "error" => "Beneficial owners can only be managed on business accounts using Gumroad-managed Stripe." } }

    it "answers 403 to an individual on a Gumroad-managed Stripe account", parity: true do
      create(:user_compliance_info, user: seller)
      create(:merchant_account, user: seller, country: "US", charge_processor_merchant_id: stripe_account_id)

      request_owners(:get, settings_beneficial_owners_path)

      expect(response).to have_http_status(:forbidden)
      expect(response.parsed_body).to eq(refusal)
    end

    it "answers 403 to a business without a Stripe account", parity: true do
      create(:user_compliance_info_business, user: seller)

      request_owners(:post, settings_beneficial_owners_path, body: owner_params)

      expect(response).to have_http_status(:forbidden)
      expect(response.parsed_body).to eq(refusal)
    end

    it "answers 403 to a business paid through a connected account", parity: true do
      create(:user_compliance_info_business, user: seller)
      create(:merchant_account_stripe_connect, user: seller, country: "US")

      request_owners(:patch, settings_beneficial_owner_path(person_id), body: owner_params)

      expect(response).to have_http_status(:forbidden)
    end

    it "answers 403 to a seller with no compliance information", parity: true do
      create(:merchant_account, user: seller, country: "US", charge_processor_merchant_id: stripe_account_id)

      request_owners(:delete, settings_beneficial_owner_path(person_id))

      expect(response).to have_http_status(:forbidden)
    end

    it "answers 403 to a business whose Stripe account was deleted", parity: true do
      create(:user_compliance_info_business, user: seller)
      create(:merchant_account, user: seller, country: "US", charge_processor_merchant_id: stripe_account_id, deleted_at: Time.current)

      request_owners(:get, settings_beneficial_owners_path)

      expect(response).to have_http_status(:forbidden)
    end
  end
end
