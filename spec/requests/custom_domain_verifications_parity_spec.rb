# frozen_string_literal: true

require "spec_helper"

# POST /custom_domain/verify (CustomDomain::VerificationsController#create), recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/ws10-rest.replay.test.ts, which sends the last request of each example. DNS is stubbed on Resolv::DNS here; Node asks
# the resolver itself, so the examples recorded for replay are the ones whose answer no DNS record can change (a domain PublicSuffix refuses,
# a name nobody has configured). An example named "hands a ..." is one Node leaves to Rails: a `product_id` runs the CustomDomain validations.
describe "Custom domain verification", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:named_seller, name: "Verifying Seller") }
  let(:json_headers) { { "Accept" => "application/json", "Content-Type" => "application/json" } }

  before do
    host! DOMAIN
    allow(ViteRuby.instance.manifest).to receive(:resolve_entries).and_return({ stylesheets: ["/vite-test.css"] })
    allow_any_instance_of(ActionView::Base).to receive(:vite_client_tag).and_return("")
    allow_any_instance_of(ActionView::Base).to receive(:vite_react_refresh_tag).and_return("")
    allow_any_instance_of(ActionView::Base).to receive(:vite_typescript_tag).and_return("")
    # Gumroad's own targets resolve and nothing else does: with every lookup empty, two empty address lists compare equal and the alias check passes.
    allow_any_instance_of(Resolv::DNS).to receive(:getresources) do |_dns, name, _type|
      [CUSTOM_DOMAIN_CNAME, CUSTOM_DOMAIN_STATIC_IP_HOST].include?(name) ? [double(address: "203.0.113.7")] : []
    end
  end

  def verify(body, token: csrf_token)
    headers = token ? json_headers.merge("X-CSRF-Token" => token) : json_headers
    post "/custom_domain/verify", params: body.to_json, headers:
  end

  it "answers that a blank domain is not configured", parity: true do
    log_in(seller)

    verify({ domain: "" })

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to eq("success" => false, "message" => "Domain verification failed. Please make sure you have correctly configured the DNS record for .")
  end

  it "answers that a request without a domain is not configured", parity: true do
    log_in(seller)

    verify({})

    expect(response.parsed_body["success"]).to eq(false)
  end

  it "answers that a domain on a bare suffix is not configured", parity: true do
    log_in(seller)

    verify({ domain: "com" })

    expect(response.parsed_body["message"]).to eq("Domain verification failed. Please make sure you have correctly configured the DNS record for com.")
  end

  it "answers that a domain with a scheme is not configured", parity: true do
    log_in(seller)

    verify({ domain: "https://shop.example.com" })

    expect(response.parsed_body["success"]).to eq(false)
  end

  it "answers that a name without any DNS record is not configured", parity: true do
    log_in(seller)

    verify({ domain: "unconfigured-shop.example.com" })

    expect(response.parsed_body).to eq("success" => false, "message" => "Domain verification failed. Please make sure you have correctly configured the DNS record for unconfigured-shop.example.com.")
  end

  it "answers a team member without access to the advanced settings with a 401", parity: true do
    member = create(:user, name: "Support Member")
    membership = create(:team_membership, user: member, seller:, role: :support)
    log_in(member)
    switch_to(membership)

    verify({ domain: "shop.example.com" })

    expect(response).to have_http_status(:unauthorized)
  end

  it "hands a domain that carries a product_id to Rails", parity: true do
    log_in(seller)
    product = create(:product, user: seller)

    verify({ domain: "unconfigured-shop.example.com", product_id: product.external_id })

    expect(response).to have_http_status(:ok)
  end

  it "answers that a domain sent as a list is not configured", parity: true do
    log_in(seller)

    verify({ domain: ["shop.example.com"] })

    expect(response).to have_http_status(:ok)
  end
end
