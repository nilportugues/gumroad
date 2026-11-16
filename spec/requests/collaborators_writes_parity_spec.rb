# frozen_string_literal: true

require "spec_helper"

# The writes of Collaborators::MainController (#destroy, and #create and #update when they save), recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/collaborators-writes.replay.test.ts, which sends the last request of each
# example. `parity_mail_jobs` records the mail enqueue (the test adapter would swallow it) and `parity_timeline` the order of the
# statements and jobs. An example named "hands a ..." records what Node passes to Rails whole: the shape is not proven.
describe "Collaborators::MainController writes", type: :request, parity_timeline: true, parity_mail_jobs: true do
  include Parity::AudienceSignedIn

  let(:seller) { create(:named_seller, name: "Collab Seller") }
  let(:collaborator_user) { create(:user, name: "Collab Partner") }
  let!(:collaboration) { create(:collaborator, seller:, affiliate_user: collaborator_user) }

  before { host! DOMAIN }

  def as_team_member(role)
    member = create(:user, name: "#{role.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  # A slow recording would otherwise show the seed as `<now-5s>` where the replay's seed is `<now>`.
  def age_rows
    [Affiliate, Link, CollaboratorInvitation].each { _1.update_all(created_at: 2.hours.ago, updated_at: 2.hours.ago) }
  end

  def send_inertia(method, path, body = {})
    age_rows
    public_send(
      method, path,
      params: body.to_json,
      headers: { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml", "Content-Type" => "application/json", "X-CSRF-Token" => csrf_token }
    )
  end

  describe "POST /collaborators" do
    let(:invitee) { create(:user, name: "Invited Partner", username: "invitedpartner") }
    let(:product) { create(:product, user: seller, name: "Collab product") }
    let(:other_product) { create(:product, user: seller, name: "Second collab product") }

    def create_collaboration(body)
      send_inertia(:post, collaborators_path, { collaborator: body })
    end

    it "invites a collaborator on one product and mails the invitation", parity: true do
      log_in(seller)

      create_collaboration(email: invitee.email, apply_to_all_products: false, percent_commission: 25, products: [{ id: product.external_id, percent_commission: 25 }])

      expect(response).to have_http_status(:see_other)
      expect(response).to redirect_to(collaborators_path)
      created = seller.collaborators.find_by!(affiliate_user: invitee)
      expect(created.collaborator_invitation).to be_present
      expect(product.reload.is_collab?).to eq(true)
    end

    it "adds a collaborator who already accepted the seller as theirs, without an invitation", parity: true do
      create(:collaborator, seller: invitee, affiliate_user: seller)
      log_in(seller)

      create_collaboration(email: invitee.email, apply_to_all_products: true, percent_commission: 30, products: [{ id: product.external_id }])

      expect(response).to redirect_to(collaborators_path)
      expect(seller.collaborators.find_by!(affiliate_user: invitee).collaborator_invitation).to be_nil
    end

    it "saves a commission and credit setting for each of two products", parity: true do
      log_in(seller)

      create_collaboration(
        email: invitee.email, apply_to_all_products: false, percent_commission: 20,
        products: [
          { id: product.external_id, percent_commission: 20, dont_show_as_co_creator: true },
          { id: other_product.external_id, percent_commission: 35, dont_show_as_co_creator: false },
        ]
      )

      expect(response).to redirect_to(collaborators_path)
      expect(seller.collaborators.find_by!(affiliate_user: invitee).product_affiliates.count).to eq(2)
    end

    it "applies one commission to all products and hides the co-creator credit", parity: true do
      log_in(seller)

      create_collaboration(email: invitee.email, apply_to_all_products: true, percent_commission: 40, dont_show_as_co_creator: true, products: [{ id: product.external_id }, { id: other_product.external_id }])

      expect(response).to redirect_to(collaborators_path)
      expect(seller.collaborators.find_by!(affiliate_user: invitee)).to be_dont_show_as_co_creator
    end

    it "lets an admin team member add a collaborator", parity: true do
      as_team_member(TeamMembership::ROLE_ADMIN)

      create_collaboration(email: invitee.email, apply_to_all_products: true, percent_commission: 30, products: [{ id: product.external_id }])

      expect(response).to redirect_to(collaborators_path)
    end

    it "refuses an email that has no Gumroad account", parity: true do
      log_in(seller)

      create_collaboration(email: "nobody@example.com", apply_to_all_products: true, percent_commission: 30, products: [{ id: product.external_id }])

      expect(response).to redirect_to(new_collaborator_path)
      expect(flash[:alert]).to eq("The email address isn't associated with a Gumroad account.")
    end

    it "refuses a blank email", parity: true do
      log_in(seller)

      create_collaboration(email: "", apply_to_all_products: true, percent_commission: 30, products: [{ id: product.external_id }])

      expect(response).to redirect_to(new_collaborator_path)
    end

    it "refuses a user who is already a collaborator", parity: true do
      log_in(seller)

      create_collaboration(email: collaborator_user.email, apply_to_all_products: true, percent_commission: 30, products: [{ id: product.external_id }])

      expect(response).to redirect_to(new_collaborator_path)
      expect(flash[:alert]).to eq("The user is already a collaborator")
    end

    it "refuses a request without products", parity: true do
      log_in(seller)

      create_collaboration(email: invitee.email, apply_to_all_products: true, percent_commission: 30, products: [])

      expect(response).to redirect_to(new_collaborator_path)
      expect(flash[:alert]).to eq("At least one product must be selected")
    end

    it "refuses a product the seller does not have", parity: true do
      foreign_product = create(:product, user: create(:named_user, name: "Someone else"))
      log_in(seller)

      create_collaboration(email: invitee.email, apply_to_all_products: true, percent_commission: 30, products: [{ id: foreign_product.external_id }])

      expect(response).to redirect_to(new_collaborator_path)
      expect(flash[:alert]).to eq("Product not found")
    end

    it "refuses a user who reviews collaboration requests", parity: true do
      invitee.update!(require_collab_request_approval: true)
      log_in(seller)

      create_collaboration(email: invitee.email, apply_to_all_products: true, percent_commission: 30, products: [{ id: product.external_id }])

      expect(response).to redirect_to(new_collaborator_path)
      expect(flash[:alert]).to eq("You cannot add this user as a collaborator")
    end

    it "refuses a commission above the limit", parity: true do
      log_in(seller)

      create_collaboration(email: invitee.email, apply_to_all_products: true, percent_commission: 60, products: [{ id: product.external_id }])

      expect(response).to redirect_to(new_collaborator_path)
      expect(flash[:alert]).to eq("Product affiliates affiliate basis points must be less than or equal to 5000")
    end

    it "hands a product that already has a direct affiliate to Rails", parity: true do
      create(:direct_affiliate, seller:, products: [product])
      log_in(seller)

      create_collaboration(email: invitee.email, apply_to_all_products: true, percent_commission: 30, products: [{ id: product.external_id }])

      expect(response).to redirect_to(collaborators_path)
    end
  end

  describe "DELETE /collaborators/:id" do
    it "removes the collaboration for the seller and mails the collaborator", parity: true do
      log_in(seller)

      send_inertia(:delete, collaborator_path(collaboration.external_id))

      expect(response).to have_http_status(:see_other)
      expect(response).to redirect_to(collaborators_path)
      expect(flash[:notice]).to eq("The collaborator was removed successfully.")
      expect(collaboration.reload).to be_deleted
    end

    it "removes the collaboration for the collaborator and mails the seller", parity: true do
      log_in(collaborator_user)

      send_inertia(:delete, collaborator_path(collaboration.external_id))

      expect(response).to redirect_to(collaborators_path)
      expect(collaboration.reload).to be_deleted
    end

    it "removes the collaboration for an admin team member", parity: true do
      as_team_member(TeamMembership::ROLE_ADMIN)

      send_inertia(:delete, collaborator_path(collaboration.external_id))

      expect(response).to redirect_to(collaborators_path)
      expect(collaboration.reload).to be_deleted
    end

    it "clears the collab flag on every product of the collaboration", parity: true do
      first_product = create(:product, user: seller, name: "First product")
      second_product = create(:product, user: seller, name: "Second product")
      collaboration.product_affiliates.create!(product: first_product, affiliate_basis_points: 30_00)
      collaboration.product_affiliates.create!(product: second_product, affiliate_basis_points: 20_00)
      expect(first_product.reload.is_collab?).to eq(true)
      log_in(seller)

      send_inertia(:delete, collaborator_path(collaboration.external_id))

      expect(first_product.reload.is_collab?).to eq(false)
      expect(second_product.reload.is_collab?).to eq(false)
    end

    it "removes a collaboration that applies to all products", parity: true do
      product = create(:product, user: seller, name: "Only product")
      collaboration.update!(apply_to_all_products: true, affiliate_basis_points: 40_00)
      collaboration.product_affiliates.create!(product:, affiliate_basis_points: 40_00)
      log_in(seller)

      send_inertia(:delete, collaborator_path(collaboration.external_id))

      expect(collaboration.reload).to be_deleted
      expect(product.reload.is_collab?).to eq(false)
    end

    it "removes a collaboration whose invitation is still pending", parity: true do
      collaboration.create_collaborator_invitation!
      log_in(seller)

      send_inertia(:delete, collaborator_path(collaboration.external_id))

      expect(collaboration.reload).to be_deleted
    end
  end
end
