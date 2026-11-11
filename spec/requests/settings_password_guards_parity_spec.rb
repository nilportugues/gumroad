# frozen_string_literal: true

require "spec_helper"

# The refusals of Settings::PasswordController#update that Node answers (the owner-only policy, the unconfirmed OAuth account and the
# missing or wrong current password), recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/settings-password-guards.replay.test.ts, which sends the last request of each example. An example named
# "hands a ..." records what Node passes to Rails whole.
describe "Settings::PasswordController#update", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:named_seller, name: "Parity Seller") }
  let(:inertia_headers) do
    { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml", "Content-Type" => "application/json" }
  end
  let(:new_password) { "a-new-strong-password-1" }

  before { host! DOMAIN }

  def send_form(method, body)
    public_send(method, "/settings/password", params: body.to_json, headers: inertia_headers.merge("X-CSRF-Token" => csrf_token))
  end

  def as_team_member(role)
    member = create(:user, name: "#{role.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  it "refuses an admin member, who is not the account owner", parity: true do
    as_team_member(:admin)

    send_form(:patch, { user: { password: seller.password, new_password: } })

    expect(response).to have_http_status(:see_other)
    expect(response.location).to end_with("/dashboard")
    expect(flash[:alert]).to eq("Your current role as Admin cannot perform this action.")
  end

  it "refuses a wrong current password", parity: true do
    log_in(seller)

    send_form(:patch, { user: { password: "not-my-password", new_password: } })

    expect(response).to redirect_to("/settings/password")
    expect(flash[:alert]).to eq("Incorrect password.")
  end

  it "refuses a wrong current password on PUT as well", parity: true do
    log_in(seller)

    send_form(:put, { user: { password: "not-my-password", new_password: } })

    expect(response).to redirect_to("/settings/password")
    expect(flash[:alert]).to eq("Incorrect password.")
  end

  it "refuses a request with no current password", parity: true do
    log_in(seller)

    send_form(:patch, { user: { new_password: } })

    expect(flash[:alert]).to eq("Incorrect password.")
  end

  it "refuses a blank current password", parity: true do
    log_in(seller)

    send_form(:patch, { user: { password: "  ", new_password: } })

    expect(flash[:alert]).to eq("Incorrect password.")
  end

  it "refuses a request with an empty user", parity: true do
    log_in(seller)

    send_form(:patch, { user: {} })

    expect(flash[:alert]).to eq("Incorrect password.")
  end

  it "refuses a request with no user", parity: true do
    log_in(seller)

    send_form(:patch, {})

    expect(flash[:alert]).to eq("Incorrect password.")
  end

  it "refuses a current password that differs only in case", parity: true do
    log_in(seller)

    send_form(:patch, { user: { password: seller.password.swapcase, new_password: } })

    expect(flash[:alert]).to eq("Incorrect password.")
  end

  it "refuses an account whose hash is not bcrypt", parity: true do
    log_in(seller)
    seller.update_columns(encrypted_password: "0" * 64)

    send_form(:patch, { user: { password: seller.password, new_password: } })

    expect(flash[:alert]).to eq("Incorrect password.")
  end

  it "asks an unconfirmed OAuth account to confirm its email first", parity: true do
    log_in(seller)
    seller.update_columns(provider: "google_oauth2", confirmed_at: nil)

    send_form(:patch, { user: { new_password: } })

    expect(response).to redirect_to("/settings/password")
    expect(flash[:alert]).to eq("You have to confirm your email address before you can do that.")
  end

  it "hands a password change to Rails", parity: true do
    log_in(seller)

    send_form(:patch, { user: { password: seller.password, new_password: } })

    expect(response).to have_http_status(:see_other)
    expect(flash[:notice]).to eq("You have successfully changed your password.")
    expect(seller.reload.valid_password?(new_password)).to be(true)
  end

  it "hands a password change on PUT to Rails", parity: true do
    log_in(seller)

    send_form(:put, { user: { password: seller.password, new_password: } })

    expect(response).to have_http_status(:see_other)
  end

  it "hands a new password that is too short to Rails", parity: true do
    log_in(seller)

    send_form(:patch, { user: { password: seller.password, new_password: "abc" } })

    expect(response).to redirect_to("/settings/password")
    expect(flash[:alert]).to start_with("New password")
  end

  it "hands the first password of a confirmed OAuth account to Rails", parity: true do
    log_in(seller)
    seller.update_columns(provider: "google_oauth2")

    send_form(:patch, { user: { new_password: } })

    expect(response).to have_http_status(:see_other)
    expect(seller.reload.provider).to be_nil
  end

  it "hands a current password that is not text to Rails", parity: true do
    log_in(seller)

    send_form(:patch, { user: { password: 12_345, new_password: } })

    expect(response).to redirect_to("/settings/password")
    expect(flash[:alert]).to eq("Incorrect password.")
  end

  it "hands a user parameter that is not a hash to Rails", parity: true do
    log_in(seller)

    send_form(:patch, { user: "password" })

    expect(response).to redirect_to("/settings/password")
    expect(flash[:alert]).to eq("Incorrect password.")
  end
end
