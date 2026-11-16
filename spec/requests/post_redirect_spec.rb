# frozen_string_literal: true

require "spec_helper"

# /:username/p/:slug on the Gumroad domain only ever redirects to the seller's own host or 404s,
# recorded for the Next.js port (PARITY_RECORD=1). Replayed by
# nextjs/parity/__tests__/public-pages.replay.test.ts.
describe "Post page on the Gumroad domain", type: :request do
  include Parity::SignedInRequests

  let(:seller) { create(:named_seller) }
  let(:post_record) { create(:audience_post, :published, seller:, shown_on_profile: true) }

  before { host! DOMAIN }

  it "redirects to the post on the seller's subdomain", parity: true do
    get "/#{seller.username}/p/#{post_record.slug}"

    expect(response).to have_http_status(:moved_permanently)
    expect(response.location).to eq("#{PROTOCOL}://#{seller.subdomain}/p/#{post_record.slug}")
  end

  it "keeps the query string, sorted and escaped", parity: true do
    get "/#{seller.username}/p/#{post_record.slug}", params: "purchase_id=abc&b=x y&a[]=2&a[]=1&c[d]=e~f"

    expect(response).to have_http_status(:moved_permanently)
  end

  it "finds the seller by external id", parity: true do
    get "/#{seller.external_id}/p/#{post_record.slug}"

    expect(response).to have_http_status(:moved_permanently)
  end

  it "redirects a signed-in visitor the same way", parity: true do
    visitor = create(:user, name: "Signed In Visitor")
    log_in(visitor, token_path: "/ping")

    get "/#{seller.username}/p/#{post_record.slug}"

    expect(response).to have_http_status(:moved_permanently)
  end

  it "answers an Inertia visit with the redirect", parity: true do
    get "/#{seller.username}/p/#{post_record.slug}", headers: { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest" }

    expect(response).to have_http_status(:moved_permanently)
  end

  it "is a 404 for an unknown post", parity: true do
    get "/#{seller.username}/p/no-such-post"

    expect(response).to have_http_status(:not_found)
  end

  it "is a 404 for an unknown user", parity: true do
    get "/nobody/p/#{post_record.slug}"

    expect(response).to have_http_status(:not_found)
  end

  it "is a 404 for a suspended user", parity: true do
    suspended = create(:user, username: "suspendedseller", user_risk_state: "suspended_for_fraud")

    get "/#{suspended.username}/p/#{post_record.slug}"

    expect(response).to have_http_status(:not_found)
  end

  it "is a 404 when the post's seller is suspended", parity: true do
    post_record
    seller.update_column(:user_risk_state, "suspended_for_tos_violation")
    other = create(:user, username: "otherseller")

    get "/#{other.username}/p/#{post_record.slug}"

    expect(response).to have_http_status(:not_found)
  end

end
