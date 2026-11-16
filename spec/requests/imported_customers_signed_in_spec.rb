# frozen_string_literal: true

require "spec_helper"

# The imported customers list and removal (ImportedCustomersController#index and #destroy), recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/ws12b.replay.test.ts.
describe "Imported customers when signed in", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Importing Seller") }
  let(:product) { create(:product, user: seller, unique_permalink: "importa") }
  let(:other_product) { create(:product, user: seller, unique_permalink: "importb") }
  let(:json_headers) { { "Accept" => "application/json, text/html", "Content-Type" => "application/json" } }

  before { host! DOMAIN }

  def get_json(path, params = {})
    get path, params:, headers: { "Accept" => "application/json, text/html" }
  end

  def send_json(method, path)
    token = csrf_token
    public_send(method, path, headers: json_headers.merge("X-CSRF-Token" => token))
  end

  def as_team_member(role)
    member = create(:user, name: "#{role.to_s.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  def import(email, link: product, purchase_date: 3.days.ago.change(usec: 0), **attributes)
    create(:imported_customer, importing_user: seller, email:, link_id: link.id, purchase_date:, **attributes)
  end

  describe "listing" do
    it "lists the customers newest first", parity: true do
      import("older@example.com", purchase_date: 40.days.ago.change(usec: 0))
      import("newer@example.com", purchase_date: 2.hours.ago.change(usec: 0))
      import("removed@example.com", deleted_at: Time.current)
      create(:imported_customer, importing_user: create(:user), email: "stranger@example.com")
      log_in(seller)

      get_json(imported_customers_path)

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["customers"].map { _1["email"] }).to eq(%w[newer@example.com older@example.com])
    end

    it "lists nothing for a seller without imports", parity: true do
      log_in(seller)

      get_json(imported_customers_path)

      expect(response.parsed_body).to eq("customers" => [], "begin_loading_imported_customers" => true)
    end

    it "filters by product", parity: true do
      import("one@example.com")
      import("two@example.com", link: other_product)
      log_in(seller)

      get_json(imported_customers_path, link_id: other_product.unique_permalink)

      expect(response.parsed_body["customers"].map { _1["email"] }).to eq(["two@example.com"])
    end

    it "pages by twenty", parity: true do
      22.times { |index| import("buyer#{index}@example.com", purchase_date: (index + 1).days.ago.change(usec: 0)) }
      log_in(seller)

      get_json(imported_customers_path, page: 1)

      expect(response.parsed_body["customers"].size).to eq(2)
    end

    it "shows the license key of a licensed product", parity: true do
      licensed = create(:product, user: seller, is_licensed: true)
      customer = import("licensed@example.com", link: licensed)
      create(:license, link: licensed, purchase: nil, imported_customer: customer)
      log_in(seller)

      get_json(imported_customers_path)

      expect(response.parsed_body["customers"].first["license_key"]).to be_present
    end

    it "lets an accountant list the customers", parity: true do
      import("one@example.com")
      as_team_member(TeamMembership::ROLE_ACCOUNTANT)

      get_json(imported_customers_path)

      expect(response.parsed_body["customers"].first["can_update"]).to be(false)
    end

    it "lets a marketing team member list the customers", parity: true do
      as_team_member(TeamMembership::ROLE_MARKETING)

      get_json(imported_customers_path)

      expect(response.parsed_body["customers"]).to eq([])
    end
  end

  describe "removing" do
    it "marks the customer as deleted", parity: true do
      customer = import("gone@example.com")
      log_in(seller)

      send_json(:delete, destroy_imported_customer_path(customer.external_id))

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to include("success" => true, "message" => "Deleted!")
      expect(customer.reload.deleted_at).to be_present
    end

    it "does not let a marketing team member remove a customer", parity: true do
      customer = import("kept@example.com")
      as_team_member(TeamMembership::ROLE_MARKETING)

      send_json(:delete, destroy_imported_customer_path(customer.external_id))

      expect(response).to have_http_status(:unauthorized)
      expect(customer.reload.deleted_at).to be_nil
    end
  end
end
