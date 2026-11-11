# frozen_string_literal: true

require "spec_helper"

# Api::V2::TaxFormsController#download through the full Rack stack, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/api-v2-ws17c.replay.test.ts. Node answers the checks before the PDF is fetched; the fetch from Stripe or S3 is
# recorded as what Node hands back.
describe "API v2 tax form download", type: :request do
  include Parity::ApiV2Requests

  let(:seller) { create(:user, name: "Tax Seller", email: "tax-seller@example.com", created_at: Time.utc(2022, 3, 4)) }
  let(:token) { api_token(seller, scopes: "view_tax_data") }

  let(:compliance_factory) { :user_compliance_info }

  before { create(compliance_factory, user: seller) }

  def download(year, type, options = {})
    api_call(:get, "/tax_forms/#{year}/#{type}/download", token: options.fetch(:token) { token }, **options.slice(:api_host))
  end

  def not_found = { "success" => false, "message" => "Tax form not found." }

  it "refuses a request without a token", parity: true do
    download(2023, "us_1099_k", token: nil)

    expect(response).to have_http_status(:unauthorized)
  end

  it "refuses a token that lacks the view_tax_data scope", parity: true do
    download(2023, "us_1099_k", token: api_token(seller))

    expect(response).to have_http_status(:forbidden)
  end

  context "when the seller is not based in the US" do
    let(:compliance_factory) { :user_compliance_info_canada }

    it "refuses an account without the tax center", parity: true do
      download(2023, "us_1099_k")

      expect(response).to have_http_status(:forbidden)
      expect(response.parsed_body["message"]).to eq("Tax center is not enabled for this account.")
    end
  end

  it "does not find a year that is not a number", parity: true do
    download("last", "us_1099_k")

    expect(response).to have_http_status(:not_found)
    expect(response.parsed_body).to eq(not_found)
  end

  it "does not find the current year", parity: true do
    download(Time.current.year, "us_1099_k")

    expect(response).to have_http_status(:not_found)
  end

  it "does not find a year before the account existed", parity: true do
    download(2021, "us_1099_k")

    expect(response).to have_http_status(:not_found)
  end

  it "does not find a form type that does not exist", parity: true do
    create(:user_tax_form, user: seller, tax_year: 2023, tax_form_type: "us_1099_k")

    download(2023, "us_1099_nec")

    expect(response.parsed_body).to eq(not_found)
  end

  it "does not find a year without a form", parity: true do
    download(2023, "us_1099_misc")

    expect(response).to have_http_status(:not_found)
    expect(response.parsed_body).to eq(not_found)
  end

  it "does not find the form of another seller", parity: true do
    create(:user_tax_form, user: create(:user, email: "other-tax-seller@example.com", created_at: Time.utc(2022, 3, 4)), tax_year: 2023, tax_form_type: "us_1099_k")

    download(2023, "us_1099_k")

    expect(response.parsed_body).to eq(not_found)
  end

  it "does not find a form filed under a Stripe account the seller does not own", parity: true do
    form = create(:user_tax_form, user: seller, tax_year: 2023, tax_form_type: "us_1099_k")
    form.update!(stripe_account_id: "acct_not_owned")

    download(2023, "us_1099_k")

    expect(response.parsed_body).to eq(not_found)
  end

  it "does not find a form filed under a Stripe account through the /api prefix on the Gumroad domain", parity: true do
    form = create(:user_tax_form, user: seller, tax_year: 2024, tax_form_type: "us_1099_misc")
    form.update!(stripe_account_id: "acct_not_owned")

    download(2024, "us_1099_misc", api_host: false)

    expect(response).to have_http_status(:not_found)
  end

  it "hands a form of a seller whose Stripe account was deleted to Rails", parity: true do
    create(:merchant_account, user: seller, charge_processor_merchant_id: "acct_gone", deleted_at: Time.current)
    create(:user_tax_form, user: seller, tax_year: 2023, tax_form_type: "us_1099_misc")
    allow_any_instance_of(StripeTaxFormsApi).to receive(:download_tax_form).and_return(nil)

    download(2023, "us_1099_misc")

    expect(response).to have_http_status(:not_found)
  end

  it "hands a form of the Stripe account of the seller to Rails", parity: true do
    create(:merchant_account, user: seller, charge_processor_merchant_id: "acct_owned")
    form = create(:user_tax_form, user: seller, tax_year: 2023, tax_form_type: "us_1099_misc")
    form.update!(stripe_account_id: "acct_owned")
    allow_any_instance_of(StripeTaxFormsApi).to receive(:download_tax_form).and_return(nil)

    download(2023, "us_1099_misc")

    expect(response).to have_http_status(:not_found)
  end

  it "hands a form of a seller without a Stripe account to Rails", parity: true do
    create(:user_tax_form, user: seller, tax_year: 2023, tax_form_type: "us_1099_misc")
    allow_any_instance_of(StripeTaxFormsApi).to receive(:download_tax_form).and_return(nil)

    download(2023, "us_1099_misc")

    expect(response).to have_http_status(:not_found)
  end
end
