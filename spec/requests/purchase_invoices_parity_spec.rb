# frozen_string_literal: true

require "spec_helper"

# POST /purchases/:id/invoice/confirm and POST /purchases/:id/invoice (Purchases::InvoicesController#confirm_email and #create), sent the
# way the Inertia form does and recorded for the Next.js port (PARITY_RECORD=1). nextjs/parity/__tests__/purchase-invoices.replay.test.ts
# replays the last request of each example. Node answers the email confirmation and the two refusals of #create; an example named
# "hands a ..." is one Node leaves to Rails whole, because Rails would render and upload the PDF.
describe "Purchase invoices", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Invoice Seller") }
  let(:product) { create(:product, user: seller, name: "Invoiced product", unique_permalink: "invoiced", created_at: Time.utc(2025, 1, 1)) }
  let(:email) { "buyer@example.com" }
  # A charged purchase would call Stripe.
  let(:purchase) { build(:purchase, link: product, seller:, email:, purchase_state: "successful").tap { _1.save!(validate: false) } }
  let(:address) { { full_name: "Jane Doe", street_address: "1 Main St", city: "Springfield", state: "IL", zip_code: "62701", country_code: "US" } }
  let(:inertia_headers) do
    { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml", "Content-Type" => "application/json",
      "Referer" => "http://#{DOMAIN}/purchases/#{purchase.external_id}/invoice/confirm" }
  end

  before { host! DOMAIN }

  def confirm(id: purchase.external_id, **body)
    post "/purchases/#{id}/invoice/confirm", params: body.to_json, headers: inertia_headers.merge("X-CSRF-Token" => csrf_token)
  end

  def generate(id: purchase.external_id, **body)
    post "/purchases/#{id}/invoice", params: body.to_json, headers: inertia_headers.merge("X-CSRF-Token" => csrf_token)
  end

  def new_invoice_location(address_email = email) = "http://#{DOMAIN}/purchases/#{purchase.external_id}/invoice/new?email=#{CGI.escape(address_email)}"

  describe "confirming the email" do
    it "sends the buyer to the invoice form with the confirmed email", parity: true do
      confirm(email:)

      expect(response).to have_http_status(:see_other)
      expect(response.location).to eq(new_invoice_location)
    end

    it "encodes the email in the redirect", parity: true do
      purchase.update_column(:email, "buyer+tag@example.com")

      confirm(email: "buyer+tag@example.com")

      expect(response).to have_http_status(:see_other)
      expect(response.location).to eq(new_invoice_location("buyer+tag@example.com"))
    end

    it "sends a wrong email back to the confirm page with an alert", parity: true do
      confirm(email: "other@example.com")

      expect(response).to have_http_status(:found)
      expect(response.location).to eq("http://#{DOMAIN}/purchases/#{purchase.external_id}/invoice/confirm")
      expect(flash[:alert]).to eq("Incorrect email address. Please try again.")
    end

    it "compares the email with its case", parity: true do
      confirm(email: "Buyer@example.com")

      expect(response).to have_http_status(:found)
      expect(flash[:alert]).to eq("Incorrect email address. Please try again.")
    end

    it "asks for the email when it is blank", parity: true do
      confirm(email: "  ")

      expect(response).to have_http_status(:found)
      expect(flash[:warning]).to eq("Please enter the purchase's email address to generate the invoice.")
    end

    it "asks for the email when none is sent", parity: true do
      confirm

      expect(response).to have_http_status(:found)
      expect(flash[:warning]).to eq("Please enter the purchase's email address to generate the invoice.")
    end

    it "answers 404 for a purchase that does not exist", parity: true do
      confirm(id: "nosuchpurchase", email:)

      expect(response).to have_http_status(:not_found)
    end

    it "hands an email that is a list to Rails", parity: true do
      confirm(email: [email])

      expect(response).to have_http_status(:found)
      expect(flash[:alert]).to eq("Incorrect email address. Please try again.")
    end

    it "hands an email that is a number to Rails", parity: true do
      confirm(email: 42)

      expect(response).to have_http_status(:found)
      expect(flash[:alert]).to eq("Incorrect email address. Please try again.")
    end
  end

  describe "generating the invoice" do
    it "sends a wrong email back to the confirm page with an alert", parity: true do
      generate(email: "other@example.com", address_fields: address)

      expect(response).to have_http_status(:found)
      expect(response.location).to eq("http://#{DOMAIN}/purchases/#{purchase.external_id}/invoice/confirm")
      expect(flash[:alert]).to eq("Incorrect email address. Please try again.")
    end

    it "asks for the email when none is sent", parity: true do
      generate(address_fields: address)

      expect(response).to have_http_status(:found)
      expect(flash[:warning]).to eq("Please enter the purchase's email address to generate the invoice.")
    end

    it "answers 404 for a purchase that does not exist", parity: true do
      generate(id: "nosuchpurchase", email:, address_fields: address)

      expect(response).to have_http_status(:not_found)
    end

    it "refuses a VAT id on a purchase PayPal has not completed", parity: true do
      purchase.update_column(:purchase_state, "in_progress")

      generate(email:, vat_id: "GB123456789", address_fields: address)

      expect(response).to have_http_status(:found)
      expect(response.location).to eq(new_invoice_location)
      expect(flash[:alert]).to eq("Your purchase has not been completed by PayPal yet. Please try again soon.")
    end

    it "checks the VAT id before the address", parity: true do
      purchase.update_column(:purchase_state, "in_progress")

      generate(email:, vat_id: "GB123456789")

      expect(response).to have_http_status(:found)
      expect(flash[:alert]).to eq("Your purchase has not been completed by PayPal yet. Please try again soon.")
    end

    it "asks for the address when none is sent", parity: true do
      generate(email:)

      expect(response).to have_http_status(:found)
      expect(response.location).to eq(new_invoice_location)
      expect(flash[:alert]).to eq("Address information is required to generate an invoice.")
    end

    it "asks for the address when it is an empty hash", parity: true do
      generate(email:, address_fields: {})

      expect(response).to have_http_status(:found)
      expect(flash[:alert]).to eq("Address information is required to generate an invoice.")
    end

    it "asks for the address when it holds only fields the form does not have", parity: true do
      generate(email:, address_fields: { company: "Acme" })

      expect(response).to have_http_status(:found)
      expect(flash[:alert]).to eq("Address information is required to generate an invoice.")
    end

    it "asks for the address when it is text", parity: true do
      generate(email:, address_fields: "1 Main St")

      expect(response).to have_http_status(:found)
      expect(flash[:alert]).to eq("Address information is required to generate an invoice.")
    end

    it "hands a complete address to Rails", parity: true do
      allow_any_instance_of(Purchase).to receive(:upload_invoice_pdf).and_raise("error")

      generate(email:, address_fields: address)

      expect(response).to have_http_status(:found)
      expect(flash[:alert]).to eq("Sorry, something went wrong.")
    end
  end
end
