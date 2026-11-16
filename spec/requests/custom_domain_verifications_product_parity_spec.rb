# frozen_string_literal: true

require "spec_helper"

# POST /custom_domain/verify with a `product_id` (CustomDomain::VerificationsController#create), recorded for the Next.js port (PARITY_RECORD=1)
# and replayed by nextjs/parity/__tests__/custom-domain-verifications-product.replay.test.ts, which answers DNS from the same zone as the stub
# below (keep the zone and that file in sync). Nothing is written: a domain that DNS accepts is checked against the product's custom domain
# (or a new one) with the model validations, and the first error is the message.
describe "Custom domain verification of a product's domain", type: :request do
  include Parity::AudienceSignedIn

  let(:zone) do
    {
      cname: {
        "configured-shop.example.com" => CUSTOM_DOMAIN_CNAME,
        "-bad.example.com" => CUSTOM_DOMAIN_CNAME,
        "taken-shop.example.com" => CUSTOM_DOMAIN_CNAME,
        "shop.#{INTERNAL_GUMROAD_DOMAIN}" => CUSTOM_DOMAIN_CNAME,
      },
      a: {
        CUSTOM_DOMAIN_CNAME => ["203.0.113.7"],
        CUSTOM_DOMAIN_STATIC_IP_HOST => ["203.0.113.7"],
        "aliased-shop.example.org" => ["203.0.113.7"],
      },
    }
  end

  let(:seller) { create(:named_seller, name: "Verifying Seller") }
  let(:product) { create(:product, user: seller) }
  let(:json_headers) { { "Accept" => "application/json", "Content-Type" => "application/json" } }

  before do
    host! DOMAIN
    allow_any_instance_of(Resolv::DNS).to receive(:getresources) do |_dns, name, type|
      if type == Resolv::DNS::Resource::IN::CNAME
        target = zone[:cname][name]
        target ? [double(name: target)] : []
      else
        Array(zone[:a][name]).map { |address| double(address:) }
      end
    end
  end

  def verify(body)
    post "/custom_domain/verify", params: body.to_json, headers: json_headers.merge("X-CSRF-Token" => csrf_token)
  end

  it "accepts a configured domain for a product without a custom domain", parity: true do
    log_in(seller)

    verify({ domain: "configured-shop.example.com", product_id: product.external_id })

    expect(response.parsed_body).to eq("success" => true, "message" => "configured-shop.example.com domain is correctly configured!")
  end

  it "accepts a domain set up with A records alone", parity: true do
    log_in(seller)

    verify({ domain: "aliased-shop.example.org", product_id: product.external_id })

    expect(response.parsed_body).to eq("success" => true, "message" => "aliased-shop.example.org domain is correctly configured!")
  end

  it "accepts the domain the product already has", parity: true do
    log_in(seller)
    CustomDomain.create!(product:, domain: "configured-shop.example.com")

    verify({ domain: "configured-shop.example.com", product_id: product.external_id })

    expect(response.parsed_body["success"]).to eq(true)
  end

  it "accepts a new domain for a product that has one already", parity: true do
    log_in(seller)
    CustomDomain.create!(product:, domain: "shop.example.net")

    verify({ domain: "configured-shop.example.com", product_id: product.external_id })

    expect(response.parsed_body["success"]).to eq(true)
  end

  it "refuses a domain another seller already uses", parity: true do
    log_in(seller)
    CustomDomain.create!(user: create(:user), domain: "taken-shop.example.com")

    verify({ domain: "taken-shop.example.com", product_id: product.external_id })

    expect(response.parsed_body).to eq("success" => false, "message" => "The custom domain is already in use.")
  end

  it "refuses a domain whose labels are malformed", parity: true do
    log_in(seller)

    verify({ domain: "-bad.example.com", product_id: product.external_id })

    expect(response.parsed_body).to eq("success" => false, "message" => "-bad.example.com is not a valid domain name.")
  end

  it "refuses a domain on one of Gumroad's own", parity: true do
    log_in(seller)

    verify({ domain: "shop.#{INTERNAL_GUMROAD_DOMAIN}", product_id: product.external_id })

    expect(response.parsed_body).to eq("success" => false, "message" => "shop.#{INTERNAL_GUMROAD_DOMAIN} is not a valid domain name.")
  end

  it "answers that a domain DNS does not accept is not configured, whatever the model says", parity: true do
    log_in(seller)

    verify({ domain: "unconfigured-shop.example.com", product_id: product.external_id })

    expect(response.parsed_body).to eq("success" => false, "message" => "Domain verification failed. Please make sure you have correctly configured the DNS record for unconfigured-shop.example.com.")
  end

  it "answers that a configured domain of an unknown product is not configured", parity: true do
    log_in(seller)

    verify({ domain: "configured-shop.example.com", product_id: "nobody" })

    expect(response.parsed_body).to eq("success" => false, "message" => "Domain verification failed. Please make sure you have correctly configured the DNS record for configured-shop.example.com.")
  end

  it "answers that a blank product_id is an unknown product", parity: true do
    log_in(seller)

    verify({ domain: "configured-shop.example.com", product_id: "" })

    expect(response.parsed_body["success"]).to eq(false)
  end

  it "answers a blank domain with a product_id", parity: true do
    log_in(seller)

    verify({ domain: "", product_id: product.external_id })

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body["success"]).to eq(false)
  end

  it "answers a missing domain with a product_id", parity: true do
    log_in(seller)

    verify({ product_id: product.external_id })

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body["success"]).to eq(false)
  end

  it "ignores a null product_id", parity: true do
    log_in(seller)

    verify({ domain: "taken-shop.example.com", product_id: nil })

    expect(response.parsed_body["success"]).to eq(true)
  end
end
