# frozen_string_literal: true

require "spec_helper"

# GET /purchases/:id/invoice/new (Purchases::InvoicesController#new), recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/purchase-pages-guards.replay.test.ts. Node answers what runs ahead of the action (404, the email confirmation);
# the form itself is served for one plain USD purchase seen by a signed-out visitor; an example named "hands a ..." is one it leaves to
# Rails whole, because Rails builds the form from InvoicePresenter.
describe "Purchase invoice form", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Invoice Form Seller") }
  let(:product) { create(:product, user: seller, name: "Invoiced product", unique_permalink: "invoiced", created_at: Time.utc(2025, 1, 1)) }
  let(:email) { "buyer@example.com" }
  # A charged purchase would call Stripe.
  let(:purchase) do
    build(:purchase, link: product, seller:, email:, purchase_state: "successful", price_cents: 500, total_transaction_cents: 500,
                     displayed_price_cents: 500, displayed_price_currency_type: :usd, shipping_cents: 0, tax_cents: 0, gumroad_tax_cents: 0,
                     full_name: "Invoice Buyer", street_address: "1 Main St", city: "Austin", state: "TX", zip_code: "78701",
                     country: "United States", ip_country: "United States", card_type: "visa", card_visual: "**** **** **** 4242",
                     created_at: Time.utc(2025, 2, 3, 4, 5, 6)).tap { _1.save!(validate: false) }
  end
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

  it "renders the invoice form of a purchase whose email was confirmed", parity: true do
    get "/purchases/#{purchase.external_id}/invoice/new", params: { email: }

    expect(response).to be_successful
    expect(response.headers["X-Robots-Tag"]).to include("noindex")
  end

  it "renders the invoice form for an Inertia visit", parity: true do
    get "/purchases/#{purchase.external_id}/invoice/new", params: { email: }, headers: inertia_headers

    expect(response).to be_successful
  end

  it "renders the invoice form of a purchase of several items without a card", parity: true do
    purchase.update_columns(quantity: 2, price_cents: 1000, displayed_price_cents: 1000, total_transaction_cents: 1000, card_type: nil, card_visual: nil)

    get "/purchases/#{purchase.external_id}/invoice/new", params: { email: }

    expect(response).to be_successful
  end

  it "hands the form of a purchase with tax to Rails", parity: true do
    purchase.update_columns(tax_cents: 50)

    get "/purchases/#{purchase.external_id}/invoice/new", params: { email: }

    expect(response).to be_successful
  end

  it "hands the form of a refunded purchase to Rails", parity: true do
    purchase.update_columns(stripe_refunded: true)

    get "/purchases/#{purchase.external_id}/invoice/new", params: { email: }

    expect(response).to be_successful
  end

  it "hands the form of a buyer in the EU to Rails", parity: true do
    purchase.update_columns(country: "Germany")

    get "/purchases/#{purchase.external_id}/invoice/new", params: { email: }

    expect(response).to be_successful
  end

  it "hands the form to a signed-in visitor to Rails", parity: true do
    log_in(create(:user))

    get "/purchases/#{purchase.external_id}/invoice/new", params: { email: }

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
