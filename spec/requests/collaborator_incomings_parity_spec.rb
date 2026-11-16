# frozen_string_literal: true

require "spec_helper"

# Collaborators::IncomingsController: the incoming collaborations page and the guards of #accept, #decline and #destroy that Node
# answers, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/collaborator-incomings.replay.test.ts, which sends the last request of each example. An example named
# "hands a ..." records what Node passes to Rails whole: the shape is not proven. The writes run in Node; `parity_mail_jobs` records the
# mail enqueue and `parity_timeline` the order of statements and jobs.
describe "Collaborators::IncomingsController", type: :request do
  include Parity::AudienceSignedIn

  let(:inviter) { create(:named_seller, name: "Inviting Seller") }
  let(:invitee) { create(:user, name: "Invited Seller") }
  let!(:pending) { create(:collaborator, :with_pending_invitation, seller: inviter, affiliate_user: invitee) }

  before { host! DOMAIN }

  def as_team_member(role)
    member = create(:user, name: "#{role.capitalize} Member")
    membership = create(:team_membership, user: member, seller: invitee, role:)
    log_in(member)
    switch_to(membership)
  end

  # A slow recording would otherwise show the seed as `<now-5s>` where the replay's seed is `<now>`.
  def age_rows
    [Affiliate, Link, CollaboratorInvitation].each { _1.update_all(created_at: 2.hours.ago, updated_at: 2.hours.ago) }
  end

  def send_form(method, path)
    age_rows
    token = csrf_token
    public_send(method, path, params: { authenticity_token: token })
  end

  describe "GET /collaborators/incomings" do
    it "lists pending invitations before accepted collaborations, with their products", parity: true do
      first_product = create(:product, user: inviter, name: "First product")
      second_product = create(:product, user: inviter, name: "Second product")
      pending.product_affiliates.create!(product: first_product, affiliate_basis_points: 35_00)
      pending.product_affiliates.create!(product: second_product, affiliate_basis_points: nil)
      accepted_seller = create(:user, username: "acceptedseller", name: "Accepted Seller")
      accepted = create(:collaborator, seller: accepted_seller, affiliate_user: invitee, affiliate_basis_points: 20_00)
      accepted.product_affiliates.create!(product: create(:product, user: accepted_seller, name: "Accepted product"), affiliate_basis_points: 20_00)
      log_in(invitee)

      get collaborators_incomings_path

      expect(response).to be_successful
      props = inertia_props_of(response)
      expect(props["collaborators"].map { _1["id"] }).to eq([pending.external_id, accepted.external_id])
      expect(props["collaborators"].first["products"].map { _1["name"] }).to eq(["First product", "Second product"])
    end

    it "renders an empty list when nobody invited the seller", parity: true do
      pending.destroy!
      log_in(invitee)

      get collaborators_incomings_path

      expect(inertia_props_of(response)).to include("collaborators" => [], "collaborators_disabled_reason" => nil)
    end

    it "leaves out deleted collaborations and those of other sellers", parity: true do
      pending.mark_deleted!
      create(:collaborator, :with_pending_invitation, seller: inviter, affiliate_user: create(:user, username: "someoneelse"))
      log_in(invitee)

      get collaborators_incomings_path

      expect(inertia_props_of(response)["collaborators"]).to eq([])
    end

    it "shows a collaboration that applies to all products and hides the co-creator credit", parity: true do
      pending.update_columns(affiliate_basis_points: 45_00)
      pending.update!(apply_to_all_products: true, dont_show_as_co_creator: true)
      log_in(invitee)

      get collaborators_incomings_path

      expect(inertia_props_of(response)["collaborators"].first).to include("apply_to_all_products" => true, "dont_show_as_co_creator" => true, "percent_commission" => 45)
    end

    it "falls back to the default commission when none is set", parity: true do
      pending.update_columns(affiliate_basis_points: nil, flags: 0)
      log_in(invitee)

      get collaborators_incomings_path

      expect(inertia_props_of(response)["collaborators"].first["percent_commission"]).to eq(50)
    end

    it "turns collaborators off for a seller whose linked Stripe Connect account is Brazilian", parity: true do
      create(:merchant_account_stripe_connect, user: invitee, country: "BR")
      invitee.update_attribute(:check_merchant_account_is_linked, true)
      log_in(invitee)

      get collaborators_incomings_path

      expect(inertia_props_of(response)["collaborators_disabled_reason"]).to eq("Collaborators with Brazilian Stripe accounts are not supported.")
    end

    it "sends a marketing member to the dashboard", parity: true do
      as_team_member(:marketing)

      get collaborators_incomings_path

      expect(response).to have_http_status(:found)
      expect(response.location).to end_with("/dashboard")
      expect(flash[:alert]).to eq("Your current role as Marketing cannot perform this action.")
    end

    it "lets an admin member in", parity: true do
      as_team_member(:admin)

      get collaborators_incomings_path

      expect(response).to be_successful
      expect(inertia_props_of(response)["collaborators"].size).to eq(1)
    end
  end

  describe "POST /collaborators/incomings/:id/accept", parity_timeline: true, parity_mail_jobs: true do
    let(:path) { "/collaborators/incomings/#{pending.external_id}/accept" }

    it "sends a signed-out visitor to sign in", parity: true do
      send_form(:post, path)

      expect(response).to redirect_to("/login?next=%2Fcollaborators%2Fincomings%2F#{CGI.escape(pending.external_id)}%2Faccept")
    end

    it "answers not found for an id that does not exist", parity: true do
      log_in(invitee)

      send_form(:post, "/collaborators/incomings/not-an-id/accept")

      expect(response).to have_http_status(:not_found)
    end

    it "answers not found for a deleted collaboration", parity: true do
      pending.mark_deleted!
      log_in(invitee)

      send_form(:post, path)

      expect(response).to have_http_status(:not_found)
    end

    it "answers a signed-out visitor not found for a deleted collaboration", parity: true do
      pending.mark_deleted!

      send_form(:post, path)

      expect(response).to have_http_status(:not_found)
    end

    it "answers not found when the invitation was already answered", parity: true do
      pending.collaborator_invitation.destroy!
      log_in(invitee)

      send_form(:post, path)

      expect(response).to have_http_status(:not_found)
    end

    it "sends a signed-out visitor to sign in before looking for the invitation", parity: true do
      pending.collaborator_invitation.destroy!

      send_form(:post, path)

      expect(response).to have_http_status(:found)
      expect(response.location).to include("/login")
    end

    it "sends another seller to the dashboard", parity: true do
      log_in(create(:user, username: "otherseller", name: "Other Seller"))

      send_form(:post, path)

      expect(response).to have_http_status(:found)
      expect(response.location).to end_with("/dashboard")
      expect(flash[:alert]).to eq("You are not allowed to perform this action.")
      expect(pending.reload.deleted?).to eq(false)
    end

    it "sends the inviting seller to the dashboard", parity: true do
      log_in(inviter)

      send_form(:post, path)

      expect(response.location).to end_with("/dashboard")
      expect(pending.reload.collaborator_invitation).to be_present
    end

    it "refuses a support member", parity: true do
      as_team_member(:support)

      send_form(:post, path)

      expect(response.location).to end_with("/dashboard")
      expect(flash[:alert]).to eq("Your current role as Support cannot perform this action.")
    end

    it "refuses a marketing member", parity: true do
      as_team_member(:marketing)

      send_form(:post, path)

      expect(flash[:alert]).to eq("Your current role as Marketing cannot perform this action.")
    end

    it "accepts the invitation, destroys it and queues the mail to the inviter", parity: true do
      log_in(invitee)

      send_form(:post, path)

      expect(response).to redirect_to("/collaborators/incomings")
      expect(flash[:notice]).to eq("Invitation accepted")
      expect(pending.reload.collaborator_invitation).to be_nil
    end

    it "accepts the invitation for an admin team member", parity: true do
      as_team_member(:admin)

      send_form(:post, path)

      expect(flash[:notice]).to eq("Invitation accepted")
    end
  end

  describe "POST /collaborators/incomings/:id/decline", parity_timeline: true, parity_mail_jobs: true do
    let(:path) { "/collaborators/incomings/#{pending.external_id}/decline" }

    it "sends a signed-out visitor to sign in", parity: true do
      send_form(:post, path)

      expect(response).to redirect_to("/login?next=%2Fcollaborators%2Fincomings%2F#{CGI.escape(pending.external_id)}%2Fdecline")
    end

    it "answers not found for an id that does not exist", parity: true do
      log_in(invitee)

      send_form(:post, "/collaborators/incomings/not-an-id/decline")

      expect(response).to have_http_status(:not_found)
    end

    it "answers not found for a deleted collaboration", parity: true do
      pending.mark_deleted!
      log_in(invitee)

      send_form(:post, path)

      expect(response).to have_http_status(:not_found)
    end

    it "answers a signed-out visitor not found for a deleted collaboration", parity: true do
      pending.mark_deleted!

      send_form(:post, path)

      expect(response).to have_http_status(:not_found)
    end

    it "answers not found when the invitation was already answered", parity: true do
      pending.collaborator_invitation.destroy!
      log_in(invitee)

      send_form(:post, path)

      expect(response).to have_http_status(:not_found)
    end

    it "sends a signed-out visitor to sign in before looking for the invitation", parity: true do
      pending.collaborator_invitation.destroy!

      send_form(:post, path)

      expect(response).to have_http_status(:found)
      expect(response.location).to include("/login")
    end

    it "sends another seller to the dashboard", parity: true do
      log_in(create(:user, username: "otherseller", name: "Other Seller"))

      send_form(:post, path)

      expect(response).to have_http_status(:found)
      expect(response.location).to end_with("/dashboard")
      expect(flash[:alert]).to eq("You are not allowed to perform this action.")
      expect(pending.reload.deleted?).to eq(false)
    end

    it "sends the inviting seller to the dashboard", parity: true do
      log_in(inviter)

      send_form(:post, path)

      expect(response.location).to end_with("/dashboard")
      expect(pending.reload.collaborator_invitation).to be_present
    end

    it "refuses a support member", parity: true do
      as_team_member(:support)

      send_form(:post, path)

      expect(response.location).to end_with("/dashboard")
      expect(flash[:alert]).to eq("Your current role as Support cannot perform this action.")
    end

    it "refuses a marketing member", parity: true do
      as_team_member(:marketing)

      send_form(:post, path)

      expect(flash[:alert]).to eq("Your current role as Marketing cannot perform this action.")
    end

    it "declines the invitation, ends the collaboration and queues the mail to the inviter", parity: true do
      log_in(invitee)

      send_form(:post, path)

      expect(response).to redirect_to("/collaborators/incomings")
      expect(flash[:notice]).to eq("Invitation declined")
      expect(pending.reload.deleted?).to eq(true)
    end

    it "clears the collab flag on the products of a declined collaboration", parity: true do
      first_product = create(:product, user: inviter, name: "First product")
      second_product = create(:product, user: inviter, name: "Second product")
      pending.product_affiliates.create!(product: first_product, affiliate_basis_points: 35_00)
      pending.product_affiliates.create!(product: second_product, affiliate_basis_points: 40_00)
      expect(first_product.reload.is_collab?).to eq(true)
      log_in(invitee)

      send_form(:post, path)

      expect(first_product.reload.is_collab?).to eq(false)
      expect(second_product.reload.is_collab?).to eq(false)
    end

    it "declines the invitation for an admin team member", parity: true do
      as_team_member(:admin)

      send_form(:post, path)

      expect(flash[:notice]).to eq("Invitation declined")
    end
  end

  describe "DELETE /collaborators/incomings/:id", parity_timeline: true, parity_mail_jobs: true do
    let(:accepted_seller) { create(:user, username: "acceptedseller", name: "Accepted Seller") }
    let!(:accepted) { create(:collaborator, seller: accepted_seller, affiliate_user: invitee) }
    let(:path) { "/collaborators/incomings/#{accepted.external_id}" }

    it "sends a signed-out visitor to sign in", parity: true do
      send_form(:delete, path)

      expect(response).to redirect_to("/login?next=%2Fcollaborators%2Fincomings%2F#{CGI.escape(accepted.external_id)}")
    end

    it "answers not found for an id that does not exist", parity: true do
      log_in(invitee)

      send_form(:delete, "/collaborators/incomings/not-an-id")

      expect(response).to have_http_status(:not_found)
    end

    it "answers not found for a deleted collaboration", parity: true do
      accepted.mark_deleted!
      log_in(invitee)

      send_form(:delete, path)

      expect(response).to have_http_status(:not_found)
    end

    it "sends another seller to the dashboard", parity: true do
      log_in(create(:user, username: "otherseller", name: "Other Seller"))

      send_form(:delete, path)

      expect(response.location).to end_with("/dashboard")
      expect(flash[:alert]).to eq("You are not allowed to perform this action.")
      expect(accepted.reload.deleted?).to eq(false)
    end

    it "refuses a support member", parity: true do
      as_team_member(:support)

      send_form(:delete, path)

      expect(flash[:alert]).to eq("Your current role as Support cannot perform this action.")
    end

    it "removes the collaboration for the invited seller and mails the inviter", parity: true do
      log_in(invitee)

      send_form(:delete, path)

      expect(response).to redirect_to("/collaborators/incomings")
      expect(flash[:notice]).to eq("Collaborator removed")
      expect(accepted.reload.deleted?).to eq(true)
    end

    it "removes the collaboration for the inviting seller and mails the invited seller", parity: true do
      log_in(accepted_seller)

      send_form(:delete, path)

      expect(flash[:notice]).to eq("Collaborator removed")
    end

    it "removes a collaboration with products and clears their collab flag", parity: true do
      product = create(:product, user: accepted_seller, name: "Shared product")
      accepted.product_affiliates.create!(product:, affiliate_basis_points: 20_00)
      log_in(invitee)

      send_form(:delete, path)

      expect(flash[:notice]).to eq("Collaborator removed")
      expect(product.reload.is_collab?).to eq(false)
    end

    it "removes an accepted collaboration for an admin team member of the inviting seller", parity: true do
      member = create(:user, name: "Admin Member")
      membership = create(:team_membership, user: member, seller: accepted_seller, role: :admin)
      log_in(member)
      switch_to(membership)

      send_form(:delete, path)

      expect(flash[:notice]).to eq("Collaborator removed")
    end

    it "removes a collaboration whose invitation is still pending", parity: true do
      log_in(invitee)

      send_form(:delete, "/collaborators/incomings/#{pending.external_id}")

      expect(flash[:notice]).to eq("Collaborator removed")
    end
  end
end
