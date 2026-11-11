# frozen_string_literal: true

require "spec_helper"

# Submitting the dispute evidence form the way the Inertia page does (PUT with a JSON body, the CSRF token in a header), recorded
# for the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/dispute-evidence-update.replay.test.ts, which sends
# the last request of each example. Node saves a statement without files; an upload goes to Rails. Disputed purchases are free
# ones with their amount set on the row: a charged purchase would call Stripe.
describe "Dispute evidence update when signed in", type: :request do
  include Parity::SignedInDashboard

  let(:seller) { create(:user, name: "Disputed Seller") }
  let(:product) { create(:product, user: seller, name: "Disputed course") }
  let(:purchase) do
    create(:free_purchase, link: product, email: "customer@example.com").tap do |record|
      record.update_columns(price_cents: 1500, total_transaction_cents: 1500)
    end
  end
  let(:dispute) { create(:dispute_formalized, purchase:, reason: Dispute::REASON_FRAUDULENT) }
  let(:evidence) { create(:dispute_evidence, dispute:, seller_contacted_at: Time.current, purchased_at: Time.utc(2025, 6, 15, 12, 30, 15)) }
  let(:token) { purchase.secure_external_id(scope: Purchases::DisputeEvidenceController::SECURE_ID_SCOPE, expires_at: evidence.evidence_link_expires_at) }
  let(:inertia_headers) do
    { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml", "Content-Type" => "application/json" }
  end
  let(:statement) do
    { reason_for_winning: "Customer used the product", cancellation_rebuttal: "No request", refund_refusal_explanation: "Outside the window", customer_communication_file_signed_blob_ids: [] }
  end

  def submit(id, evidence_params, method: :put)
    token = csrf_token
    public_send(method, purchase_dispute_evidence_path(id), params: { dispute_evidence: evidence_params }.to_json,
                                                            headers: inertia_headers.merge("X-CSRF-Token" => token, "Referer" => "http://#{DOMAIN}#{purchase_dispute_evidence_path(id)}"))
  end

  describe "a statement without files" do
    it "saves the statement and sends the seller to the success page", parity: true do
      evidence
      log_in(seller)

      submit(purchase.external_id, statement)

      expect(response).to redirect_to(success_purchase_dispute_evidence_path(purchase.external_id))
      expect(response).to have_http_status(:see_other)
      expect(evidence.reload).to have_attributes(reason_for_winning: "Customer used the product", cancellation_rebuttal: "No request", refund_refusal_explanation: "Outside the window")
      expect(evidence.seller_submitted_at).to be_present
    end

    it "keeps the emailed token in the success page address", parity: true do
      evidence
      log_in(seller)

      submit(token, statement, method: :patch)

      expect(response).to redirect_to(success_purchase_dispute_evidence_path(token))
      expect(evidence.reload.reason_for_winning).to eq("Customer used the product")
    end

    it "strips and squeezes the text and clears a field the seller emptied", parity: true do
      evidence.update!(cancellation_rebuttal: "Written yesterday")
      log_in(seller)

      submit(purchase.external_id, { reason_for_winning: "  Used   the product  ", cancellation_rebuttal: "", refund_refusal_explanation: "Outside the window" })

      expect(response).to have_http_status(:see_other)
      expect(evidence.reload).to have_attributes(reason_for_winning: "Used the product", cancellation_rebuttal: nil)
    end

    it "leaves a field the form did not send as it was", parity: true do
      evidence.update!(reason_for_winning: "Written yesterday")
      log_in(seller)

      submit(purchase.external_id, { refund_refusal_explanation: "Outside the window" })

      expect(response).to have_http_status(:see_other)
      expect(evidence.reload).to have_attributes(reason_for_winning: "Written yesterday", refund_refusal_explanation: "Outside the window")
    end

    it "saves the statement again after an earlier submission", parity: true do
      evidence.update!(reason_for_winning: "Written yesterday", seller_submitted_at: 1.day.ago)
      log_in(seller)

      submit(purchase.external_id, statement)

      expect(response).to have_http_status(:see_other)
      expect(evidence.reload.reason_for_winning).to eq("Customer used the product")
    end

    it "saves the statement of a dispute on a charge", parity: true do
      charge = create(:charge, seller:, amount_cents: 4200)
      first = create(:free_purchase, link: product, email: "customer@example.com").tap { _1.update_columns(price_cents: 4200, total_transaction_cents: 4200) }
      charge.purchases << first
      charge_dispute = create(:dispute_on_charge, charge:, state: :formalized, formalized_at: Time.current, reason: Dispute::REASON_FRAUDULENT)
      charge_evidence = create(:dispute_evidence, dispute: charge_dispute, seller_contacted_at: Time.current, customer_email: "customer@example.com", purchased_at: Time.utc(2025, 6, 15, 12, 30, 15))
      log_in(seller)

      submit(first.external_id, statement)

      expect(response).to have_http_status(:see_other)
      expect(charge_evidence.reload.reason_for_winning).to eq("Customer used the product")
    end

    it "saves the statement of a seller that has uploaded evidence earlier", parity: true do
      evidence.receipt_image.attach(io: StringIO.new("%PDF-1.4 receipt"), filename: "receipt.pdf", content_type: "application/pdf")
      evidence.customer_communication_file.attach(io: StringIO.new("%PDF-1.4 communication"), filename: "emails.pdf", content_type: "application/pdf")
      log_in(seller)

      submit(purchase.external_id, statement)

      expect(response).to have_http_status(:see_other)
      expect(evidence.reload.reason_for_winning).to eq("Customer used the product")
    end

    it "redirects back with the error when a statement is too long", parity: true do
      evidence
      log_in(seller)

      submit(purchase.external_id, statement.merge(reason_for_winning: "a" * 3_001, cancellation_rebuttal: "b" * 3_001))

      expect(response).to redirect_to(purchase_dispute_evidence_path(purchase.external_id))
      expect(flash[:alert]).to eq("Cancellation rebuttal is too long (maximum is 3000 characters) and Reason for winning is too long (maximum is 3000 characters)")
      expect(evidence.reload.reason_for_winning).to be_nil
    end
  end

  describe "the guards" do
    it "explains to a signed-in user of another account that holds the emailed token", parity: true do
      evidence
      log_in(create(:user))

      submit(token, statement)

      expect(response).to redirect_to(dashboard_url)
      expect(flash[:alert]).to start_with("This page belongs to the seller account that made the sale.")
      expect(evidence.reload.seller_submitted_at).to be_nil
    end

    it "answers another account that holds only the external id with a 404", parity: true do
      evidence
      log_in(create(:user))

      submit(purchase.external_id, statement)

      expect(response).to have_http_status(:not_found)
    end

    it "answers an unknown purchase with a 404", parity: true do
      log_in(seller)

      submit("unknown-purchase", statement)

      expect(response).to have_http_status(:not_found)
    end

    it "sends the seller to the dashboard when the seller was never contacted", parity: true do
      evidence.update_columns(seller_contacted_at: nil)
      log_in(seller)

      submit(purchase.external_id, statement)

      expect(response).to redirect_to(dashboard_url)
      expect(flash[:alert]).to eq("You are not allowed to perform this action.")
    end

    it "sends the seller to the dashboard once the dispute is resolved", parity: true do
      evidence.update_columns(resolved_at: Time.current)
      log_in(seller)

      submit(purchase.external_id, statement)

      expect(response).to redirect_to(dashboard_url)
      expect(flash[:alert]).to eq("Additional information can no longer be submitted for this dispute.")
      expect(evidence.reload.seller_submitted_at).to be_nil
    end

    it "sends the seller to the dashboard after the deadline", parity: true do
      evidence.update_columns(seller_contacted_at: 10.days.ago)
      log_in(seller)

      submit(purchase.external_id, statement)

      expect(response).to redirect_to(dashboard_url)
      expect(flash[:alert]).to eq("The deadline for submitting additional information for this dispute has passed.")
    end

    it "lets a suspended seller submit the statement", parity: true do
      evidence
      log_in(seller)
      seller.update_columns(user_risk_state: "suspended_for_fraud")

      submit(purchase.external_id, statement)

      expect(response).to have_http_status(:see_other)
      expect(evidence.reload.reason_for_winning).to eq("Customer used the product")
    end
  end

  describe "what Rails takes whole" do
    it "hands a customer communication upload to Rails", parity: true do
      evidence
      log_in(seller)
      blob = ActiveStorage::Blob.create_and_upload!(io: StringIO.new("%PDF-1.4 communication"), filename: "emails.pdf", content_type: "application/pdf")

      submit(purchase.external_id, statement.merge(customer_communication_file_signed_blob_ids: [blob.signed_id]))

      expect(response).to have_http_status(:see_other)
      expect(evidence.reload.customer_communication_file).to be_attached
    end

    it "hands a customer communication upload sent under the singular parameter to Rails", parity: true do
      evidence
      log_in(seller)
      blob = ActiveStorage::Blob.create_and_upload!(io: StringIO.new("%PDF-1.4 communication"), filename: "emails.pdf", content_type: "application/pdf")

      submit(purchase.external_id, statement.except(:customer_communication_file_signed_blob_ids).merge(customer_communication_file_signed_blob_id: blob.signed_id))

      expect(response).to have_http_status(:see_other)
    end

    it "hands a request without a dispute_evidence parameter to Rails", parity: true do
      evidence
      log_in(seller)
      token = csrf_token

      put purchase_dispute_evidence_path(purchase.external_id), params: {}.to_json, headers: inertia_headers.merge("X-CSRF-Token" => token)

      expect(response).to have_http_status(:bad_request)
    end

    it "hands a statement that is not a string to Rails", parity: true do
      evidence
      log_in(seller)

      submit(purchase.external_id, statement.merge(reason_for_winning: 42))

      expect(response).to have_http_status(:see_other)
    end
  end
end
