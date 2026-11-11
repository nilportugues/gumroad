# frozen_string_literal: true

require "spec_helper"

# Settings::Team::InvitationsController the way the team page calls it (JSON body, the CSRF token in a header) and the emailed accept
# link, recorded for the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/settings-mutations.replay.test.ts, which
# sends the last request of each example. The examples named "hands ..." are the sends and joins Node leaves to Rails.
describe "Settings team invitations when signed in", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Settings Seller", username: "teaminvites", created_at: Time.utc(2025, 1, 1)) }
  let(:json_headers) { { "Accept" => "application/json", "Content-Type" => "application/json" } }
  let!(:invitation) { create(:team_invitation, seller:, email: "invitee@example.com", role: TeamInvitation::ROLES.first) }

  before { host! DOMAIN }

  def send_json(method, path, body = nil)
    public_send(method, path, params: body&.to_json, headers: json_headers.merge("X-CSRF-Token" => csrf_token))
  end

  def member_with_role(role)
    member = create(:user, name: "Team Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
    member
  end

  def invitation_path(record = invitation) = settings_team_invitation_path(record.external_id, format: :json)

  describe "updating the role" do
    it "changes the role", parity: true do
      log_in(seller)

      send_json(:put, invitation_path, team_invitation: { role: TeamInvitation::ROLES.last })

      expect(response.parsed_body).to eq("success" => true)
      expect(invitation.reload.role).to eq(TeamInvitation::ROLES.last)
    end

    it "accepts PATCH", parity: true do
      log_in(seller)

      send_json(:patch, invitation_path, team_invitation: { role: TeamMembership::ROLE_SUPPORT })

      expect(response.parsed_body).to eq("success" => true)
      expect(invitation.reload.role).to eq(TeamMembership::ROLE_SUPPORT)
    end

    it "saves nothing and succeeds when the hash has no role", parity: true do
      log_in(seller)

      send_json(:put, invitation_path, team_invitation: { email: "other@example.com" })

      expect(response.parsed_body).to eq("success" => true)
      expect(invitation.reload.email).to eq("invitee@example.com")
    end

    [["a role outside the invitation roles", "owner"], ["a null role", nil]].each do |label, role|
      it "answers the validation error for #{label}", parity: true do
        log_in(seller)

        send_json(:put, invitation_path, team_invitation: { role: })

        expect(response.parsed_body).to eq("success" => false, "error_message" => "Role is not included in the list")
        expect(invitation.reload.role).to eq(TeamInvitation::ROLES.first)
      end
    end

    it "answers the validation error of a member who joined with the invited email", parity: true do
      create(:team_membership, user: create(:user, email: "invitee@example.com"), seller:, role: TeamMembership::ROLE_SUPPORT)
      log_in(seller)

      send_json(:put, invitation_path, team_invitation: { role: TeamMembership::ROLE_SUPPORT })

      expect(response.parsed_body).to eq("success" => false, "error_message" => "Email is associated with an existing team member")
    end

    it "answers 404 JSON for an invitation of another seller", parity: true do
      other = create(:team_invitation, role: TeamInvitation::ROLES.first)
      log_in(seller)

      send_json(:put, invitation_path(other), team_invitation: { role: TeamMembership::ROLE_SUPPORT })

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "error" => "Not found")
    end

    it "refuses a member whose role cannot manage the team", parity: true do
      member_with_role(TeamMembership::ROLE_SUPPORT)

      send_json(:put, invitation_path, team_invitation: { role: TeamMembership::ROLE_SUPPORT })

      expect(response).to have_http_status(:unauthorized)
      expect(invitation.reload.role).to eq(TeamInvitation::ROLES.first)
    end

    it "hands a request without a team_invitation hash to Rails", parity: true do
      log_in(seller)

      send_json(:put, invitation_path, {})

      expect(response).to have_http_status(:bad_request)
    end

    it "hands a quoted-mailbox invitation to Rails", parity: true do
      invitation.update_column(:email, '"quoted name"@example.com')
      log_in(seller)

      send_json(:put, invitation_path, team_invitation: { role: TeamMembership::ROLE_SUPPORT })

      expect(response.parsed_body).to include("success" => true)
    end
  end

  describe "removing and restoring" do
    it "removes an invitation and restores it", parity: true do
      log_in(seller)

      send_json(:delete, invitation_path)

      expect(response.parsed_body).to eq("success" => true)
      expect(invitation.reload.deleted?).to be(true)

      send_json(:put, restore_settings_team_invitation_path(invitation.external_id, format: :json))

      expect(response.parsed_body).to eq("success" => true)
      expect(invitation.reload.deleted?).to be(false)
    end

    it "answers 404 JSON when removing an invitation of another seller", parity: true do
      other = create(:team_invitation, role: TeamInvitation::ROLES.first)
      log_in(seller)

      send_json(:delete, invitation_path(other))

      expect(response).to have_http_status(:not_found)
      expect(other.reload.deleted?).to be(false)
    end

    it "refuses a member whose role cannot manage the team to remove an invitation", parity: true do
      member_with_role(TeamMembership::ROLE_MARKETING)

      send_json(:delete, invitation_path)

      expect(response).to have_http_status(:unauthorized)
      expect(invitation.reload.deleted?).to be(false)
    end

    it "answers the validation error when the email was invited again after the removal", parity: true do
      invitation.update_as_deleted!
      create(:team_invitation, seller:, email: "invitee@example.com", role: TeamInvitation::ROLES.first)
      log_in(seller)

      send_json(:put, restore_settings_team_invitation_path(invitation.external_id, format: :json))

      expect(response.parsed_body).to eq("success" => false, "error_message" => "Email has already been invited")
      expect(invitation.reload.deleted?).to be(true)
    end
  end

  describe "resending" do
    it "answers 422 for an invitation whose email is not valid", parity: true do
      invitation.update_column(:email, "not-an-email")
      log_in(seller)

      send_json(:put, resend_invitation_settings_team_invitation_path(invitation.external_id, format: :json))

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body).to eq("success" => false, "error_message" => "Email is invalid")
    end

    it "answers 404 JSON for an invitation of another seller", parity: true do
      other = create(:team_invitation, role: TeamInvitation::ROLES.first)
      log_in(seller)

      send_json(:put, resend_invitation_settings_team_invitation_path(other.external_id, format: :json))

      expect(response).to have_http_status(:not_found)
    end

    it "refuses a member whose role cannot manage the team", parity: true do
      member_with_role(TeamMembership::ROLE_SUPPORT)

      send_json(:put, resend_invitation_settings_team_invitation_path(invitation.external_id, format: :json))

      expect(response).to have_http_status(:unauthorized)
    end

    it "refuses a member of a suspended seller", parity: true do
      member_with_role(TeamMembership::ROLE_ADMIN)
      seller.update_columns(user_risk_state: "suspended_for_fraud")

      send_json(:put, resend_invitation_settings_team_invitation_path(invitation.external_id, format: :json))

      expect(response).to have_http_status(:forbidden)
      expect(response.parsed_body).to eq("success" => false, "error_message" => "Your account can't send team invitations right now.")
    end

    it "hands a resend of a valid invitation to Rails", parity: true do
      log_in(seller)

      send_json(:put, resend_invitation_settings_team_invitation_path(invitation.external_id, format: :json))

      expect(response.parsed_body).to eq("success" => true)
      expect(invitation.reload.expires_at).to be > 6.days.from_now
    end
  end

  describe "inviting" do
    let(:invite_path) { settings_team_invitations_path(format: :json) }

    it "answers the validation error for an email that is not valid", parity: true do
      log_in(seller)

      send_json(:post, invite_path, team_invitation: { email: "not-an-email", role: TeamMembership::ROLE_SUPPORT })

      expect(response.parsed_body).to eq("success" => false, "error_message" => "Email is invalid")
    end

    it "answers the validation errors for a missing email and a role outside the invitation roles", parity: true do
      log_in(seller)

      send_json(:post, invite_path, team_invitation: { role: "owner" })

      expect(response.parsed_body).to eq("success" => false, "error_message" => "Email is invalid and Role is not included in the list")
    end

    it "answers the validation error for an email invited already, whatever its case", parity: true do
      log_in(seller)

      send_json(:post, invite_path, team_invitation: { email: " Invitee@Example.com ", role: TeamMembership::ROLE_SUPPORT })

      expect(response.parsed_body).to eq("success" => false, "error_message" => "Email has already been invited")
    end

    it "answers the validation error for the email of a team member", parity: true do
      create(:team_membership, user: create(:user, email: "member@example.com"), seller:, role: TeamMembership::ROLE_SUPPORT)
      log_in(seller)

      send_json(:post, invite_path, team_invitation: { email: "member@example.com", role: TeamMembership::ROLE_SUPPORT })

      expect(response.parsed_body).to eq("success" => false, "error_message" => "Email is associated with an existing team member")
    end

    it "refuses a member whose role cannot manage the team", parity: true do
      member_with_role(TeamMembership::ROLE_SUPPORT)

      send_json(:post, invite_path, team_invitation: { email: "new@example.com", role: TeamMembership::ROLE_SUPPORT })

      expect(response).to have_http_status(:unauthorized)
      expect(seller.team_invitations.count).to eq(1)
    end

    it "refuses a member of a suspended seller", parity: true do
      member_with_role(TeamMembership::ROLE_ADMIN)
      seller.update_columns(user_risk_state: "suspended_for_fraud")

      send_json(:post, invite_path, team_invitation: { email: "new@example.com", role: TeamMembership::ROLE_SUPPORT })

      expect(response).to have_http_status(:forbidden)
      expect(seller.team_invitations.count).to eq(1)
    end

    it "hands a valid invitation to Rails", parity: true do
      log_in(seller)

      send_json(:post, invite_path, team_invitation: { email: "new@example.com", role: TeamMembership::ROLE_SUPPORT })

      expect(response.parsed_body).to eq("success" => true)
      expect(seller.team_invitations.pluck(:email)).to include("new@example.com")
    end

    it "hands a request without a team_invitation hash to Rails", parity: true do
      log_in(seller)

      send_json(:post, invite_path, {})

      expect(response).to have_http_status(:bad_request)
    end
  end

  describe "accepting the emailed link" do
    let(:invitee) { create(:user, name: "Invitee", email: "invitee@example.com") }

    def accept(record = invitation)
      get accept_settings_team_invitation_path(record.external_id)
    end

    it "flashes the mismatch for another email address", parity: true do
      log_in(create(:user, name: "Someone Else", email: "someone@example.com"))

      accept

      expect(response).to redirect_to(dashboard_url(host: DOMAIN))
      expect(flash[:alert]).to eq("The invite was sent to a different email address. You are logged in as someone@example.com")
    end

    it "flashes that the link has expired", parity: true do
      invitation.update_column(:expires_at, 2.days.ago)
      log_in(invitee)

      accept

      expect(response).to redirect_to(dashboard_url(host: DOMAIN))
      expect(flash[:alert]).to eq("Invitation link has expired. Please contact the account owner.")
    end

    it "flashes that the invitation was accepted already", parity: true do
      invitation.update_column(:accepted_at, 1.hour.ago)
      log_in(invitee)

      accept

      expect(flash[:alert]).to eq("Invitation has already been accepted.")
    end

    it "flashes that the link is invalid after the invitation was removed", parity: true do
      invitation.update_as_deleted!
      log_in(invitee)

      accept

      expect(flash[:alert]).to eq("Invitation link is invalid. Please contact the account owner.")
    end

    it "flashes that the link is invalid for a suspended seller", parity: true do
      seller.update_columns(user_risk_state: "suspended_for_fraud")
      log_in(invitee)

      accept

      expect(flash[:alert]).to eq("Invitation link is invalid. Please contact the account owner.")
      expect(invitation.reload.deleted?).to be(false)
    end

    it "removes the invitation when the owner took its email address", parity: true do
      invitee
      seller.update_columns(email: "invitee@example.com")
      log_in(invitee)

      accept

      expect(flash[:alert]).to eq("Invitation link is invalid. Please contact the account owner.")
      expect(invitation.reload.deleted?).to be(true)
    end

    it "answers 404 for an unknown invitation", parity: true do
      log_in(invitee)
      other = create(:team_invitation, role: TeamInvitation::ROLES.first)
      other_path = accept_settings_team_invitation_path(other.external_id)
      other.destroy!

      get other_path

      expect(response).to have_http_status(:not_found)
    end

    it "refuses a user who is working on another seller's account", parity: true do
      membership = create(:team_membership, user: invitee, seller:, role: TeamMembership::ROLE_SUPPORT)
      log_in(invitee)
      switch_to(membership)

      accept

      expect(response).to redirect_to(dashboard_url(host: DOMAIN))
      expect(flash[:alert]).to eq("Your current role as Support cannot perform this action.")
    end

    it "hands a join of the team to Rails", parity: true do
      log_in(invitee)

      accept

      expect(response).to redirect_to(dashboard_url(host: DOMAIN))
      expect(flash[:notice]).to eq("Welcome to the team at teaminvites!")
    end
  end
end
