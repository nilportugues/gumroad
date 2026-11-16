# frozen_string_literal: true

require "spec_helper"

# POST /orders for the requests that are refused before anything is written or any processor is called
# (nextjs/src/server/controllers/orders-validations.ts). Written for recording (PARITY_RECORD=1).
describe "Orders validations", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user) }
  let(:product) { create(:product, user: seller, unique_permalink: "ordersone", price_cents: 500) }
  let(:json_headers) do
    { "Accept" => "application/json", "X-Requested-With" => "XMLHttpRequest", "Content-Type" => "application/json", "Referer" => "http://#{DOMAIN}/checkout" }
  end

  before { host! DOMAIN }

  def post_order(body, user_agent: nil)
    token = csrf_token
    cookies[:_gumroad_guid] = "orders-guid"
    headers = json_headers.merge("X-CSRF-Token" => token)
    headers["User-Agent"] = user_agent if user_agent
    post "/orders", params: body.to_json, headers:
  end

  def line(item = product, uid: "uid-0", price: 500, **extra)
    { uid:, permalink: item.unique_permalink, perceived_price_cents: price, quantity: 1 }.merge(extra)
  end

  def order_body(*lines, **extra)
    { email: "buyer@example.com", cc_zipcode_required: "false", line_items: lines }.merge(extra)
  end

  def line_response(uid = "uid-0") = response.parsed_body.dig("line_items", uid)

  it "pretends a bot's order succeeded", parity: true do
    post_order(order_body(line), user_agent: "Googlebot/2.1")

    expect(response.parsed_body).to eq("success" => true)
  end

  it "refuses a cart above the product limit", parity: true do
    lines = Array.new(Cart::MAX_ALLOWED_CART_PRODUCTS + 1) { |i| line(uid: "uid-#{i}") }
    post_order(order_body(*lines))

    expect(response.parsed_body).to include("success" => false, "error_message" => "You cannot add more than 50 products to the cart.")
  end

  it "refuses a cart whose line items share a uid", parity: true do
    post_order(order_body(line, line))

    expect(response.parsed_body["line_items"].keys).to eq(["uid-0"])
    expect(line_response).to include("success" => false, "error_message" => "The cart data is invalid. Please refresh and try again.")
  end

  it "refuses a cart with a blank uid", parity: true do
    post_order(order_body(line(uid: "")))

    expect(response.parsed_body["line_items"][""]).to include("success" => false, "error_message" => "The cart data is invalid. Please refresh and try again.")
  end

  it "reports a product that does not exist", parity: true do
    post_order(order_body(line.merge(permalink: "nothere")))

    expect(line_response).to include("success" => false, "error_message" => "Product not found")
  end

  it "answers a request without line items", parity: true do
    post_order({ email: "buyer@example.com" })

    expect(response.parsed_body).to include("success" => true, "line_items" => {})
  end

  it "hands an order whose price does not match the product", parity: true do
    post_order(order_body(line(price: 100)))

    expect(line_response).to include("success" => false, "error_code" => "perceived_price_cents_not_matching")
  end

  it "hands an order for a sold out product", parity: true do
    product.update!(max_purchase_count: 1)
    build(:purchase, link: product, email: "first@example.com", purchase_state: "successful").save!(validate: false)
    post_order(order_body(line))

    expect(line_response).to include("success" => false)
  end

  it "hands an order for an unpublished product", parity: true do
    product.unpublish!
    post_order(order_body(line))

    expect(line_response).to include("success" => false)
  end

  it "hands an order for a deleted product", parity: true do
    product.mark_deleted!
    post_order(order_body(line))

    expect(line_response).to include("success" => false)
  end

  it "refuses an invalid email", parity: true do
    post_order(order_body(line, email: "not-an-email"))

    expect(line_response).to include("success" => false)
  end

  it "refuses a missing email", parity: true do
    post_order(order_body(line, email: ""))

    expect(line_response).to include("success" => false)
  end

  it "reads line items sent as an object keyed by position", parity: true do
    post_order(order_body.merge(line_items: { "0" => line.merge(permalink: "nothere"), "1" => line(uid: "uid-1").merge(permalink: "nothere") }))

    expect(line_response("uid-0")).to include("error_message" => "Product not found")
    expect(line_response("uid-1")).to include("error_message" => "Product not found")
  end

  it "answers a line with no uid under an empty key", parity: true do
    post_order(order_body(line.except(:uid)))

    expect(response.parsed_body["line_items"][""]).to include("error_message" => "The cart data is invalid. Please refresh and try again.")
  end

  it "reports each line of a mixed cart on its own", parity: true do
    post_order(order_body(line, line(uid: "uid-1").merge(permalink: "nothere"), email: "nobody"))

    expect(line_response("uid-0")).to include("error_message" => "valid email required")
    expect(line_response("uid-1")).to include("error_message" => "Product not found")
  end

  it "hands an order of a free product with an invalid email", parity: true do
    free = create(:product, user: seller, unique_permalink: "ordersfree", price_cents: 0)
    post_order(order_body(line(free, price: "0"), email: "nobody"))

    expect(line_response).to include("success" => false, "error_message" => "valid email required", "formatted_price" => "$0")
  end

  it "refuses an invalid email before the product's availability", parity: true do
    product.unpublish!
    post_order(order_body(line, email: "nobody@"))

    expect(line_response).to include("success" => false, "error_message" => "valid email required")
  end

  it "refuses an invalid email of a sold out product", parity: true do
    product.update!(max_purchase_count: 1)
    build(:purchase, link: product, email: "first@example.com", purchase_state: "successful").save!(validate: false)
    post_order(order_body(line, email: "nobody@example"))

    expect(line_response).to include("success" => false, "error_message" => "valid email required")
  end

  it "refuses an email without an email key", parity: true do
    post_order(order_body(line).except(:email))

    expect(line_response).to include("success" => false, "error_message" => "valid email required")
  end

  it "answers a request without line items to an email that has an account", parity: true do
    create(:user, email: "taken@example.com")
    post_order({ email: "taken@example.com" })

    expect(response.parsed_body).to include("success" => true, "can_buyer_sign_up" => false)
  end

  it "hands an order with a valid email", parity: true do
    post_order(order_body(line))

    expect(line_response).to include("success" => false)
  end

  it "hands a signed-in buyer's order with an invalid email", parity: true do
    buyer = create(:user)
    log_in(buyer)
    post_order(order_body(line, email: "nobody"))

    expect(response).to have_http_status(:ok)
  end

  it "hands an order with a discount code and an invalid email", parity: true do
    post_order(order_body(line.merge(discount_code: "SAVE"), email: "nobody"))

    expect(line_response).to include("success" => false)
  end

  it "hands a gift order with an invalid email", parity: true do
    post_order(order_body(line, email: "nobody", is_gift: true, giftee_email: "friend@example.com"))

    expect(line_response).to include("success" => false)
  end

  it "hands an order of a product with options and an invalid email", parity: true do
    category = create(:variant_category, title: "sizes", link: product)
    create(:variant, name: "small", variant_category: category)
    post_order(order_body(line, email: "nobody"))

    expect(line_response).to include("success" => false)
  end

  it "hands an order of a membership with an invalid email", parity: true do
    membership = create(:membership_product, user: seller, unique_permalink: "ordersmembr")
    post_order(order_body(line(membership, price: membership.price_cents), email: "nobody"))

    expect(line_response).to include("success" => false)
  end

  it "hands an order of a pay-what-you-want product with an invalid email", parity: true do
    pwyw = create(:product, user: seller, unique_permalink: "orderspwyw", price_cents: 500, customizable_price: true)
    post_order(order_body(line(pwyw, price: 700), email: "nobody"))

    expect(line_response).to include("success" => false)
  end

  it "hands an order of a product listed in another currency with an invalid email", parity: true do
    euro = create(:product, user: seller, unique_permalink: "orderseuro", price_cents: 500, price_currency_type: "eur")
    post_order(order_body(line(euro), email: "nobody"))

    expect(line_response).to include("success" => false)
  end

  it "hands an order of a product with a custom field and an invalid email", parity: true do
    create(:custom_field, seller:, products: [product], name: "Handle", type: "text", required: true)
    post_order(order_body(line, email: "nobody"))

    expect(line_response).to include("success" => false)
  end

  it "hands an order of two units with an invalid email", parity: true do
    post_order(order_body(line.merge(quantity: 2), email: "nobody"))

    expect(line_response).to include("success" => false)
  end

  it "hands an order of a physical product with an invalid email", parity: true do
    physical = create(:physical_product, user: seller, unique_permalink: "ordersphys", price_cents: 500)
    post_order(order_body(line(physical), email: "nobody"))

    expect(line_response).to include("success" => false)
  end
end
