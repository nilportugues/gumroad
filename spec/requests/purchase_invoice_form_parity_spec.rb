# frozen_string_literal: true

require "spec_helper"

# GET /purchases/:id/invoice/new (Purchases::InvoicesController#new), recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/purchase-pages-guards.replay.test.ts. Node answers what runs ahead of the action (404, the email confirmation);
# an example named "hands a ..." is one it leaves to Rails whole, because Rails builds the form from InvoicePresenter.
describe "Purchase invoice form", type: :request do
  let(:seller) { create(:user, name: "Invoice Form Seller") }
  let(:product) { create(:product, user: seller, name: "Invoiced product", unique_permalink: "invoiced", created_at: Time.utc(2025, 1, 1)) }
  let(:email) { "buyer@example.com" }
  # A charged purchase would call Stripe.
  let(:purchase) { build(:purchase, link: product, seller:, email:, purchase_state: "successful").tap { _1.save!(validate: false) } }
  let(:inertia_headers) { { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml" } }

  before { host! DOMAIN }

  def confirm_location = "http://#{DOMAIN}/purchases/#{purchase.external_id}/invoice/confirm"

  it "answers 404 for a purchase that does not exist", parity: true do
    get "/purchases/nosuchpurchase/invoice/new", params: { email: }

    expect(response).to have_http_status(:not_found)
  end

  it "sends a wrong email back to the confirm page with an alert and the noindex header", parity: true do
    get "/purchases/#{purchase.external_id}/invoice/new", params: { email: "other@example.com" }

    expect(response).to redirect_to(confirm_location)
    expect(response.headers["X-Robots-Tag"]).to include("noindex")
    expect(flash[:alert]).to eq("Incorrect email address. Please try again.")
  end

  it "compares the email with its case", parity: true do
    get "/purchases/#{purchase.external_id}/invoice/new", params: { email: "Buyer@example.com" }

    expect(response).to redirect_to(confirm_location)
    expect(flash[:alert]).to eq("Incorrect email address. Please try again.")
  end

  it "asks for the email when none is sent", parity: true do
    get "/purchases/#{purchase.external_id}/invoice/new"

    expect(response).to redirect_to(confirm_location)
    expect(flash[:warning]).to eq("Please enter the purchase's email address to generate the invoice.")
  end

  it "asks for the email when it is blank", parity: true do
    get "/purchases/#{purchase.external_id}/invoice/new", params: { email: "  " }

    expect(response).to redirect_to(confirm_location)
    expect(flash[:warning]).to eq("Please enter the purchase's email address to generate the invoice.")
  end

  it "sends a wrong email back to the confirm page for an Inertia visit", parity: true do
    get "/purchases/#{purchase.external_id}/invoice/new", params: { email: "other@example.com" }, headers: inertia_headers

    expect(response).to redirect_to(confirm_location)
  end

  it "hands the form of a purchase whose email was confirmed to Rails", parity: true do
    get "/purchases/#{purchase.external_id}/invoice/new", params: { email: }

    expect(response).to be_successful
  end

  it "hands the form of an Inertia visit to Rails", parity: true do
    get "/purchases/#{purchase.external_id}/invoice/new", params: { email: }, headers: inertia_headers

    expect(response).to be_successful
  end

  it "hands an email that is a list to Rails", parity: true do
    get "/purchases/#{purchase.external_id}/invoice/new?email[]=#{email}"

    expect(response).to redirect_to(confirm_location)
  end

  it "hands a purchase without an email to Rails", parity: true do
    purchase.update_column(:email, "")

    get "/purchases/#{purchase.external_id}/invoice/new", params: { email: "" }

    expect(response).to have_http_status(:ok)
  end

  it "hands a request that does not ask for HTML to Rails", parity: true do
    get "/purchases/#{purchase.external_id}/invoice/new", params: { email: }, headers: { "Accept" => "application/json" }

    expect(response).to have_http_status(:not_found)
  end
end
