# frozen_string_literal: true

require "spec_helper"

# AffiliateRequests::OnboardingFormController#update: the guards and the refusal Node answers in front of the save, recorded for the
# Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/ws12n.replay.test.ts, which sends the last request of each
# example. An example named "hands a ..." records what Node passes to Rails whole: the form saves the products or answers JSON.
describe "AffiliateRequests::OnboardingFormController", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:named_seller, name: "Onboarding Seller") }
  let!(:product) { create(:product, user: seller, name: "Onboarding product") }

  before { host! DOMAIN }

  def as_team_member(role)
    member = create(:user, name: "#{role.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  def form_body(enabled:, products: [{ id: product.external_id_numeric, enabled:, fee_percent: 10, destination_url: nil }])
    { disable_global_affiliate: false, products: }
  end

  def save_form(body, inertia: true)
    headers = { "X-Requested-With" => "XMLHttpRequest", "Content-Type" => "application/json", "X-CSRF-Token" => csrf_token }
    headers = headers.merge("X-Inertia" => "true", "Accept" => "text/html, application/xhtml+xml") if inertia
    patch "/affiliate_requests/onboarding_form", params: body.to_json, headers:
  end

  it "sends a signed-out visitor to sign in", parity: true do
    save_form(form_body(enabled: true))

    expect(response).to have_http_status(:see_other)
    expect(response.location).to start_with("#{PROTOCOL}://#{DOMAIN}/login")
  end

  it "answers something went wrong to a support team member, whose refusal the action rescues", parity: true do
    as_team_member(TeamMembership::ROLE_SUPPORT)

    save_form(form_body(enabled: true))

    expect(response).to redirect_to(onboarding_affiliates_path)
    expect(flash[:alert]).to eq("Something went wrong")
  end

  it "refuses to turn every product off while a request is unattended", parity: true do
    create(:affiliate_request, seller:, email: "waiting@example.com")
    log_in(seller)

    save_form(form_body(enabled: false))

    expect(response).to redirect_to(onboarding_affiliates_path)
    expect(flash[:alert]).to eq("You need to have at least one product enabled since there are some pending affiliate requests")
  end

  it "refuses to turn every product off while an approved requester has not signed up", parity: true do
    request = create(:affiliate_request, seller:, email: "notyet@example.com")
    request.update_columns(state: "approved")
    log_in(seller)

    save_form(form_body(enabled: false))

    expect(response).to redirect_to(onboarding_affiliates_path)
    expect(flash[:alert]).to start_with("You need to have at least one product enabled")
  end

  it "refuses an empty product list while a request is unattended", parity: true do
    create(:affiliate_request, seller:, email: "waiting@example.com")
    log_in(seller)

    save_form(form_body(enabled: true, products: []))

    expect(response).to redirect_to(onboarding_affiliates_path)
    expect(flash[:alert]).to start_with("You need to have at least one product enabled")
  end

  it "counts only the seller's own products when the form names a foreign one", parity: true do
    create(:affiliate_request, seller:, email: "waiting@example.com")
    foreign = create(:product, user: create(:user, name: "Other Seller"), name: "Foreign product")
    log_in(seller)

    save_form(form_body(enabled: true, products: [{ id: foreign.external_id_numeric, enabled: true, fee_percent: 10 }]))

    expect(response).to redirect_to(onboarding_affiliates_path)
    expect(flash[:alert]).to start_with("You need to have at least one product enabled")
  end

  it "hands a form that keeps a product enabled to Rails", parity: true do
    create(:affiliate_request, seller:, email: "waiting@example.com")
    log_in(seller)

    save_form(form_body(enabled: true))

    expect(response).to redirect_to(onboarding_affiliates_path)
    expect(flash[:notice]).to eq("Changes saved!")
  end

  it "hands a form that turns every product off with nothing pending to Rails", parity: true do
    log_in(seller)

    save_form(form_body(enabled: false))

    expect(response).to redirect_to(onboarding_affiliates_path)
    expect(flash[:notice]).to eq("Changes saved!")
  end

  it "hands a form to Rails when the approved requester has signed up", parity: true do
    signed_up = create(:user, name: "Signed Up", email: "signedup@example.com")
    request = create(:affiliate_request, seller:, email: signed_up.email)
    request.update_columns(state: "approved")
    log_in(seller)

    save_form(form_body(enabled: false))

    expect(flash[:notice]).to eq("Changes saved!")
  end

  it "answers something went wrong for a request without products", parity: true do
    log_in(seller)

    save_form({ disable_global_affiliate: false })

    expect(response).to redirect_to(onboarding_affiliates_path)
    expect(flash[:alert]).to eq("Something went wrong")
  end

  it "hands a request that is not an Inertia visit to Rails", parity: true do
    create(:affiliate_request, seller:, email: "waiting@example.com")
    log_in(seller)

    save_form(form_body(enabled: false), inertia: false)

    expect(response.parsed_body).to eq("success" => false, "error" => "You need to have at least one product enabled since there are some pending affiliate requests")
  end
end
