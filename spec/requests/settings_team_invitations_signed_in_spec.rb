# frozen_string_literal: true

require "spec_helper"

# Settings::Team::InvitationsController the way the team page calls it (JSON body, the CSRF token in a header) and the emailed accept
# link, recorded for the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/settings-mutations.replay.test.ts, which
# sends the last request of each example. The examples named "hands ..." are the requests Node leaves to Rails: the join of the Gumroad
# account's team (it flags the member) and a mailbox only Mail::AddressList can read.
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

  # The mail jobs of a request spec go through the test adapter, so the fixture holds none; the replay asserts the same job.
  def enqueued_invitation_mails
    ActiveJob::Base.queue_adapter.enqueued_jobs.select { _1["arguments"].first(2) == %w[TeamMailer invite] }
  end

  def expect_invitation_mail_for(record)
    mail = enqueued_invitation_mails.sole
    expect(mail["queue_name"]).to eq("default")
    expect(mail["arguments"].last["args"]).to eq([{ "_aj_globalid" => "gid://gumroad/TeamInvitation/#{record.id}" }])
  end

  # The send throttle is a sorted set, which a recording does not capture: the replay refills it from the example's name.
  def fill_send_throttle(count, seconds_ago)
    count.times { |index| $redis.zadd(RedisKey.team_invitation_send_throttle(seller.id), seconds_ago.seconds.ago.to_f, "send#{index}") }
  end

  def burst_report(window)
    ["risk", "Team invitations rate limited", "Seller teaminvites (#{seller.email}) was refused team invitations past #{window}. Admin: #{seller.external_id}"]
  end

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

    it "extends the expiry and enqueues the invitation mail", parity: true do
      invitation.update_column(:expires_at, 1.day.from_now)
      log_in(seller)

      send_json(:put, resend_invitation_settings_team_invitation_path(invitation.external_id, format: :json))

      expect(response.parsed_body).to eq("success" => true)
      expect(invitation.reload.expires_at).to be > 6.days.from_now
      expect_invitation_mail_for(invitation)
    end

    it "refuses past the hourly allowance and reports the burst", parity: true do
      fill_send_throttle(10, 150)
      log_in(seller)

      send_json(:put, resend_invitation_settings_team_invitation_path(invitation.external_id, format: :json))

      expect(response).to have_http_status(:too_many_requests)
      expect(response.parsed_body["error"]).to eq("You've reached the limit of 10 team invitations per hour. You can invite again in 58 minutes.")
      expect(response.headers["Retry-After"].to_i).to eq(response.parsed_body["retry_after"])
      expect(InternalNotificationWorker.jobs.map { _1["args"] }).to eq([burst_report("10/hour")])
      expect(enqueued_invitation_mails).to be_empty
    end

    it "hands a resend of a quoted-mailbox invitation to Rails", parity: true do
      invitation.update_column(:email, '"quoted name"@example.com')
      log_in(seller)

      send_json(:put, resend_invitation_settings_team_invitation_path(invitation.external_id, format: :json))

      expect(response.parsed_body).to eq("success" => true)
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

    it "creates the invitation, expiring at the end of the day a week out, and enqueues the invitation mail", parity: true do
      log_in(seller)

      send_json(:post, invite_path, team_invitation: { email: " New@Example.com ", role: TeamMembership::ROLE_SUPPORT })

      expect(response.parsed_body).to eq("success" => true)
      created = seller.team_invitations.find_by!(email: "new@example.com")
      expect(created.role).to eq(TeamMembership::ROLE_SUPPORT)
      # The column keeps microseconds, which is all of the end of the day it can hold.
      expect(created.expires_at.iso8601(6)).to eq(TeamInvitation::ACTIVE_INTERVAL_IN_DAYS.days.from_now.at_end_of_day.iso8601(6))
      expect_invitation_mail_for(created)
    end

    it "does not count invitations against a reviewed seller", parity: true do
      seller.update_columns(user_risk_state: "compliant")
      2.times { |index| create(:team_invitation, seller:, email: "earlier#{index}@example.com", role: TeamInvitation::ROLES.first) }
      log_in(seller)

      send_json(:post, invite_path, team_invitation: { email: "new@example.com", role: TeamMembership::ROLE_SUPPORT })

      expect(response.parsed_body).to eq("success" => true)
      expect(seller.team_invitations.count).to eq(4)
      expect(InternalNotificationWorker.jobs).to be_empty
    end

    it "refuses an unreviewed seller at the total cap, removed invitations included, and reports the burst", parity: true do
      2.times { |index| create(:team_invitation, seller:, email: "earlier#{index}@example.com", role: TeamInvitation::ROLES.first, deleted_at: Time.current) }
      log_in(seller)

      send_json(:post, invite_path, team_invitation: { email: "new@example.com", role: TeamMembership::ROLE_SUPPORT })

      expect(response.parsed_body).to eq("success" => false, "error_message" => "New accounts can have up to 3 team invitations while the account is being reviewed. Please contact support if you need more.")
      expect(seller.team_invitations.count).to eq(3)
      expect(InternalNotificationWorker.jobs.map { _1["args"] }).to eq([burst_report("3/account")])
      expect(enqueued_invitation_mails).to be_empty
    end

    it "refuses past the hourly allowance and reports the burst", parity: true do
      seller.update_columns(user_risk_state: "compliant")
      fill_send_throttle(10, 150)
      log_in(seller)

      send_json(:post, invite_path, team_invitation: { email: "new@example.com", role: TeamMembership::ROLE_SUPPORT })

      expect(response).to have_http_status(:too_many_requests)
      expect(response.parsed_body["error"]).to eq("You've reached the limit of 10 team invitations per hour. You can invite again in 58 minutes.")
      expect(response.headers["Retry-After"].to_i).to eq(response.parsed_body["retry_after"])
      expect(seller.team_invitations.count).to eq(1)
      expect(InternalNotificationWorker.jobs.map { _1["args"] }).to eq([burst_report("10/hour")])
      expect(enqueued_invitation_mails).to be_empty
    end

    it "refuses past the daily allowance without reporting a seller reported already", parity: true do
      seller.update_columns(user_risk_state: "compliant")
      fill_send_throttle(50, 7230)
      $redis.set(RedisKey.team_invitation_burst_reported(seller.id), 1)
      log_in(seller)

      send_json(:post, invite_path, team_invitation: { email: "new@example.com", role: TeamMembership::ROLE_SUPPORT })

      expect(response).to have_http_status(:too_many_requests)
      expect(response.parsed_body["error"]).to eq("You've reached the limit of 50 team invitations per day. You can invite again in 22 hours.")
      expect(seller.team_invitations.count).to eq(1)
      expect(InternalNotificationWorker.jobs).to be_empty
    end

    it "hands a quoted-mailbox invitation to Rails", parity: true do
      log_in(seller)

      send_json(:post, invite_path, team_invitation: { email: '"quoted name"@example.com', role: TeamMembership::ROLE_SUPPORT })

      expect(response.parsed_body).to eq("success" => true)
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

    it "joins the team, keeps an owner membership for the invitee and switches to the seller's account", parity: true do
      log_in(invitee)

      accept

      expect(response).to redirect_to(dashboard_url(host: DOMAIN))
      expect(flash[:notice]).to eq("Welcome to the team at teaminvites!")
      membership = seller.seller_memberships.find_by!(user: invitee)
      expect(membership.role).to eq(invitation.role)
      expect(membership.last_accessed_at).to be_present
      expect(invitee.user_memberships.role_owner.count).to eq(1)
      expect(invitation.reload).to be_accepted.and be_deleted
      expect(response.get_header("set-cookie").to_s).to include("current_seller_id=")
      mail = ActiveJob::Base.queue_adapter.enqueued_jobs.select { _1["arguments"].first(2) == %w[TeamMailer invitation_accepted] }.sole
      expect(mail["queue_name"]).to eq("default")
    end

    it "joins with the role of the invitation", parity: true do
      invitation.update_column(:role, TeamMembership::ROLE_MARKETING)
      log_in(invitee)

      accept

      expect(seller.seller_memberships.find_by!(user: invitee).role).to eq(TeamMembership::ROLE_MARKETING)
    end

    it "hands a join of the Gumroad account's team to Rails", parity: true do
      seller.update_columns(email: ApplicationMailer::ADMIN_EMAIL)
      log_in(invitee)

      accept

      expect(flash[:notice]).to eq("Welcome to the team at teaminvites!")
      expect(invitee.reload.is_team_member).to be(true)
    end
  end
end
