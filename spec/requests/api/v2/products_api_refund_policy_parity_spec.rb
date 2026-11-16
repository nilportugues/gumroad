# frozen_string_literal: true

require "spec_helper"

# PUT and PATCH /v2/refund_policy, recorded for the Next.js port (nextjs/parity/__tests__/api-v2-products.replay.test.ts).
# The fine print classifier is stubbed off by spec/support/refund_policy_fine_print_moderation.rb; the port hands back whatever
# would reach it, which the last examples pin.
describe "API v2 refund policy update", type: :request do
  include Parity::ApiV2Requests

  let(:seller) { create(:user, refund_policy_enabled: true) }
  let(:token) { api_token(seller, scopes: "edit_products") }

  before { seller.refund_policy.update!(max_refund_period_in_days: 30) }

  it "changes the refund period", parity: true do
    api_call(:put, "/refund_policy", token:, params: { refund_period: "14" })

    expect(response.parsed_body["refund_policy"]).to include("refund_period" => "14", "title" => "14-day money back guarantee", "in_effect" => true)
    expect(seller.refund_policy.reload.max_refund_period_in_days).to eq(14)
  end

  it "answers a PATCH on the Gumroad domain with a JSON body", parity: true do
    api_call(:patch, "/refund_policy", token:, params: { refund_period: "183" }, as: :json, api_host: false)

    expect(response.parsed_body["refund_policy"]).to include("refund_period" => "183", "title" => "6-month money back guarantee")
  end

  it "switches refunds off and stores the fine print", parity: true do
    api_call(:put, "/refund_policy", token:, params: { refund_period: "none", fine_print: "  All sales are final.  " })

    expect(response.parsed_body["refund_policy"]).to include("refund_period" => "none", "title" => "No refunds allowed", "fine_print" => "All sales are final.")
  end

  it "strips HTML from the fine print", parity: true do
    api_call(:put, "/refund_policy", token:, params: { refund_period: "none", fine_print: "<p>Contact <strong>support</strong> first</p>" })

    expect(response.parsed_body["refund_policy"]["fine_print"]).to eq("Contact support first")
  end

  it "clears the fine print with an empty string", parity: true do
    seller.refund_policy.update!(max_refund_period_in_days: 0, fine_print: "Old text")

    api_call(:put, "/refund_policy", token:, params: { refund_period: "none", fine_print: "" })

    expect(response.parsed_body["refund_policy"]["fine_print"]).to be_nil
  end

  it "keeps the fine print when the parameter is absent", parity: true do
    seller.refund_policy.update!(max_refund_period_in_days: 0, fine_print: "Kept text")

    api_call(:put, "/refund_policy", token:, params: { refund_period: "none" })

    expect(response.parsed_body["refund_policy"]["fine_print"]).to eq("Kept text")
  end

  it "writes nothing when the values are unchanged", parity: true do
    api_call(:put, "/refund_policy", token:, params: { refund_period: "30" })

    expect(response.parsed_body["refund_policy"]["refund_period"]).to eq("30")
  end

  it "refuses an unknown refund period", parity: true do
    api_call(:put, "/refund_policy", token:, params: { refund_period: "365" })

    expect(response.parsed_body).to eq("success" => false, "message" => "Refund period must be one of: none, 7, 14, 30, 183.")
  end

  it "refuses 0 as a refund period", parity: true do
    api_call(:put, "/refund_policy", token:, params: { refund_period: "0" })

    expect(response.parsed_body["message"]).to eq("Refund period must be one of: none, 7, 14, 30, 183.")
  end

  it "requires a refund period", parity: true do
    api_call(:put, "/refund_policy", token:, params: { refund_period: "  " })

    expect(response.parsed_body).to eq("success" => false, "message" => "Refund period is required.")
  end

  it "refuses fine print over 3000 characters", parity: true do
    api_call(:put, "/refund_policy", token:, params: { refund_period: "none", fine_print: "a" * 3001 })

    expect(response.parsed_body).to eq("success" => false, "message" => "Fine print is too long (maximum is 3000 characters)")
    expect(seller.refund_policy.reload.fine_print).to be_nil
  end

  it "refuses to update a policy that is not in effect", parity: true do
    seller.update!(refund_policy_enabled: false)

    api_call(:put, "/refund_policy", token:, params: { refund_period: "7" })

    expect(response.parsed_body).to eq("success" => false, "message" => "The account-level refund policy is not in effect for this seller.")
    expect(seller.refund_policy.reload.max_refund_period_in_days).to eq(30)
  end

  it "keeps an enforced policy at 7 days or more", parity: true do
    seller.update!(refund_policy_enforced: true)

    api_call(:put, "/refund_policy", token:, params: { refund_period: "none" })

    expect(response.parsed_body["message"]).to eq("Max refund period in days must offer a refund period of at least 7 days while a refund policy is enforced on this account")
    expect(seller.refund_policy.reload.max_refund_period_in_days).to eq(30)
  end

  it "accepts 7 days on an enforced policy", parity: true do
    seller.update!(refund_policy_enforced: true)

    api_call(:put, "/refund_policy", token:, params: { refund_period: "7" })

    expect(response.parsed_body["refund_policy"]["refund_period"]).to eq("7")
  end

  it "refuses a read-only token", parity: true do
    api_call(:put, "/refund_policy", token: api_token(seller, scopes: "view_public"), params: { refund_period: "14" })

    expect(response).to have_http_status(:forbidden)
  end

  it "refuses a request without a token", parity: true do
    api_call(:put, "/refund_policy", params: { refund_period: "14" })

    expect(response).to have_http_status(:unauthorized)
  end

  it "hands a new fine print on a refund window back to Rails, which classifies it", parity: true do
    api_call(:put, "/refund_policy", token:, params: { refund_period: "14", fine_print: "Refunds within 14 days." })

    expect(response).to have_http_status(:ok)
  end

  it "hands a list-valued refund period back to Rails", parity: true do
    api_call(:put, "/refund_policy", token:, params: { refund_period: ["14"] }, as: :json)

    expect(response).to have_http_status(:ok)
  end
end
