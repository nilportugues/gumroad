# frozen_string_literal: true

require "spec_helper"

# /products/:product_id/remaining_call_availabilities.json on a seller's host: routes.rb declares `resources :remaining_call_availabilities`
# there, but the controller defines only `index`, so the other six actions raise ActionNotFound (a 404) before any filter runs. Recorded
# for the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/seller-remaining-call-availabilities.replay.test.ts.
# An example named "hands a ..." is one Node leaves to Rails whole.
describe "Remaining call availabilities on a seller's host", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, :eligible_for_service_products, name: "Call Seller", username: "callseller", timezone: "UTC") }
  let(:product) { create(:call_product, user: seller, name: "Office hours", unique_permalink: "officehrs") }
  let(:base) { "/products/#{product.unique_permalink}/remaining_call_availabilities" }

  before { host! seller.subdomain }

  it "lists the slots of a call product", parity: true do
    product.call_limitation_info.update!(minimum_notice_in_minutes: 0, maximum_calls_per_day: nil)
    create(:call_availability, call: product, start_time: Time.current.beginning_of_hour + 2.days, end_time: Time.current.beginning_of_hour + 2.days + 3.hours)

    get "#{base}.json"

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body["call_availabilities"].size).to eq(1)
  end

  it "answers 404 for a product that is not a call", parity: true do
    create(:product, user: seller, unique_permalink: "plainprod")

    get "/products/plainprod/remaining_call_availabilities.json"

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 for a new availability", parity: true do
    get "#{base}/new.json"

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 for an availability's edit form", parity: true do
    get "#{base}/1/edit.json"

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 for showing an availability", parity: true do
    get "#{base}/1.json"

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 for creating an availability", parity: true do
    post "#{base}.json"

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 for patching an availability", parity: true do
    patch "#{base}/1.json"

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 for putting an availability", parity: true do
    put "#{base}/1.json"

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 for deleting an availability", parity: true do
    delete "#{base}/1.json"

    expect(response).to have_http_status(:not_found)
  end

  it "hands a signed-in seller to Rails", parity: true do
    host! DOMAIN
    log_in(seller)
    host! seller.subdomain

    get "#{base}/new.json"

    expect(response).to have_http_status(:not_found)
  end
end
