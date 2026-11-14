# frozen_string_literal: true

require "spec_helper"

# POST /settings/payments/opt_in_to_au_backtax_collection the way TaxesCollectionModal sends it (JSON body, Accept: application/json, the
# CSRF token in a header), recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/settings-mutations.replay.test.ts, which sends the last request of each example.
describe "Opting in to Australian backtax collection when signed in", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Backtax Seller", username: "backtaxseller", created_at: Time.utc(2025, 1, 1)) }
  let(:json_headers) { { "Accept" => "application/json", "Content-Type" => "application/json" } }

  before { host! DOMAIN }

  def opt_in(body)
    post opt_in_to_au_backtax_collection_settings_payments_path, params: body.to_json, headers: json_headers.merge("X-CSRF-Token" => csrf_token)
  end

  def agreements = BacktaxAgreement.where(user_id: seller.id)

  it "records the agreement of a seller with no compliance information", parity: true do
    log_in(seller)

    opt_in(signature: "Chuck Bartowski")

    expect(response.parsed_body).to eq("success" => true)
    expect(agreements.pluck(:jurisdiction, :signature)).to eq([["AUSTRALIA", "Chuck Bartowski"]])
    expect(seller.comments.count).to eq(0)
  end

  it "compares only the length of the signature with the legal name", parity: true do
    create(:user_compliance_info, user: seller)
    log_in(seller)

    opt_in(signature: "Charl Bartowski")

    expect(response.parsed_body).to eq("success" => true)
    expect(agreements.pluck(:signature)).to eq(["Charl Bartowski"])
  end

  it "asks for the exact name when the signature is shorter than the legal name", parity: true do
    create(:user_compliance_info, user: seller)
    log_in(seller)

    opt_in(signature: "Chuck")

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to eq("success" => false, "error" => "Please enter your exact name.")
    expect(agreements.count).to eq(0)
  end

  it "measures the legal name of a business by its business name", parity: true do
    create(:user_compliance_info_business, user: seller)
    log_in(seller)

    opt_in(signature: "Chuck Bartowski")

    expect(response.parsed_body).to eq("success" => false, "error" => "Please enter your exact name.")

    opt_in(signature: "Buy More, Inc")

    expect(response.parsed_body).to eq("success" => true)
    expect(agreements.pluck(:signature)).to eq(["Buy More, Inc"])
  end

  it "counts characters, not bytes", parity: true do
    create(:user_compliance_info, user: seller, first_name: "Zoë", last_name: "Núñez")
    log_in(seller)

    opt_in(signature: "Zoe Nunez")

    expect(response.parsed_body).to eq("success" => true)
    expect(agreements.pluck(:signature)).to eq(["Zoe Nunez"])
  end

  it "counts a character outside the basic plane once", parity: true do
    create(:user_compliance_info, user: seller, first_name: "Ann", last_name: "😀")
    log_in(seller)

    opt_in(signature: "abcde")

    expect(response.parsed_body).to eq("success" => true)
    expect(agreements.pluck(:signature)).to eq(["abcde"])
  end

  it "skips the length check when a business has no business name", parity: true do
    create(:user_compliance_info_business, user: seller, business_name: nil)
    log_in(seller)

    opt_in(signature: "Anyone At All")

    expect(response.parsed_body).to eq("success" => true)
    expect(agreements.count).to eq(1)
  end

  it "leaves an audit note when a team admin opts in", parity: true do
    admin = create(:user, name: "Team Admin", email: "admin@example.com")
    membership = create(:team_membership, user: admin, seller:, role: TeamMembership::ROLE_ADMIN)
    log_in(admin)
    switch_to(membership)

    opt_in(signature: "Team Admin Signed")

    expect(response.parsed_body).to eq("success" => true)
    expect(agreements.pluck(:signature)).to eq(["Team Admin Signed"])
    expect(seller.comments.pluck(:comment_type, :author_id, :content)).to eq([["note", admin.id, "Australia backtax collection agreement signed by team admin admin@example.com"]])
  end

  it "refuses a team member who cannot manage payouts", parity: true do
    member = create(:user, name: "Support Member", email: "support@example.com")
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_SUPPORT)
    log_in(member)
    switch_to(membership)

    opt_in(signature: "Support Member")

    expect(response).to have_http_status(:unauthorized)
    expect(agreements.count).to eq(0)
  end

  it "answers 403 JSON to a seller without an email address", parity: true do
    log_in(seller)
    seller.update_columns(email: nil, unconfirmed_email: nil)

    opt_in(signature: "Chuck Bartowski")

    expect(response).to have_http_status(:forbidden)
    expect(agreements.count).to eq(0)
  end

  it "answers 422 to a blank signature, which fails the validation", parity: true do
    log_in(seller)

    opt_in(signature: "  ")

    expect(response).to have_http_status(:unprocessable_entity)
    expect(agreements.count).to eq(0)
  end

  it "answers 422 to a request with no signature from a seller with no compliance information", parity: true do
    log_in(seller)

    opt_in({})

    expect(response).to have_http_status(:unprocessable_entity)
    expect(agreements.count).to eq(0)
  end
end
