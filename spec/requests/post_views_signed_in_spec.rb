# frozen_string_literal: true

require "spec_helper"

# The view counter a post page reports, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/ws11b.replay.test.ts.
describe "Post views", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Post Seller") }
  let(:buyer) { create(:user, name: "Post Reader") }
  let(:installment) { create(:audience_installment, seller:, name: "Launch post", shown_on_profile: true, published_at: Time.utc(2025, 1, 5)) }
  let(:headers) { { "Accept" => "application/json", "Content-Type" => "application/json", "User-Agent" => "Mozilla/5.0 (Macintosh) Safari/605.1.15" } }

  before { host! DOMAIN }

  def report_view(extra_headers = {}, id: installment.external_id)
    token = csrf_token
    post "/posts/#{id}/increment_post_views", params: {}.to_json, headers: headers.merge("X-CSRF-Token" => token).merge(extra_headers)
  end

  it "records a view for a signed-out visitor", parity: true do
    report_view

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to eq("success" => true)
    expect(InstallmentEvent.count).to eq(1)
  end

  it "records a view for a signed-in reader", parity: true do
    log_in(buyer)

    report_view

    expect(response).to have_http_status(:ok)
    expect(Event.last.user_id).to eq(buyer.id)
  end

  it "records the product of a post attached to one", parity: true do
    product = create(:product, user: seller, name: "Attached")
    attached = create(:installment, link: product, seller:, published_at: Time.utc(2025, 1, 5))

    report_view(id: attached.external_id)

    expect(response).to have_http_status(:ok)
    expect(Event.last.link_id).to eq(product.id)
  end

  it "does not count the seller's own view", parity: true do
    log_in(seller)

    report_view

    expect(response).to have_http_status(:ok)
    expect(InstallmentEvent.count).to eq(0)
  end

  it "does not count a crawler", parity: true do
    report_view({ "User-Agent" => "Googlebot/2.1 (+http://www.google.com/bot.html)" })

    expect(response).to have_http_status(:ok)
    expect(InstallmentEvent.count).to eq(0)
  end

  it "answers 404 for an unknown post", parity: true do
    report_view(id: "unknown")

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 for the post of a suspended seller", parity: true do
    installment
    seller.update_columns(user_risk_state: "suspended_for_tos_violation")

    report_view

    expect(response).to have_http_status(:not_found)
  end
end
