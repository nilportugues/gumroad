# frozen_string_literal: true

require "spec_helper"

# The 1099 download link of the dashboard (DashboardController#download_tax_form), recorded for the Next.js port (PARITY_RECORD=1)
# and replayed by nextjs/parity/__tests__/audience-next.replay.test.ts. Node follows a URL Rails already cached in Redis; signing a
# new one stays in Rails.
describe "Dashboard tax form download when signed in", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Tax Seller") }
  let(:cache_key) { "tax_form_1099_download_url_#{Time.current.year - 1}_#{seller.external_id}" }

  before { host! DOMAIN }

  it "redirects to the cached form", parity: true do
    $redis.set(cache_key, "https://files.example.com/forms/1099.pdf?signature=abc123")
    log_in(seller)

    get dashboard_download_tax_form_path

    expect(response).to redirect_to("https://files.example.com/forms/1099.pdf?signature=abc123")
    expect(response).to have_http_status(:found)
  end

  it "hands a seller without a cached form to Rails", parity: true do
    log_in(seller)

    get dashboard_download_tax_form_path

    expect(response).to have_http_status(:found)
  end

  it "redirects a signed-out visitor to the login page", parity: true do
    get dashboard_download_tax_form_path

    expect(response).to redirect_to(login_path(next: "/dashboard/download_tax_form"))
  end
end
