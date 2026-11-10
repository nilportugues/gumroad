# frozen_string_literal: true

require "spec_helper"

# Signed-in visits to /customers and /customers/:product_id, recorded for the Next.js port (PARITY_RECORD=1) and
# replayed by nextjs/parity/__tests__/customers.replay.test.ts, which sends the last request of each example and
# rebuilds the purchases index from the rows it seeds.
describe "Customers page when signed in", type: :request, elasticsearch_wait_for_refresh: true do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Customers Seller", created_at: 120.days.ago) }
  let(:product) { create(:product, user: seller, name: "Alpha") }

  before do
    host! DOMAIN
    Purchase.__elasticsearch__.create_index!(force: true)
  end

  def sign_in_with_indexed_sales
    index_model_records(Purchase)
    log_in(seller)
  end

  # Midday, so the replay clock (whole hours) cannot move a sale across the seller's day boundary.
  def at_midday(days_ago) = days_ago.days.ago.in_time_zone(seller.timezone).change(hour: 12).utc

  def sell(link, days_ago:, **attributes)
    # The purchase factory charges a card through Stripe; the page only needs the row.
    build(:purchase, link:, seller:, created_at: at_midday(days_ago), purchase_state: "successful", **attributes).tap { _1.save!(validate: false) }
  end

  def customers_of(response) = inertia_props_of(response).dig("customers_presenter", "customers")

  it "redirects a signed-out visitor to the login page", parity: true do
    get customers_path

    expect(response).to redirect_to(login_path(next: "/customers"))
  end

  it "lists no customers for a seller without sales", parity: true do
    log_in(seller)

    get customers_path

    expect(response).to be_successful
    expect(inertia_props_of(response).dig("customers_presenter", "count")).to eq(0)
  end

  it "lists the customers newest first with their purchase details", parity: true do
    other = create(:product, user: seller, name: "Beta", price_cents: 700)
    sell(product, days_ago: 5, full_name: "  Ada Lovelace ")
    sell(other, days_ago: 2, quantity: 2, price_cents: 1400)
    sell(product, days_ago: 9, email: "second@example.com")
    sign_in_with_indexed_sales

    get customers_path

    expect(response).to be_successful
    expect(customers_of(response).size).to eq(3)
  end

  it "pages through more customers than fit on a page", parity: true do
    22.times { |index| sell(product, days_ago: index + 1) }
    sign_in_with_indexed_sales

    get customers_path

    expect(inertia_props_of(response).dig("customers_presenter", "pagination")).to include("page" => 1, "pages" => 2)
    expect(customers_of(response).size).to eq(20)
  end

  it "reads the page parameter of the index as an offset of whole pages from the start, as Rails does", parity: true do
    22.times { |index| sell(product, days_ago: index + 1) }
    sign_in_with_indexed_sales

    get customers_path(page: 2)

    expect(inertia_props_of(response).dig("customers_presenter", "count")).to eq(22)
    expect(customers_of(response)).to eq([])
  end

  it "narrows the list to one product", parity: true do
    other = create(:product, user: seller, name: "Beta")
    sell(product, days_ago: 3)
    sell(other, days_ago: 4)
    sign_in_with_indexed_sales

    get customers_link_id_path(product.unique_permalink)

    expect(inertia_props_of(response).dig("customers_presenter", "product_id")).to eq(product.external_id)
    expect(customers_of(response).size).to eq(1)
  end

  it "lists every customer when the product does not exist", parity: true do
    sell(product, days_ago: 3)
    sign_in_with_indexed_sales

    get customers_link_id_path("nope")

    expect(inertia_props_of(response).dig("customers_presenter", "product_id")).to be_nil
    expect(customers_of(response).size).to eq(1)
  end

  it "searches by the buyer's email and by the country they bought from", parity: true do
    sell(product, days_ago: 3, email: "findme@example.com", country: "United States")
    sell(product, days_ago: 4, email: "other@example.com", country: "Canada")
    sign_in_with_indexed_sales

    get customers_path(query: "findme", bought_from: "United States")

    expect(customers_of(response).map { _1["email"] }).to eq(["findme@example.com"])
  end

  it "shows the offer code a customer used and the price before it", parity: true do
    code = create(:offer_code, user: seller, products: [product], code: "SAVE", amount_cents: 100)
    sell(product, days_ago: 3, offer_code: code, price_cents: 400)
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).first["discount"]).to eq("type" => "fixed", "cents" => 100, "code" => "SAVE")
  end

  it "shows a percentage offer code", parity: true do
    priced = create(:product, user: seller, name: "Priced", price_cents: 500)
    code = create(:percentage_offer_code, user: seller, products: [priced], code: "HALF", amount_percentage: 50)
    sell(priced, days_ago: 3, offer_code: code, price_cents: 250)
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).first["discount"]).to include("type" => "percent", "percents" => 50)
  end

  it "shows the license key of a licensed product", parity: true do
    licensed = create(:product, user: seller, name: "Licensed", is_licensed: true)
    purchase = sell(licensed, days_ago: 3)
    create(:license, link: licensed, purchase:, uses: 4)
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).first["license"]).to include("uses" => 4, "enabled" => true)
  end

  it "shows a disabled license", parity: true do
    licensed = create(:product, user: seller, name: "Licensed", is_licensed: true)
    purchase = sell(licensed, days_ago: 3)
    create(:license, link: licensed, purchase:, disabled_at: 1.day.ago)
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).first["license"]).to include("enabled" => false)
  end

  it "shows the review and the seller's response", parity: true do
    purchase = sell(product, days_ago: 3)
    review = create(:product_review, purchase:, link: product, rating: 4, message: "Very good")
    create(:product_review_response, product_review: review, user: seller, message: "Thanks!")
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).first["review"]).to include("rating" => 4, "message" => "Very good", "response" => { "message" => "Thanks!" })
  end

  it "shows a review without a message", parity: true do
    purchase = sell(product, days_ago: 3)
    create(:product_review, purchase:, link: product, rating: 2, message: nil)
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).first["review"]).to include("rating" => 2, "message" => nil, "response" => nil)
  end

  it "shows where the customer came from and the purchasing power discount", parity: true do
    sell(product, days_ago: 3, referrer: "https://twitter.com/somebody")
    sell(product, days_ago: 4, referrer: "direct")
    sell(product, days_ago: 5, referrer: "https://news.example.com/story")
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).map { _1["referrer"] }).to eq(["Twitter", "Direct", "news.example.com"])
  end

  it "shows the customer's answers to custom text fields", parity: true do
    field = create(:custom_field, seller:, products: [product], name: "Company", type: "text")
    purchase = sell(product, days_ago: 3)
    create(:purchase_custom_field, purchase:, custom_field: field, name: "Company", value: "Acme", type: CustomField::TYPE_TEXT)
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).first["custom_fields"]).to eq([{ "attribute" => "Company", "type" => "text", "value" => "Acme" }])
  end

  it "counts a customer's downloads", parity: true do
    purchase = sell(product, days_ago: 3)
    purchase.url_redirect&.update!(uses: 3)
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).first).to have_key("download_count")
  end

  it "marks a revoked access", parity: true do
    sell(product, days_ago: 3, is_access_revoked: true)
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).first["is_access_revoked"]).to eq(true)
  end

  it "lists a product's variants for the filter box and hides an archived product that never sold", parity: true do
    create(:product_with_digital_versions, user: seller, name: "Versioned")
    create(:product, user: seller, name: "Hidden archive", archived: true)
    sell(product, days_ago: 3)
    sign_in_with_indexed_sales

    get customers_path

    expect(inertia_props_of(response).dig("customers_presenter", "products").map { _1["name"] }).to include("Versioned", "Alpha")
    expect(inertia_props_of(response).dig("customers_presenter", "products").map { _1["name"] }).not_to include("Hidden archive")
  end

  it "keeps an archived product that sold in the filter box", parity: true do
    archived = create(:product, user: seller, name: "Archived but sold")
    sell(archived, days_ago: 3)
    archived.update!(archived: true)
    sign_in_with_indexed_sales

    get customers_path

    expect(inertia_props_of(response).dig("customers_presenter", "products").map { _1["name"] }).to eq(["Archived but sold"])
  end

  it "shows a partially refunded customer", parity: true do
    purchase = sell(product, days_ago: 3, price_cents: 500)
    purchase.update_columns(stripe_partially_refunded: true)
    create(:refund, purchase:, amount_cents: 100)
    sign_in_with_indexed_sales

    get customers_path

    customer = customers_of(response).first
    expect(customer["partially_refunded"]).to eq(true)
    expect(customer.dig("price", "cents_refundable")).to eq(400)
  end

  it "counts a failed refund whose balance was not reversed against the refundable amount, and one that was reversed not", parity: true do
    kept = sell(product, days_ago: 3, price_cents: 500)
    reversed = sell(product, days_ago: 4, price_cents: 500)
    create(:refund, purchase: kept, amount_cents: 100, status: "failed")
    create(:refund, purchase: reversed, amount_cents: 100, status: "failed", balance_reversed_on_failure: true)
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).map { _1.dig("price", "cents_refundable") }).to eq([400, 500])
  end

  it "shows a fully refunded customer", parity: true do
    purchase = sell(product, days_ago: 3, price_cents: 500)
    purchase.update_columns(stripe_refunded: true)
    create(:refund, purchase:, amount_cents: 500)
    sign_in_with_indexed_sales

    get customers_path

    customer = customers_of(response).first
    expect(customer["refunded"]).to eq(true)
    expect(customer.dig("price", "cents_refundable")).to eq(0)
    expect(customer["is_access_revoked"]).to be_nil
  end

  it "shows the recipient of a gift on the sender's row", parity: true do
    sender = sell(product, days_ago: 3, is_gift_sender_purchase: true)
    create(:gift, link: product, gifter_purchase: sender, giftee_email: "giftee@example.com")
    sign_in_with_indexed_sales

    get customers_path

    customer = customers_of(response).first
    expect(customer["giftee_email"]).to eq("giftee@example.com")
    expect(customer["is_gift_sender_purchase"]).to eq(true)
  end

  it "reports the refundable amount of a non-USD sale in its own currency", parity: true do
    eur_product = create(:product, user: seller, name: "Euro", price_currency_type: "eur", price_cents: 1000)
    purchase = sell(eur_product, days_ago: 3, displayed_price_currency_type: "eur", displayed_price_cents: 1000, rate_converted_to_usd: "0.8", price_cents: 1250)
    create(:refund, purchase:, amount_cents: 250)
    sign_in_with_indexed_sales

    get customers_path

    price = customers_of(response).first["price"]
    expect(price["currency_type"]).to eq("eur")
    expect(price["cents_refundable"]).to eq(800)
  end

  it "serves a member with its subscription", parity: true do
    membership = create(:membership_product, user: seller, name: "Club")
    create(:membership_purchase, link: membership, seller:, created_at: at_midday(3))
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).first["subscription"]).to be_present
  end

  it "shows a commission whose deposit is paid and the work is not done", parity: true do
    commission_product = create(:commission_product, user: seller, name: "Portrait")
    deposit = sell(commission_product, days_ago: 3, is_commission_deposit_purchase: true)
    Commission.find_or_create_by!(deposit_purchase: deposit) { _1.status = Commission::STATUS_IN_PROGRESS }
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).first["commission"]).to include("status" => "in_progress", "files" => [], "files_are_editable" => true)
  end

  it "folds a charged commission completion into the deposit row", parity: true do
    commission_product = create(:commission_product, user: seller, name: "Portrait")
    deposit = sell(commission_product, days_ago: 3, is_commission_deposit_purchase: true)
    completion = sell(commission_product, days_ago: 1, is_commission_completion_purchase: true)
    commission = Commission.find_or_create_by!(deposit_purchase: deposit) { _1.status = Commission::STATUS_IN_PROGRESS }
    commission.update_columns(completion_purchase_id: completion.id, status: Commission::STATUS_COMPLETED)
    sign_in_with_indexed_sales

    get customers_path

    customer = customers_of(response).first
    expect(customer["commission"]).to include("status" => "completed", "files_are_editable" => false)
    expect(customer["price"]["cents"]).to eq(deposit.displayed_price_cents + completion.displayed_price_cents)
  end

  # Needs recording.
  it "leaves an in-progress commission completion with no processor reference out of the deposit row", parity: true do
    commission_product = create(:commission_product, user: seller, name: "Portrait")
    deposit = sell(commission_product, days_ago: 3, is_commission_deposit_purchase: true)
    completion = sell(commission_product, days_ago: 1, is_commission_completion_purchase: true, purchase_state: "in_progress", stripe_transaction_id: nil, processor_payment_intent_id: nil)
    commission = Commission.find_or_create_by!(deposit_purchase: deposit) { _1.status = Commission::STATUS_IN_PROGRESS }
    commission.update_columns(completion_purchase_id: completion.id)
    sign_in_with_indexed_sales

    get customers_path

    customer = customers_of(response).first
    expect(customer["commission"]).to include("status" => "in_progress", "files_are_editable" => false)
    expect(customer["price"]["cents"]).to eq(deposit.displayed_price_cents)
  end

  it "lists a review's pending and approved videos", parity: true do
    purchase = sell(product, days_ago: 3)
    review = create(:product_review, purchase:, link: product, rating: 5, message: "Great")
    create(:product_review_video, :approved, product_review: review)
    create(:product_review_video, :pending_review, product_review: review)
    create(:product_review_video, :rejected, product_review: review)
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).first.dig("review", "videos").map { _1["approval_status"] }).to eq(%w[pending_review approved])
  end

  it "lists a physical product sale with its shipping", parity: true do
    physical = create(:physical_product, user: seller, name: "Poster")
    build(:physical_purchase, link: physical, seller:, created_at: at_midday(3), purchase_state: "successful").tap { _1.save!(validate: false) }
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).first["shipping"]).to be_present
  end

  # Needs recording: tracking URLs that URI.parse accepts outside the simple form or raises on.
  it "shows a tracking URL only when Ruby's URI parser accepts it", parity: true do
    physical = create(:physical_product, user: seller, name: "Poster")
    urls = ["HTTPS://EXAMPLE.COM/track?n=1|2", "https://example.com/a|b", "https://example.com/#a#b", "https://user@example.com/x"]
    urls.each_with_index do |url, index|
      purchase = build(:physical_purchase, link: physical, seller:, email: "tracked#{index}@example.com", created_at: at_midday(3 + index), purchase_state: "successful").tap { _1.save!(validate: false) }
      # The model validates a lowercase http(s) prefix; the page must still cope with what a carrier integration stored.
      build(:shipment, purchase:, ship_state: :shipped, tracking_url: url).save!(validate: false)
    end
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).map { _1.dig("shipping", "tracking", "url") }).to eq(["HTTPS://EXAMPLE.COM/track?n=1|2", nil, nil, nil])
  end

  # Needs recording: has_one :shipment with two rows takes the lowest id.
  # Needs recording: IPv6 literal hosts, which URI::RFC3986_Parser takes.
  it "shows a tracking URL with an IPv6 literal host", parity: true do
    physical = create(:physical_product, user: seller, name: "Poster")
    urls = ["https://[2001:db8::7]:8080/track?n=1", "https://user@[::1]/x"]
    urls.each_with_index do |url, index|
      purchase = build(:physical_purchase, link: physical, seller:, email: "literal#{index}@example.com", created_at: at_midday(3 + index), purchase_state: "successful").tap { _1.save!(validate: false) }
      build(:shipment, purchase:, ship_state: :shipped, tracking_url: url).save!(validate: false)
    end
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).map { _1.dig("shipping", "tracking", "url") }).to eq(["https://[2001:db8::7]:8080/track?n=1", nil])
  end

  it "shows a tracking URL with an IPvFuture literal host and drops a zone id or a malformed literal", parity: true do
    physical = create(:physical_product, user: seller, name: "Poster")
    urls = ["https://[v1.fe]:8080/track?n=1", "https://user@[v1.fe]/x", "https://[fe80::1%25eth0]/x", "https://[1:2:3]/x", "https://[V1.fe]/x", "https://[v1.]/x"]
    urls.each_with_index do |url, index|
      purchase = build(:physical_purchase, link: physical, seller:, email: "future#{index}@example.com", created_at: at_midday(3 + index), purchase_state: "successful").tap { _1.save!(validate: false) }
      build(:shipment, purchase:, ship_state: :shipped, tracking_url: url).save!(validate: false)
    end
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).map { _1.dig("shipping", "tracking", "url") }).to eq(["https://[v1.fe]:8080/track?n=1", nil, nil, nil, nil, nil])
  end

  it "shows a non-ASCII tracking URL as typed when Ruby's parser accepts it once escaped", parity: true do
    physical = create(:physical_product, user: seller, name: "Poster")
    urls = ["https://exämple.com/pfad/日本語?n=ü", "https://example.com/😀", "https://example.com/é|1", "https://üser@example.com/é", "ftp://exämple.com/", "https://example.com/\u0085"]
    urls.each_with_index do |url, index|
      purchase = build(:physical_purchase, link: physical, seller:, email: "unicode#{index}@example.com", created_at: at_midday(3 + index), purchase_state: "successful").tap { _1.save!(validate: false) }
      build(:shipment, purchase:, ship_state: :shipped, tracking_url: url).save!(validate: false)
    end
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).map { _1.dig("shipping", "tracking", "url") }).to eq(["https://exämple.com/pfad/日本語?n=ü", "https://example.com/😀", nil, nil, nil, nil])
  end

  it "shows the first of several shipments of a purchase", parity: true do
    physical = create(:physical_product, user: seller, name: "Poster")
    purchase = build(:physical_purchase, link: physical, seller:, created_at: at_midday(3), purchase_state: "successful").tap { _1.save!(validate: false) }
    create(:shipment, purchase:, ship_state: :shipped, tracking_url: "https://example.com/first")
    create(:shipment, purchase:, ship_state: :shipped, tracking_url: "https://example.com/second")
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).first.dig("shipping", "tracking", "url")).to eq("https://example.com/first")
  end

  it "lets a support team member see the seller's customers", parity: true do
    member = create(:user)
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_SUPPORT)
    sell(product, days_ago: 3)
    index_model_records(Purchase)
    log_in(member)
    switch_to(membership)

    get customers_path

    expect(customers_of(response).size).to eq(1)
  end

  it "does not let a marketing team member see the customers' sales detail differently", parity: true do
    member = create(:user)
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_MARKETING)
    sell(product, days_ago: 3)
    index_model_records(Purchase)
    log_in(member)
    switch_to(membership)

    get customers_path

    expect(response).to be_successful
  end

  it "reports a seller with a license uses filter and ping endpoints", parity: true do
    Feature.activate_user(:license_uses_sales_filter, seller)
    log_in(seller)

    get customers_path

    expect(inertia_props_of(response).dig("customers_presenter", "license_uses_filter_enabled")).to eq(true)
  end

  # Needs recording: its utm_url exercises Addressable's sorting and percent-encoding.
  it "lists a sale driven by a UTM link with the link's sorted, encoded utm_url", parity: true do
    sale = sell(product, days_ago: 4)
    product_link = create(:utm_link, seller:, target_resource_type: "product_page", target_resource_id: product.id, utm_source: "news letter", utm_campaign: "Spring&Sale", utm_term: "a b", utm_content: "")
    visit = create(:utm_link_visit, utm_link: product_link)
    create(:utm_link_driven_sale, utm_link: product_link, utm_link_visit: visit, purchase: sale)
    other_sale = sell(product, days_ago: 6)
    profile_link = create(:utm_link, seller:, target_resource_type: "profile_page")
    create(:utm_link_driven_sale, utm_link: profile_link, utm_link_visit: create(:utm_link_visit, utm_link: profile_link), purchase: other_sale)
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).map { _1["utm_link"]&.fetch("utm_url") }).to all(be_present)
  end

  # Needs recording: the sender's row shows the license of the recipient's purchase (Purchase#linked_license).
  it "shows the recipient's license on the sender's row of a gift of a licensed product", parity: true do
    licensed = create(:product, user: seller, name: "Licensed", is_licensed: true)
    sender = sell(licensed, days_ago: 3, is_gift_sender_purchase: true, email: "gifter@example.com")
    receiver = sell(licensed, days_ago: 3, is_gift_receiver_purchase: true, purchase_state: "gift_receiver_purchase_successful", email: "giftee@example.com")
    create(:gift, link: licensed, gifter_purchase: sender, giftee_purchase: receiver, gifter_email: "gifter@example.com", giftee_email: "giftee@example.com")
    create(:license, link: licensed, purchase: receiver, uses: 2)
    sign_in_with_indexed_sales

    get customers_path

    sender_row = customers_of(response).find { _1["is_gift_sender_purchase"] }
    expect(sender_row["license"]).to include("uses" => 2, "enabled" => true)
  end

  # Needs recording: Purchase#variant_attributes.first picks the option of a sale of several.
  it "shows the first option of a sale of several options", parity: true do
    category = create(:variant_category, link: product, title: "Size")
    small = create(:variant, variant_category: category, name: "Small")
    large = create(:variant, variant_category: category, name: "Large")
    sale = sell(product, days_ago: 3)
    sale.variant_attributes = [small, large]
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).first["option"]).to include("name" => "Small")
  end

  # Needs recording: own_affiliate_credit_cents takes the direct affiliate's part off a collaborator sale.
  it "shows the collaborator's own credit on a sale that also credits a direct affiliate", parity: true do
    collaborator = create(:collaborator, seller:, affiliate_user: create(:user), affiliate_basis_points: 5000)
    direct_affiliate = create(:direct_affiliate, seller:, affiliate_user: create(:user), affiliate_basis_points: 1000, products: [product])
    sell(product, days_ago: 3, price_cents: 1000, affiliate: collaborator, affiliate_credit_cents: 400, direct_affiliate_id: direct_affiliate.id, direct_affiliate_credit_cents: 100)
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).first["affiliate"]).to be_present
  end

  it "asks a member whose renewals an Indian card mandate disabled for a new payment method", parity: true do
    Feature.activate_user(StripeChargeProcessor::INDIA_CARD_MANDATE_RELIABILITY_FEATURE, seller)
    create(:merchant_account, user: nil, charge_processor_id: StripeChargeProcessor.charge_processor_id, charge_processor_merchant_id: nil)
    membership = create(:membership_product, user: seller, name: "Club", price_cents: 500)
    purchase = create(:membership_purchase, link: membership, seller:, price_cents: 500, created_at: at_midday(3))
    purchase.subscription.update_flag!(:renewal_disabled_due_to_indian_card_mandate, true, true)
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).first.dig("subscription", "status")).to eq("payment_method_update_required")
  end

  # Needs recording: Purchase#transaction_url_for_seller for a charge Gumroad did not make through Stripe.
  it "links a Braintree sale to the seller's transaction page", parity: true do
    sell(product, days_ago: 3, charge_processor_id: BraintreeChargeProcessor.charge_processor_id, stripe_transaction_id: "bt_txn_123")
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).first["transaction_url_for_seller"]).to include("bt_txn_123")
  end

  # Needs recording: a file field answered with no attachment lists no files.
  it "shows a file custom field answered without an attachment", parity: true do
    field = create(:custom_field, seller:, products: [product], name: "Brief", type: CustomField::TYPE_FILE, required: false)
    purchase = sell(product, days_ago: 3)
    create(:purchase_custom_field, purchase:, custom_field: field, name: "Brief", value: nil, type: CustomField::TYPE_FILE)
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).first["custom_fields"]).to eq([{ "attribute" => "Brief", "type" => "file", "files" => [] }])
  end

  it "lists the files attached to a commission in the order they were attached", parity: true do
    commission_product = create(:commission_product, user: seller, name: "Portrait")
    deposit = sell(commission_product, days_ago: 3, is_commission_deposit_purchase: true)
    commission = Commission.find_or_create_by!(deposit_purchase: deposit) { _1.status = Commission::STATUS_IN_PROGRESS }
    commission.files.attach(io: File.open(Rails.root.join("spec/support/fixtures/test.pdf")), filename: "sketch.pdf", content_type: "application/pdf")
    commission.files.attach(io: File.open(Rails.root.join("spec/support/fixtures/smilie.png")), filename: "final.draft.png", content_type: "image/png")
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).first.dig("commission", "files").map { _1.slice("name", "extension") }).to eq([{ "name" => "sketch", "extension" => "PDF" }, { "name" => "final.draft", "extension" => "PNG" }])
  end

  it "shows the processed preview of a review video's thumbnail", parity: true do
    purchase = sell(product, days_ago: 3)
    review = create(:product_review, purchase:, link: product, rating: 5, message: "Great")
    video = create(:product_review_video, :approved, product_review: review)
    video.video_file.thumbnail.attach(io: File.open(Rails.root.join("spec/support/fixtures/test-small.png")), filename: "thumbnail.png", content_type: "image/png")
    video.video_file.thumbnail.variant(:preview).processed
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).first.dig("review", "videos", 0, "thumbnail_url")).to be_present
  end

  it "shows the original thumbnail of a review video whose preview was never processed", parity: true do
    purchase = sell(product, days_ago: 3)
    review = create(:product_review, purchase:, link: product, rating: 5, message: "Great")
    video = create(:product_review_video, :approved, product_review: review)
    video.video_file.thumbnail.attach(io: File.open(Rails.root.join("spec/support/fixtures/test-small.png")), filename: "thumbnail.png", content_type: "image/png")
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).first.dig("review", "videos", 0, "thumbnail_url")).to be_present
  end

  it "adds the subscription's recurrence to the shipping of a member and says once for a single charge", parity: true do
    membership = create(:membership_product, user: seller, name: "Club", require_shipping: true)
    monthly = create(:membership_purchase, link: membership, seller:, email: "monthly@example.com", shipping_cents: 250, full_name: "Ship To", street_address: "1 Main St", country: "United States", state: "CA", zip_code: "94107", city: "San Francisco", created_at: at_midday(3))
    once = create(:membership_purchase, link: membership, seller:, email: "once@example.com", shipping_cents: 250, full_name: "Ship To", street_address: "1 Main St", country: "United States", state: "CA", zip_code: "94107", city: "San Francisco", created_at: at_midday(4))
    once.subscription.update_columns(charge_occurrence_count: 1)
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).map { _1.dig("shipping", "price") }).to eq(["$2.50 a month", "$2.50 once"])
    expect(monthly.reload.subscription).to be_present
  end

  it "shows the recurrence of the price of a purchase that has no subscription", parity: true do
    membership = create(:membership_product, user: seller, name: "Club", require_shipping: true)
    sell(membership, days_ago: 3, price: membership.prices.alive.first, shipping_cents: 250)
    sign_in_with_indexed_sales

    get customers_path

    customer = customers_of(response).first
    expect(customer["price"]["recurrence"]).to eq("monthly")
    expect(customer.dig("shipping", "price")).to eq("$2.50 a month")
  end

  it "asks a member whose next charge is free under a limited-cycle discount for a new payment method", parity: true do
    Feature.activate_user(StripeChargeProcessor::INDIA_CARD_MANDATE_RELIABILITY_FEATURE, seller)
    create(:merchant_account, user: nil, charge_processor_id: StripeChargeProcessor.charge_processor_id, charge_processor_merchant_id: nil)
    membership = create(:membership_product, user: seller, name: "Club", price_cents: 500)
    code = create(:percentage_offer_code, user: seller, products: [membership], amount_percentage: 50, duration_in_billing_cycles: 3)
    # A fixed-duration code that makes a membership free fails validation now; rows saved before that rule still exist.
    code.update_columns(amount_percentage: 100)
    purchase = create(:membership_purchase, link: membership, seller:, price_cents: 0, offer_code: code, created_at: at_midday(3))
    PurchaseOfferCodeDiscount.create!(purchase:, offer_code: code, offer_code_amount: 100, offer_code_is_percent: true, pre_discount_minimum_price_cents: 500, pre_discount_displayed_price_cents: 500, duration_in_months: 3)
    purchase.subscription.update_flag!(:renewal_disabled_due_to_indian_card_mandate, true, true)
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).first.dig("subscription", "status")).to eq("payment_method_update_required")
  end

  it "keeps a member whose next charge is free alive when the discount has no cycle limit", parity: true do
    Feature.activate_user(StripeChargeProcessor::INDIA_CARD_MANDATE_RELIABILITY_FEATURE, seller)
    create(:merchant_account, user: nil, charge_processor_id: StripeChargeProcessor.charge_processor_id, charge_processor_merchant_id: nil)
    membership = create(:membership_product, user: seller, name: "Club", price_cents: 500)
    code = create(:percentage_offer_code, user: seller, products: [membership], amount_percentage: 100)
    purchase = create(:membership_purchase, link: membership, seller:, price_cents: 0, offer_code: code, created_at: at_midday(3))
    PurchaseOfferCodeDiscount.create!(purchase:, offer_code: code, offer_code_amount: 100, offer_code_is_percent: true, pre_discount_minimum_price_cents: 500, pre_discount_displayed_price_cents: 500)
    purchase.subscription.update_flag!(:renewal_disabled_due_to_indian_card_mandate, true, true)
    sign_in_with_indexed_sales

    get customers_path

    expect(customers_of(response).first.dig("subscription", "status")).to eq("alive")
  end

  it "shows the recipient's license on the sender's row only when the option's content permits a license key", parity: true do
    license_node = { "type" => "licenseKey" }
    paragraph = { "type" => "paragraph", "content" => [{ "type" => "text", "text" => "Welcome" }] }
    offers = { "Without key" => [paragraph], "With key" => [paragraph, license_node], "No pages" => nil }
    offers.each_with_index do |(name, nodes), index|
      licensed = create(:product, user: seller, name:, is_licensed: true)
      category = create(:variant_category, link: licensed, title: "Plan")
      option = create(:variant, variant_category: category, name: "Basic")
      create(:rich_content, entity: option, description: nodes) if nodes
      sender = sell(licensed, days_ago: 3 + index, is_gift_sender_purchase: true, email: "gifter#{index}@example.com")
      receiver = sell(licensed, days_ago: 3 + index, is_gift_receiver_purchase: true, purchase_state: "gift_receiver_purchase_successful", email: "giftee#{index}@example.com")
      receiver.variant_attributes = [option]
      create(:gift, link: licensed, gifter_purchase: sender, giftee_purchase: receiver, gifter_email: "gifter#{index}@example.com", giftee_email: "giftee#{index}@example.com")
      create(:license, link: licensed, purchase: receiver, uses: 1)
    end
    sign_in_with_indexed_sales

    get customers_path

    senders = customers_of(response).select { _1["is_gift_sender_purchase"] }
    expect(senders.to_h { [_1.dig("product", "name"), _1["license"].present?] }).to eq("Without key" => false, "With key" => true, "No pages" => true)
  end
end
