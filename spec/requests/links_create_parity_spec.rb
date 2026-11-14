# frozen_string_literal: true

require "spec_helper"

# POST /links, the "What are you creating?" form of the new product page: the price is parsed, the product and its price rows are
# written as a draft and the seller lands on its editor. Recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/links-create.replay.test.ts, which sends the last request of each example. An example named "hands a ..."
# is one Node leaves to Rails.
describe "Creating a product", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Creator Seller", is_team_member: true) }
  let(:headers) do
    { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml",
      "Content-Type" => "application/json", "Referer" => "http://#{DOMAIN}/products/new" }
  end
  let(:attributes) do
    { name: "Fresh product", price_range: "5", price_currency_type: "usd", native_type: "digital", is_physical: false,
      is_recurring_billing: false, subscription_duration: nil, description: nil, custom_summary: nil, ai_prompt: "" }
  end

  before do
    host! DOMAIN
    create(:taxonomy, slug: "other") unless Taxonomy.exists?(slug: "other")
    # The rates UpdateCurrenciesWorker keeps in Redis; a price above the unverified maximum is converted with them.
    rates = Redis::Namespace.new(:currencies, redis: $redis)
    { "EUR" => "0.9", "GBP" => "0.8", "JPY" => "150.0" }.each { |code, rate| rates.set(code, rate) }
  end

  def team_member(role)
    member = create(:user, name: "#{role.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
    member
  end

  def post_link(link = attributes)
    post "/links", params: { link: }.to_json, headers: headers.merge("X-CSRF-Token" => csrf_token)
  end

  def create_product(link = attributes, as: seller)
    log_in(as)
    post_link(link)
  end

  it "creates a draft digital product and opens its editor", parity: true do
    create_product

    product = seller.links.last
    expect(response).to have_http_status(:see_other)
    expect(response.location).to eq("http://#{DOMAIN}/products/#{product.unique_permalink}/edit")
    expect(product).to have_attributes(name: "Fresh product", draft: true, native_type: "digital", price_cents: 500)
  end

  it "creates a course", parity: true do
    create_product(attributes.merge(name: "A course", native_type: "course", price_range: "20"))

    expect(seller.links.last.native_type).to eq("course")
  end

  it "creates an ebook with the pages attribute its template adds", parity: true do
    create_product(attributes.merge(name: "Pages book", native_type: "ebook", price_range: "12.50"))

    expect(response).to have_http_status(:see_other)
    expect(seller.links.last.native_type).to eq("ebook")
  end

  it "creates an audiobook with the length attribute its template adds", parity: true do
    create_product(attributes.merge(name: "Spoken book", native_type: "audiobook", price_range: "9"))

    expect(seller.links.last.native_type).to eq("audiobook")
  end

  it "creates a free product, which becomes pay-what-you-want", parity: true do
    create_product(attributes.merge(name: "Free product", price_range: "0"))

    expect(response).to have_http_status(:see_other)
    expect(seller.links.last.customizable_price).to be(true)
  end

  it "makes a price ending in a plus pay-what-you-want", parity: true do
    create_product(attributes.merge(price_range: "5+"))

    expect(seller.links.last.customizable_price).to be(true)
  end

  it "reads a euro-style price", parity: true do
    create_product(attributes.merge(price_range: "5,50"))

    expect(seller.links.last.price_cents).to eq(550)
  end

  it "reads a price with thousands separators and a currency sign", parity: true do
    create_product(attributes.merge(price_range: "$1,234.50"))

    expect(seller.links.last.price_cents).to eq(123_450)
  end

  it "rounds half up to the cent", parity: true do
    create_product(attributes.merge(price_range: "12.345"))

    expect(seller.links.last.price_cents).to eq(1235)
  end

  it "reads a price sent as a number", parity: true do
    create_product(attributes.merge(price_range: 7.5))

    expect(seller.links.last.price_cents).to eq(750)
  end

  it "reads text with no digits as a free price", parity: true do
    create_product(attributes.merge(price_range: "free"))

    expect(seller.links.last.price_cents).to eq(0)
  end

  it "keeps a description", parity: true do
    create_product(attributes.merge(description: "<p>Hello</p>"))

    expect(seller.links.last.description).to eq("<p>Hello</p>")
  end

  it "ignores attributes the form sends that the model does not permit", parity: true do
    create_product(attributes.merge(number_of_content_pages: 4, release_at_date: "2026-01-01", custom_summary: ""))

    expect(response).to have_http_status(:see_other)
  end

  it "boosts the discover fee of a seller who opted in", parity: true do
    seller.update!(discover_boost_enabled: true)
    create_product

    expect(seller.links.last.discover_fee_per_thousand).to eq(300)
  end

  it "lets a verified seller price above the unverified maximum", parity: true do
    seller.update!(verified: true)
    create_product(attributes.merge(price_range: "6000"))

    expect(seller.links.last.price_cents).to eq(600_000)
  end

  it "creates the product of a seller who is not a team member", parity: true do
    seller.update!(is_team_member: false)
    create_product

    expect(seller.links.count).to eq(1)
  end

  it "records the event under the team member who created the product", parity: true do
    member = team_member(:admin)
    post_link

    expect(response).to have_http_status(:see_other)
    expect(Event.last.user_id).to eq(member.id)
  end

  it "creates a product for a seller whose profile has a products section that does not add new products", parity: true do
    create(:seller_profile_products_section, seller:, add_new_products: false)
    create_product

    expect(response).to have_http_status(:see_other)
  end

  it "sends the seller back with the first error when the name is blank", parity: true do
    create_product(attributes.merge(name: ""))

    expect(response).to have_http_status(:found)
    expect(seller.links.count).to eq(0)
  end

  it "refuses a name over 255 characters", parity: true do
    create_product(attributes.merge(name: "a" * 256))

    expect(response).to have_http_status(:found)
  end

  it "refuses a name with adult keywords", parity: true do
    create_product(attributes.merge(name: "Nude drawing guide"))

    expect(response).to have_http_status(:found)
  end

  it "refuses a description with adult keywords", parity: true do
    create_product(attributes.merge(description: "uncensored"))

    expect(response).to have_http_status(:found)
  end

  it "refuses a price under the minimum", parity: true do
    create_product(attributes.merge(price_range: "0.50"))

    expect(response).to have_http_status(:found)
  end

  it "refuses a negative price", parity: true do
    create_product(attributes.merge(price_range: "-5"))

    expect(response).to have_http_status(:found)
  end

  it "refuses a price above the unverified maximum", parity: true do
    create_product(attributes.merge(price_range: "6000"))

    expect(response).to have_http_status(:found)
  end

  it "refuses a price too large to store", parity: true do
    create_product(attributes.merge(price_range: "99999999999"))

    expect(response).to have_http_status(:found)
  end

  it "lists every error the product has, joined into a sentence", parity: true do
    create_product(attributes.merge(name: "", price_range: "0.50"))

    expect(response).to have_http_status(:found)
  end

  it "sends a member whose role cannot create products back to the dashboard", parity: true do
    team_member(:support)
    post_link

    expect(response).to have_http_status(:found)
    expect(seller.links.count).to eq(0)
  end


  describe "physical products" do
    it "answers 403 for a seller who may not sell physical products", parity: true do
      create_product(attributes.merge(is_physical: true))

      expect(response).to have_http_status(:forbidden)
      expect(seller.links.count).to eq(0)
    end

    it "creates a physical product for a seller flagged to sell them", parity: true do
      seller.update!(DEPRECATED_can_create_physical_products: true)
      create_product(attributes.merge(is_physical: true))

      expect(response).to have_http_status(:see_other)
      expect(seller.links.last).to have_attributes(is_physical: true, require_shipping: true)
    end

    it "creates a physical product for a seller who already lists one", parity: true do
      create(:physical_product, user: seller)
      create_product(attributes.merge(is_physical: true))

      expect(response).to have_http_status(:see_other)
    end

    it "answers 403 for an unconfirmed seller", parity: true do
      seller.update!(DEPRECATED_can_create_physical_products: true)
      seller.update_columns(confirmed_at: nil)
      create_product(attributes.merge(is_physical: true))

      expect(response).to have_http_status(:forbidden)
    end

    it "hands a physical product to Rails when the seller's sales decide", parity: true do
      seller.update!(created_at: 90.days.ago)
      create_product(attributes.merge(is_physical: true))

      expect(response).to have_http_status(:see_other).or have_http_status(:forbidden)
    end
  end

  describe "memberships" do
    let(:membership) { attributes.merge(native_type: "membership", is_recurring_billing: true, subscription_duration: "monthly") }

    it "creates a monthly membership with its default tier", parity: true do
      create_product(membership)

      expect(response).to have_http_status(:see_other)
      expect(seller.links.last.tiers.count).to eq(1)
    end

    %w[yearly quarterly biannually every_two_years].each do |duration|
      it "creates a #{duration.tr('_', ' ')} membership", parity: true do
        create_product(membership.merge(subscription_duration: duration))

        expect(seller.links.last.subscription_duration).to eq(duration)
      end
    end

    it "defaults the recurrence of a membership sent without one", parity: true do
      create_product(membership.merge(subscription_duration: nil))

      expect(response).to have_http_status(:see_other)
    end

    it "creates a free membership", parity: true do
      create_product(membership.merge(price_range: "0"))

      expect(seller.links.last.tiers.first.prices.alive.pluck(:price_cents)).to eq([0])
    end

    it "creates a membership priced with a plus", parity: true do
      create_product(membership.merge(price_range: "5+"))

      expect(response).to have_http_status(:see_other)
    end

    it "creates a membership for a seller with a boosted discover fee", parity: true do
      seller.update!(discover_boost_enabled: true)
      create_product(membership)

      expect(seller.links.last.discover_fee_per_thousand).to eq(300)
    end

    it "refuses a membership under the minimum price", parity: true do
      create_product(membership.merge(price_range: "0.50"))

      expect(response).to have_http_status(:found)
    end

    it "refuses a membership with a blank name", parity: true do
      create_product(membership.merge(name: ""))

      expect(response).to have_http_status(:found)
      expect(seller.links.count).to eq(0)
    end
  end

  describe "coffee" do
    before { seller.update!(created_at: 60.days.ago) }

    it "creates a coffee product with its suggested amount", parity: true do
      create_product(attributes.merge(native_type: "coffee", price_range: "3"))

      expect(response).to have_http_status(:see_other)
      expect(seller.links.last.variant_categories.first.title).to eq("Suggested Amounts")
    end

    it "refuses a free coffee product", parity: true do
      create_product(attributes.merge(native_type: "coffee", price_range: "0"))

      expect(response).to have_http_status(:found)
    end

    it "refuses a coffee product under the minimum price", parity: true do
      create_product(attributes.merge(native_type: "coffee", price_range: "0.50"))

      expect(response).to have_http_status(:found)
    end
  end

  describe "second coffee product" do
    before { seller.update!(created_at: 60.days.ago) }

    it "refuses a second coffee product", parity: true do
      create(:product, user: seller, native_type: "coffee", name: "Coffee")
      create_product(attributes.merge(native_type: "coffee", price_range: "3"))

      expect(response).to have_http_status(:found)
    end

    it "creates a coffee product when the earlier one was deleted", parity: true do
      create(:product, user: seller, native_type: "coffee", name: "Coffee", deleted_at: 1.day.ago)
      create_product(attributes.merge(native_type: "coffee", price_range: "3"))

      expect(response).to have_http_status(:see_other)
    end
  end

  describe "bundles" do
    it "creates a bundle", parity: true do
      create_product(attributes.merge(native_type: "bundle", price_range: "3"))

      expect(response).to have_http_status(:see_other)
      expect(seller.links.last.is_bundle).to be(true)
    end
  end

  describe "custom summary" do
    it "creates a product with a custom summary and submits it to IndexNow", parity: true do
      create_product(attributes.merge(custom_summary: "In one line"))

      expect(seller.links.last.custom_summary).to eq("In one line")
    end

    it "creates an ebook with a custom summary", parity: true do
      create_product(attributes.merge(native_type: "ebook", custom_summary: "Short"))

      expect(seller.links.last.json_data.keys).to eq(%w[custom_summary custom_attributes])
    end

    it "creates a membership with a custom summary", parity: true do
      create_product(attributes.merge(native_type: "membership", is_recurring_billing: true, subscription_duration: "monthly", custom_summary: "Short"))

      expect(response).to have_http_status(:see_other)
    end

    it "creates a coffee product with a custom summary", parity: true do
      seller.update!(created_at: 60.days.ago)
      create_product(attributes.merge(native_type: "coffee", price_range: "3", custom_summary: "Short"))

      expect(response).to have_http_status(:see_other)
    end

    it "creates a physical product with a custom summary", parity: true do
      seller.update!(DEPRECATED_can_create_physical_products: true)
      create_product(attributes.merge(is_physical: true, custom_summary: "Short"))

      expect(response).to have_http_status(:see_other)
    end

    it "sends the seller back when a product with a custom summary is invalid", parity: true do
      create_product(attributes.merge(name: "", custom_summary: "Short"))

      expect(response).to have_http_status(:found)
      expect(seller.links.count).to eq(0)
    end
  end

  describe "AI prompt" do
    it "hands a product with an AI prompt to Rails", parity: true do
      create_product(attributes.merge(ai_prompt: "an ebook about birds"))

      expect(response).to have_http_status(:see_other)
    end
  end

  describe "missing price" do
    it "sends the seller back when the form sends no price", parity: true do
      create_product(attributes.except(:price_range))

      expect(response).to have_http_status(:found)
      expect(seller.links.count).to eq(0)
    end

    it "sends the seller back when the form sends a null price", parity: true do
      create_product(attributes.merge(price_range: nil))

      expect(response).to have_http_status(:found)
    end

    it "sends the seller back when a membership is sent without a price", parity: true do
      create_product(attributes.except(:price_range).merge(native_type: "membership", is_recurring_billing: true, subscription_duration: "monthly"))

      expect(response).to have_http_status(:found)
    end
  end

  describe "other currencies" do
    it "creates a product priced in euros", parity: true do
      create_product(attributes.merge(price_currency_type: "eur"))

      expect(seller.links.last.price_currency_type).to eq("eur")
    end

    it "creates a product priced in a single-unit currency", parity: true do
      create_product(attributes.merge(price_currency_type: "jpy", price_range: "500"))

      expect(seller.links.last.price_cents).to eq(500)
    end

    it "reads an uppercase currency code", parity: true do
      create_product(attributes.merge(price_currency_type: "GBP", price_range: "3"))

      expect(seller.links.last.price_currency_type).to eq("gbp")
    end

    it "creates a membership priced in euros", parity: true do
      create_product(attributes.merge(price_currency_type: "eur", native_type: "membership", is_recurring_billing: true, subscription_duration: "monthly"))

      expect(response).to have_http_status(:see_other)
    end

    it "refuses a euro price over the unverified maximum", parity: true do
      create_product(attributes.merge(price_currency_type: "eur", price_range: "6000"))

      expect(response).to have_http_status(:found)
    end

    it "refuses a euro price under the minimum", parity: true do
      create_product(attributes.merge(price_currency_type: "eur", price_range: "0.50"))

      expect(response).to have_http_status(:found)
    end
  end

  describe "mobile app web view" do
    it "hands a request from the mobile app web view to Rails", parity: true do
      log_in(seller)
      post "/links?display=mobile_app", params: { link: attributes }.to_json, headers: headers.merge("X-CSRF-Token" => csrf_token)

      expect(response).to have_http_status(:see_other)
    end
  end

  describe "profile sections" do
    it "adds the new product to a products section that adds new products", parity: true do
      section = create(:seller_profile_products_section, seller:, add_new_products: true)
      create_product

      expect(section.reload.shown_products).to eq([seller.links.last.id])
    end

    it "adds the new product to every section that adds new products and leaves the others", parity: true do
      first = create(:seller_profile_products_section, seller:, add_new_products: true)
      other = create(:seller_profile_products_section, seller:, add_new_products: false)
      second = create(:seller_profile_products_section, seller:, add_new_products: true)
      create_product

      id = seller.links.last.id
      expect([first.reload.shown_products, other.reload.shown_products, second.reload.shown_products]).to eq([[id], [], [id]])
    end

    it "appends to the products a section already shows", parity: true do
      earlier = create(:product, user: seller, name: "Earlier")
      section = create(:seller_profile_products_section, seller:, add_new_products: true, shown_products: [earlier.id])
      create_product

      expect(section.reload.shown_products.first).to eq(earlier.id)
    end

    it "adds the product of a seller with a saved profile, which takes the profile row lock", parity: true do
      create(:seller_profile, seller:)
      create(:seller_profile_products_section, seller:, add_new_products: true)
      create_product

      expect(response).to have_http_status(:see_other)
    end

    it "adds a membership to a section that adds new products", parity: true do
      section = create(:seller_profile_products_section, seller:, add_new_products: true)
      create_product(attributes.merge(native_type: "membership", is_recurring_billing: true, subscription_duration: "monthly"))

      expect(section.reload.shown_products).to eq([seller.links.last.id])
    end
  end

  describe "daily creation limit", :enforce_product_creation_limit do
    it "refuses the product of a seller who is not compliant and has created ten in a day", parity: true do
      seller.update!(is_team_member: false)
      10.times { |index| create(:product, user: seller, name: "Earlier #{index}") }
      seller.update_columns(user_risk_state: "not_reviewed")
      create_product

      expect(response).to have_http_status(:found)
      expect(seller.links.count).to eq(10)
    end

    it "creates the product of a seller who is not compliant and has created nine", parity: true do
      seller.update!(is_team_member: false)
      9.times { |index| create(:product, user: seller, name: "Earlier #{index}") }
      seller.update_columns(user_risk_state: "not_reviewed")
      create_product

      expect(response).to have_http_status(:see_other)
    end

    it "does not count products created more than a day ago or deleted", parity: true do
      seller.update!(is_team_member: false)
      6.times { |index| create(:product, user: seller, name: "Old #{index}", created_at: 2.days.ago) }
      4.times { |index| create(:product, user: seller, name: "Gone #{index}", deleted_at: 1.hour.ago) }
      seller.update_columns(user_risk_state: "not_reviewed")
      create_product

      expect(response).to have_http_status(:see_other)
    end

    it "stops a seller at the limit set on their account", parity: true do
      seller.update!(is_team_member: false)
      2.times { |index| create(:product, user: seller, name: "Earlier #{index}") }
      seller.daily_product_creation_limit = 2
      seller.save!
      create_product

      expect(response).to have_http_status(:found)
    end

    it "lets a seller create up to the limit set on their account", parity: true do
      seller.update!(is_team_member: false)
      2.times { |index| create(:product, user: seller, name: "Earlier #{index}") }
      seller.daily_product_creation_limit = 3
      seller.save!
      create_product

      expect(response).to have_http_status(:see_other)
    end

    it "never limits a team member", parity: true do
      12.times { |index| create(:product, user: seller, name: "Earlier #{index}") }
      seller.update_columns(user_risk_state: "not_reviewed")
      create_product

      expect(response).to have_http_status(:see_other)
    end

    it "creates the product of a compliant seller past ten in a day", parity: true do
      seller.update!(is_team_member: false)
      10.times { |index| create(:product, user: seller, name: "Earlier #{index}") }
      seller.update_columns(user_risk_state: "compliant")
      create_product

      expect(response).to have_http_status(:see_other)
    end
  end
end
