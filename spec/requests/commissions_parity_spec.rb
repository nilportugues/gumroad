# frozen_string_literal: true

require "spec_helper"

# PATCH /commissions/:id and POST /commissions/:id/complete, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/rest-sweep-2.replay.test.ts, which sends the last request of each example. Node answers the 404, the Pundit
# refusal and every request that ends without a write or a charge; changing the attached files and charging the balance are
# `hands a ...`.
describe "Commissions", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, :eligible_for_service_products, name: "Commission Seller") }
  let(:product) { create(:commission_product, user: seller, price_cents: 0) }
  let(:deposit) do
    build(:commission_deposit_purchase, link: product, seller:, credit_card: nil, email: "buyer@example.com", purchase_state: "successful").tap { |purchase| purchase.save!(validate: false) }
  end
  let!(:commission) { create(:commission, deposit_purchase: deposit) }
  let(:headers) { { "CONTENT_TYPE" => "application/json", "Accept" => "application/json" } }

  before { host! DOMAIN }

  def update_commission(target = commission.external_id, file_signed_ids: [])
    patch commission_path(target), params: { file_signed_ids: }.to_json, headers: headers.merge("X-CSRF-Token" => csrf_token)
  end

  def complete_commission(target = commission.external_id)
    post complete_commission_path(target), headers: headers.merge("X-CSRF-Token" => csrf_token)
  end

  def attach_file
    commission.files.attach(io: StringIO.new("final artwork"), filename: "artwork.txt", content_type: "text/plain")
  end

  def log_in_as_team_member(role)
    member = create(:user, name: "#{role} member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  describe "update" do
    it "answers 404 for an unknown commission", parity: true do
      log_in(seller)

      update_commission("unknown")

      expect(response).to have_http_status(:not_found)
    end

    it "refuses a marketing team member", parity: true do
      log_in_as_team_member(TeamMembership::ROLE_MARKETING)

      update_commission

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body["success"]).to eq(false)
    end

    it "refuses the commission of another seller", parity: true do
      log_in(create(:user, name: "Other Seller"))

      update_commission

      expect(response).to have_http_status(:unauthorized)
    end

    it "refuses to change the files of a completed commission", parity: true do
      commission.update_columns(status: Commission::STATUS_COMPLETED)
      log_in(seller)

      update_commission

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["errors"]).to eq(["This commission has already been completed, so its files can no longer be changed."])
    end

    it "refuses to change the files once the balance was charged", parity: true do
      completion = build(:commission_deposit_purchase, link: product, seller:, credit_card: nil, email: "buyer@example.com", purchase_state: "successful", is_commission_deposit_purchase: false, is_commission_completion_purchase: true)
      completion.save!(validate: false)
      commission.update_columns(completion_purchase_id: completion.id)
      log_in(seller)

      update_commission

      expect(response).to have_http_status(:unprocessable_entity)
    end

    it "lets a support team member in, and hands the file change to Rails", parity: true do
      attach_file
      log_in_as_team_member(TeamMembership::ROLE_SUPPORT)

      update_commission(file_signed_ids: [commission.files.first.signed_id])

      expect(response).to have_http_status(:no_content)
    end

    it "hands a change of the attached files to Rails", parity: true do
      attach_file
      log_in(seller)

      update_commission(file_signed_ids: [])

      expect(response).to have_http_status(:no_content)
      expect(commission.reload.files.attached?).to eq(false)
    end
  end

  describe "complete" do
    it "answers 404 for an unknown commission", parity: true do
      log_in(seller)

      complete_commission("unknown")

      expect(response).to have_http_status(:not_found)
    end

    it "refuses a marketing team member", parity: true do
      attach_file
      log_in_as_team_member(TeamMembership::ROLE_MARKETING)

      complete_commission

      expect(response).to have_http_status(:unauthorized)
    end

    it "does nothing for a commission that is already completed", parity: true do
      commission.update_columns(status: Commission::STATUS_COMPLETED)
      log_in(seller)

      complete_commission

      expect(response).to have_http_status(:no_content)
      expect(commission.reload.status).to eq(Commission::STATUS_COMPLETED)
    end

    it "does nothing when the balance was already charged", parity: true do
      completion = build(:commission_deposit_purchase, link: product, seller:, credit_card: nil, email: "buyer@example.com", purchase_state: "in_progress", is_commission_deposit_purchase: false, is_commission_completion_purchase: true)
      completion.save!(validate: false)
      commission.update_columns(completion_purchase_id: completion.id)
      log_in(seller)

      complete_commission

      expect(response).to have_http_status(:no_content)
      expect(commission.reload.status).to eq(Commission::STATUS_IN_PROGRESS)
    end

    it "refuses a commission whose deposit was refunded", parity: true do
      attach_file
      deposit.update_columns(stripe_refunded: true)
      log_in(seller)

      complete_commission

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["errors"]).to eq(["This commission's deposit is no longer in a completable state, so it can no longer be completed."])
    end

    it "refuses a commission whose deposit was partially refunded", parity: true do
      attach_file
      deposit.update_columns(stripe_partially_refunded: true)
      log_in(seller)

      complete_commission

      expect(response).to have_http_status(:unprocessable_entity)
    end

    it "refuses a commission whose deposit was charged back", parity: true do
      attach_file
      deposit.update_columns(chargeback_date: 2.days.ago)
      log_in(seller)

      complete_commission

      expect(response).to have_http_status(:unprocessable_entity)
    end

    it "refuses a cancelled commission", parity: true do
      attach_file
      commission.update_columns(status: Commission::STATUS_CANCELLED)
      log_in(seller)

      complete_commission

      expect(response).to have_http_status(:unprocessable_entity)
    end

    it "refuses a commission whose deposit did not succeed", parity: true do
      attach_file
      deposit.update_columns(purchase_state: "failed")
      log_in(seller)

      complete_commission

      expect(response).to have_http_status(:unprocessable_entity)
    end

    it "asks for a file before completing", parity: true do
      log_in(seller)

      complete_commission

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["errors"]).to eq(["Attach at least one file before completing this commission."])
    end

    it "hands the charge of the balance to Rails", parity: true do
      attach_file
      log_in(seller)

      complete_commission

      expect(response).to have_http_status(:no_content)
      expect(commission.reload.status).to eq(Commission::STATUS_COMPLETED)
    end
  end
end
