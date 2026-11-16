# frozen_string_literal: true

require "spec_helper"

# GET /products/:product_id/remaining_call_availabilities.json, recorded for the Next.js port (PARITY_RECORD=1) and
# replayed by nextjs/parity/__tests__/ws12d.replay.test.ts. The clock is frozen the day before the US spring-forward
# change, because the answers hold day boundaries in the seller's zone and the replay freezes the same instant.
describe "Remaining call availabilities", type: :request do
  let(:frozen_at) { Time.utc(2026, 3, 7, 20, 0, 0) }

  let(:timezone) { "Pacific Time (US & Canada)" }
  let(:zone) { Time.find_zone!(timezone) }
  let(:seller) { create(:user, :eligible_for_service_products, name: "Call Seller", timezone:) }
  let(:product) { create(:call_product, user: seller, name: "Office hours", unique_permalink: "officehrs") }

  before do
    travel_to(frozen_at)
    host! DOMAIN
  end

  after { travel_back }

  def limits(minimum_notice_in_minutes:, maximum_calls_per_day: nil, on: product)
    on.call_limitation_info.update!(minimum_notice_in_minutes:, maximum_calls_per_day:)
  end

  def available(start_time, end_time, on: product)
    create(:call_availability, call: on, start_time:, end_time:)
  end

  # A booking without the card charge the purchase factories make.
  def sold_call(start_time, end_time, on: product, purchase_state: "successful", **purchase_attributes)
    purchase = build(:purchase, link: on, seller: on.user, purchase_state:, **purchase_attributes)
    purchase.save!(validate: false)
    Call.new(purchase:, start_time:, end_time:).save!(validate: false)
  end

  def fetch_availabilities(permalink = product.unique_permalink)
    get "/products/#{permalink}/remaining_call_availabilities.json"
  end

  it "answers 404 for a product that is not a call", parity: true do
    create(:product, user: seller, unique_permalink: "plainprod")

    fetch_availabilities("plainprod")

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 for an unknown permalink", parity: true do
    fetch_availabilities("nosuchone")

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 for a custom permalink", parity: true do
    product.update!(custom_permalink: "mycall")

    fetch_availabilities("mycall")

    expect(response).to have_http_status(:not_found)
  end

  it "returns no availabilities for a call product without any", parity: true do
    product

    fetch_availabilities

    expect(response.parsed_body).to eq("call_availabilities" => [])
  end

  it "merges overlapping and touching windows and leaves out windows in the past", parity: true do
    limits(minimum_notice_in_minutes: 0)
    available(zone.local(2026, 3, 6, 9), zone.local(2026, 3, 6, 17))
    available(zone.local(2026, 3, 10, 9), zone.local(2026, 3, 10, 12))
    available(zone.local(2026, 3, 10, 11), zone.local(2026, 3, 10, 15))
    available(zone.local(2026, 3, 10, 15), zone.local(2026, 3, 10, 17))
    available(zone.local(2026, 3, 11, 9), zone.local(2026, 3, 11, 10))

    fetch_availabilities

    expect(response.parsed_body["call_availabilities"].length).to eq(2)
  end

  it "moves the start of a window up to the minimum notice and drops a window inside it", parity: true do
    limits(minimum_notice_in_minutes: 180)
    available(frozen_at - 1.hour, frozen_at + 10.hours)
    available(frozen_at + 30.minutes, frozen_at + 2.hours)

    fetch_availabilities

    expect(response.parsed_body["call_availabilities"].length).to eq(1)
  end

  it "starts a window now when the product has no minimum notice", parity: true do
    limits(minimum_notice_in_minutes: nil)
    available(frozen_at - 1.hour, frozen_at + 5.hours)

    fetch_availabilities

    expect(response.parsed_body["call_availabilities"].length).to eq(1)
  end

  it "takes the booked calls out of a window, whichever of the seller's products they were booked on", parity: true do
    limits(minimum_notice_in_minutes: 0)
    other_call = create(:call_product, user: seller, name: "Second calls", unique_permalink: "secondcl")
    available(zone.local(2026, 3, 10, 9), zone.local(2026, 3, 10, 17))
    sold_call(zone.local(2026, 3, 10, 10), zone.local(2026, 3, 10, 11))
    sold_call(zone.local(2026, 3, 10, 13), zone.local(2026, 3, 10, 14), on: other_call)

    fetch_availabilities

    expect(response.parsed_body["call_availabilities"].length).to eq(3)
  end

  it "does not take out calls that were refunded, never paid for or booked by another seller", parity: true do
    limits(minimum_notice_in_minutes: 0)
    stranger_call = create(:call_product, user: create(:user, :eligible_for_service_products), name: "Not mine", unique_permalink: "strange")
    available(zone.local(2026, 3, 10, 9), zone.local(2026, 3, 10, 17))
    sold_call(zone.local(2026, 3, 10, 10), zone.local(2026, 3, 10, 11), stripe_refunded: true)
    sold_call(zone.local(2026, 3, 10, 12), zone.local(2026, 3, 10, 13), purchase_state: "failed")
    sold_call(zone.local(2026, 3, 10, 14), zone.local(2026, 3, 10, 15), on: stranger_call)

    fetch_availabilities

    expect(response.parsed_body).to eq("call_availabilities" => [{ "start_time" => zone.local(2026, 3, 10, 9).iso8601, "end_time" => zone.local(2026, 3, 10, 17).iso8601 }])
  end

  it "stops a window at the last day with room when the daily limit is reached, across the daylight saving change", parity: true do
    limits(minimum_notice_in_minutes: 0, maximum_calls_per_day: 1)
    available(zone.local(2026, 3, 7, 12), zone.local(2026, 3, 12, 12))
    sold_call(zone.local(2026, 3, 8, 12), zone.local(2026, 3, 8, 13))
    sold_call(zone.local(2026, 3, 9, 12), zone.local(2026, 3, 9, 13))
    sold_call(zone.local(2026, 3, 11, 12), zone.local(2026, 3, 11, 13))

    fetch_availabilities

    expect(response.parsed_body["call_availabilities"].length).to be >= 1
  end

  it "counts the calls booked on this product only toward its daily limit", parity: true do
    limits(minimum_notice_in_minutes: 0, maximum_calls_per_day: 1)
    other_call = create(:call_product, user: seller, name: "Second calls", unique_permalink: "secondcl")
    available(zone.local(2026, 3, 10, 9), zone.local(2026, 3, 11, 17))
    sold_call(zone.local(2026, 3, 10, 9), zone.local(2026, 3, 10, 10), on: other_call)
    sold_call(zone.local(2026, 3, 11, 9), zone.local(2026, 3, 11, 10))

    fetch_availabilities

    expect(response.parsed_body["call_availabilities"].length).to be >= 1
  end

  it "does not count refunded calls toward the daily limit", parity: true do
    limits(minimum_notice_in_minutes: 0, maximum_calls_per_day: 1)
    available(zone.local(2026, 3, 10, 9), zone.local(2026, 3, 11, 17))
    sold_call(zone.local(2026, 3, 10, 9), zone.local(2026, 3, 10, 10), stripe_refunded: true)
    sold_call(zone.local(2026, 3, 11, 9), zone.local(2026, 3, 11, 10))

    fetch_availabilities

    expect(response.parsed_body["call_availabilities"].length).to be >= 1
  end

  it "drops a window whose every day is full", parity: true do
    limits(minimum_notice_in_minutes: 0, maximum_calls_per_day: 1)
    available(zone.local(2026, 3, 10, 9), zone.local(2026, 3, 10, 17))
    available(zone.local(2026, 3, 10, 20), zone.local(2026, 3, 10, 22))
    sold_call(zone.local(2026, 3, 10, 18), zone.local(2026, 3, 10, 19))

    fetch_availabilities

    expect(response.parsed_body["call_availabilities"]).to eq([])
  end

  {
    "UTC" => "UTC",
    "London" => "London",
    "Tokyo" => "Tokyo",
    "Chennai" => "Chennai",
    "Newfoundland" => "Newfoundland",
    "Sydney" => "Sydney"
  }.each do |label, zone_name|
    it "writes the times in the seller's zone (#{label})", parity: true do
      seller.update!(timezone: zone_name)
      limits(minimum_notice_in_minutes: 0)
      available(frozen_at + 2.days, frozen_at + 2.days + 3.hours)

      fetch_availabilities

      expect(response.parsed_body["call_availabilities"].length).to eq(1)
    end
  end
end
