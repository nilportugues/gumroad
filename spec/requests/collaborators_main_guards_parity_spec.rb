# frozen_string_literal: true

require "spec_helper"

# The guards of Collaborators::MainController#create, #update and #destroy that Node answers in front of the write, recorded for the
# Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/ws12n.replay.test.ts, which sends the last request of each
# example. An example named "hands a ..." records what Node passes to Rails whole: the write mails the collaborator.
describe "Collaborators::MainController guards", type: :request do
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

  def send_inertia(method, path, body = {})
    public_send(
      method, path,
      params: body.to_json,
      headers: { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml", "Content-Type" => "application/json", "X-CSRF-Token" => csrf_token }
    )
  end

  let(:new_collaboration) { { collaborator: { email: collaborator_user.email, apply_to_all_products: true, percent_commission: 30 } } }

  describe "POST /collaborators" do
    it "sends a signed-out visitor to sign in", parity: true do
      send_inertia(:post, collaborators_path, new_collaboration)

      expect(response).to have_http_status(:found)
      expect(response.location).to start_with("#{PROTOCOL}://#{DOMAIN}/login")
    end

    it "sends a marketing team member away with the role in the flash", parity: true do
      as_team_member(TeamMembership::ROLE_MARKETING)

      send_inertia(:post, collaborators_path, new_collaboration)

      expect(response).to redirect_to(dashboard_url)
      expect(flash[:alert]).to eq("Your current role as Marketing cannot perform this action.")
    end

    it "hands an invitation of a collaborator to Rails", parity: true do
      other = create(:user, name: "Invited Partner")
      log_in(seller)

      send_inertia(:post, collaborators_path, { collaborator: { email: other.email, apply_to_all_products: true, percent_commission: 30 } })

      expect(response).to be_redirect
    end
  end

  describe "PATCH /collaborators/:id" do
    it "answers not found to a signed-out visitor for an unknown collaboration", parity: true do
      send_inertia(:patch, "/collaborators/unknowncollab", new_collaboration)

      expect(response).to have_http_status(:not_found)
    end

    it "answers not found for a collaboration that was ended", parity: true do
      collaboration.mark_deleted!
      log_in(seller)

      send_inertia(:patch, collaborator_path(collaboration.external_id), new_collaboration)

      expect(response).to have_http_status(:not_found)
    end

    it "sends a signed-out visitor to sign in", parity: true do
      send_inertia(:patch, collaborator_path(collaboration.external_id), new_collaboration)

      expect(response).to have_http_status(:see_other)
      expect(response.location).to start_with("#{PROTOCOL}://#{DOMAIN}/login")
    end

    it "sends a support team member away with the role in the flash", parity: true do
      as_team_member(TeamMembership::ROLE_SUPPORT)

      send_inertia(:patch, collaborator_path(collaboration.external_id), new_collaboration)

      expect(response).to redirect_to(dashboard_url)
    end

    it "sends the collaborator away, who may end the collaboration but not edit it", parity: true do
      log_in(collaborator_user)

      send_inertia(:patch, collaborator_path(collaboration.external_id), new_collaboration)

      expect(response).to redirect_to(dashboard_url)
      expect(flash[:alert]).to eq("You are not allowed to perform this action.")
    end

    it "hands an update of the seller's collaboration to Rails", parity: true do
      log_in(seller)

      send_inertia(:patch, collaborator_path(collaboration.external_id), { collaborator: { percent_commission: 25, apply_to_all_products: true } })

      expect(response).to be_redirect
    end
  end

  describe "DELETE /collaborators/:id" do
    it "answers not found for an unknown collaboration", parity: true do
      log_in(seller)

      send_inertia(:delete, "/collaborators/unknowncollab")

      expect(response).to have_http_status(:not_found)
    end

    it "sends a marketing team member away with the role in the flash", parity: true do
      as_team_member(TeamMembership::ROLE_MARKETING)

      send_inertia(:delete, collaborator_path(collaboration.external_id))

      expect(response).to redirect_to(dashboard_url)
    end

    it "sends a seller away from the collaboration of another seller", parity: true do
      log_in(create(:named_user, name: "Stranger"))

      send_inertia(:delete, collaborator_path(collaboration.external_id))

      expect(response).to redirect_to(dashboard_url)
    end

    it "hands a removal by the seller to Rails", parity: true do
      log_in(seller)

      send_inertia(:delete, collaborator_path(collaboration.external_id))

      expect(response).to redirect_to(collaborators_path)
      expect(collaboration.reload).to be_deleted
    end

    it "hands a removal by the collaborator to Rails", parity: true do
      log_in(collaborator_user)

      send_inertia(:delete, collaborator_path(collaboration.external_id))

      expect(response).to redirect_to(collaborators_path)
    end
  end
end
