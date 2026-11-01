# frozen_string_literal: true

require "spec_helper"

# Signed-in visits to the dispute evidence pages, recorded for the Next.js port (PARITY_RECORD=1) and
# replayed by nextjs/parity/__tests__/ws75-pages.replay.test.ts, which sends the last request of each
# example. Disputed purchases are free ones with their amount set on the row: a charged purchase would
# call Stripe.
describe "Dispute evidence pages when signed in", type: :request do
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

  def attach_customer_communication(record)
    record.customer_communication_file.attach(
      io: StringIO.new("%PDF-1.4 communication"), filename: "emails.pdf", content_type: "application/pdf"
    )
  end

  it "redirects a signed-out visitor to the login page", parity: true do
    get purchase_dispute_evidence_path(purchase.external_id)

    expect(response).to have_http_status(:found)
    expect(response.location).to include("/login")
  end

  describe "GET /purchases/:purchase_id/dispute_evidence" do
    it "shows the form for the seller who owns the sale", parity: true do
      evidence
      log_in(seller)

      get purchase_dispute_evidence_path(purchase.external_id)

      expect(response).to be_successful
      expect(response.headers["X-Robots-Tag"]).to include("noindex")
      props = inertia_props_of(response)
      expect(props["dispute_evidence"]).to include("dispute_reason" => "fraudulent", "customer_email" => "customer@example.com")
      expect(props["disputable"]).to include("purchase_for_dispute_evidence_id" => purchase.external_id, "formatted_display_price" => "$15", "is_subscription" => false)
      expect(props["products"]).to eq([{ "name" => "Disputed course", "url" => product.long_url }])
    end

    it "keeps the emailed token in the route id and shows what the seller already saved", parity: true do
      evidence.update!(reason_for_winning: "Customer used the product", cancellation_rebuttal: "No request", refund_refusal_explanation: "Outside the window")
      attach_customer_communication(evidence)
      log_in(seller)

      get purchase_dispute_evidence_path(token)

      expect(response).to be_successful
      props = inertia_props_of(response)
      expect(props["disputable"]["purchase_for_dispute_evidence_id"]).to eq(token)
      expect(props["dispute_evidence"]["saved"]).to eq("reason_for_winning" => "Customer used the product", "cancellation_rebuttal" => "No request", "refund_refusal_explanation" => "Outside the window")
      expect(props["dispute_evidence"]["blobs"]["customer_communication_file"]).to include("filename" => "emails.pdf", "title" => "Customer communication")
    end

    it "shows a subscription purchase with its cancellation policy slot", parity: true do
      purchase.update_columns(subscription_id: create(:subscription, link: product).id)
      evidence
      log_in(seller)

      get purchase_dispute_evidence_path(purchase.external_id)

      expect(response).to be_successful
      props = inertia_props_of(response)
      expect(props["disputable"]["is_subscription"]).to be(true)
      expect(props["dispute_evidence"]["blobs"]["policy_image"]).to be_nil
    end

    it "shows a dispute on a charge through the purchase with a refund policy", parity: true do
      charge = create(:charge, seller:, amount_cents: 4200)
      first = create(:free_purchase, link: product, email: "customer@example.com").tap { _1.update_columns(price_cents: 3000, total_transaction_cents: 3000) }
      second = create(:free_purchase, link: create(:product, user: seller, name: "Second course"), email: "customer@example.com").tap { _1.update_columns(price_cents: 1200, total_transaction_cents: 1200) }
      second.update_columns(subscription_id: create(:subscription, link: second.link).id)
      create(:purchase_refund_policy, purchase: second)
      charge.purchases << first << second
      charge_dispute = create(:dispute_on_charge, charge:, state: :formalized, formalized_at: Time.current, reason: Dispute::REASON_FRAUDULENT)
      create(:dispute_evidence, dispute: charge_dispute, seller_contacted_at: Time.current, customer_email: "customer@example.com", purchased_at: Time.utc(2025, 6, 15, 12, 30, 15))
      log_in(seller)

      get purchase_dispute_evidence_path(first.external_id)

      expect(response).to be_successful
      props = inertia_props_of(response)
      expect(props["disputable"]).to include("formatted_display_price" => "$42", "is_subscription" => true)
      expect(props["products"].map { _1["name"] }).to eq(["Disputed course", "Second course"])
    end

    it "answers an Inertia visit with the page as JSON", parity: true do
      evidence
      log_in(seller)

      inertia_visit purchase_dispute_evidence_path(purchase.external_id)

      expect(response).to be_successful
      expect(response.parsed_body["component"]).to eq("Purchases/DisputeEvidence/Show")
    end

    it "explains to a signed-in user of another account that holds the emailed token", parity: true do
      evidence
      log_in(create(:user))

      get purchase_dispute_evidence_path(token)

      expect(response).to redirect_to(dashboard_url)
      expect(flash[:alert]).to start_with("This page belongs to the seller account that made the sale.")
    end

    it "answers a signed-in user of another account that holds only the external id with a 404", parity: true do
      evidence
      log_in(create(:user))

      get purchase_dispute_evidence_path(purchase.external_id)

      expect(response).to have_http_status(:not_found)
    end

    it "answers an unknown purchase with a 404", parity: true do
      log_in(seller)

      get purchase_dispute_evidence_path("unknown-purchase")

      expect(response).to have_http_status(:not_found)
    end

    it "sends the seller to the dashboard when the seller was never contacted", parity: true do
      evidence.update_columns(seller_contacted_at: nil)
      log_in(seller)

      get purchase_dispute_evidence_path(purchase.external_id)

      expect(response).to redirect_to(dashboard_url)
      expect(flash[:alert]).to eq("You are not allowed to perform this action.")
    end

    it "sends the seller to the dashboard once the dispute is resolved", parity: true do
      evidence.update_columns(resolved_at: Time.current)
      log_in(seller)

      get purchase_dispute_evidence_path(purchase.external_id)

      expect(response).to redirect_to(dashboard_url)
      expect(flash[:alert]).to eq("Additional information can no longer be submitted for this dispute.")
    end

    it "sends the seller to the dashboard after the deadline", parity: true do
      evidence.update_columns(seller_contacted_at: 10.days.ago)
      log_in(seller)

      get purchase_dispute_evidence_path(purchase.external_id)

      expect(response).to redirect_to(dashboard_url)
      expect(flash[:alert]).to eq("The deadline for submitting additional information for this dispute has passed.")
    end
  end

  describe "GET /purchases/:purchase_id/dispute_evidence/success" do
    it "tells the seller when the response is forwarded", parity: true do
      evidence
      log_in(seller)

      get success_purchase_dispute_evidence_path(token)

      expect(response).to be_successful
      expect(inertia_props_of(response)).to include("purchase_for_dispute_evidence_id" => token)
      expect(inertia_props_of(response)["seller_response_due_at_formatted"]).to end_with("UTC")
    end

    it "still shows after the dispute is resolved", parity: true do
      evidence.update_columns(resolved_at: Time.current, seller_contacted_at: 10.days.ago)
      log_in(seller)

      get success_purchase_dispute_evidence_path(purchase.external_id)

      expect(response).to be_successful
    end

    it "shows no deadline when the seller was never contacted", parity: true do
      evidence.update_columns(seller_contacted_at: nil)
      log_in(seller)

      get success_purchase_dispute_evidence_path(purchase.external_id)

      expect(inertia_props_of(response)["seller_response_due_at_formatted"]).to be_nil
    end
  end
end
