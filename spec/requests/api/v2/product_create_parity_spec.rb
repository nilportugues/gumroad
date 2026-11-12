# frozen_string_literal: true

require "spec_helper"

# Api::V2::LinksController#create through the full Rack stack, recorded for the Next.js port
# (nextjs/parity/__tests__/api-v2-ws17c.replay.test.ts). Node creates a plain digital product: a name, a price in whole cents, a
# description, a custom summary, tags, a taxonomy and the draft or published flag, for a seller whose products can be published without
# a model call (see product_enable_parity_spec.rb). Every other attribute or product type goes to Rails whole, in an example named
# "hands a ... back to Rails". `parity_timeline` records the order of the statements and jobs inside the request.
# The daily creation limit is lifted in specs (spec_helper), so the replay proves the limit's message by the model port's own tests.
describe "API v2 product create", type: :request, parity_timeline: true do
  include Parity::ApiV2Requests

  let(:seller) { create(:user) }
  let(:token) { api_token(seller, scopes: "edit_products") }
  let(:created) { Link.order(:id).last }

  def create_product(params, headers: {}) = api_call(:post, "/products", token:, params:, as: :json, headers:)

  def message = response.parsed_body["message"]

  it "creates and publishes a product", parity: true, parity_timeline: true do
    create_product({ name: "Notebook", price: 500 })

    expect(response.parsed_body).to include("success" => true)
    expect(response.parsed_body.dig("product", "name")).to eq("Notebook")
    expect(response.parsed_body.dig("product", "published")).to be true
    expect(response.parsed_body).not_to have_key("warning")
    expect(created).to be_alive
    expect(created.price_cents).to eq(500)
  end

  it "creates a draft when draft is true", parity: true, parity_timeline: true do
    create_product({ name: "Notebook", price: 500, draft: true })

    expect(response.parsed_body.dig("product", "published")).to be false
    expect(created.draft).to be true
  end

  it "creates a draft when published is false", parity: true do
    create_product({ name: "Notebook", price: 500, published: false })

    expect(response.parsed_body.dig("product", "published")).to be false
  end

  it "reads draft the way ActiveModel casts a boolean", parity: true do
    create_product({ name: "Notebook", price: 500, draft: "0", published: "1" })

    expect(response.parsed_body.dig("product", "published")).to be true
  end

  it "creates a draft when draft is the text true", parity: true do
    create_product({ name: "Notebook", price: 500, draft: "true" })

    expect(response.parsed_body.dig("product", "published")).to be false
  end

  it "reads the price as a number of cents given as text", parity: true do
    create_product({ name: "Notebook", price: "1200" })

    expect(created.price_cents).to eq(1200)
  end

  it "saves a description, a summary and tags with the product", parity: true, parity_timeline: true do
    create_product({ name: "Notebook", price: 500, description: "<p>Dotted <strong>paper</strong></p>", custom_summary: "Sixty pages", tags: ["paper", "notes"] })

    expect(response.parsed_body.dig("product", "description")).to eq("<p>Dotted <strong>paper</strong></p>")
    expect(response.parsed_body.dig("product", "custom_summary")).to eq("Sixty pages")
    expect(response.parsed_body.dig("product", "tags")).to match_array(%w[paper notes])
  end

  it "reuses a tag that exists", parity: true, parity_timeline: true do
    Tag.create!(name: "paper")

    create_product({ name: "Notebook", price: 500, tags: ["paper"] })

    expect(Tag.where(name: "paper").count).to eq(1)
    expect(Tag.find_by(name: "paper").reload.taggings_count).to eq(1)
  end

  it "treats an empty tag list and a blank summary as nothing to save", parity: true do
    create_product({ name: "Notebook", price: 500, tags: [], custom_summary: "  " })

    expect(response.parsed_body).to include("success" => true)
  end

  it "files the product under a taxonomy that is given", parity: true do
    taxonomy = Taxonomy.find_by(slug: "design") || Taxonomy.create!(slug: "design")

    create_product({ name: "Notebook", price: 500, taxonomy_id: taxonomy.id.to_s })

    expect(created.taxonomy_id).to eq(taxonomy.id)
  end

  it "files the product under other when the taxonomy is blank", parity: true do
    Taxonomy.find_by(slug: "other") || Taxonomy.create!(slug: "other")

    create_product({ name: "Notebook", price: 500, taxonomy_id: "" })

    expect(created.taxonomy.slug).to eq("other")
  end

  it "accepts the native type of a plain product", parity: true do
    create_product({ name: "Notebook", price: 500, native_type: "digital" })

    expect(response.parsed_body).to include("success" => true)
  end

  it "warns that the product stays a draft when the seller has not confirmed the email", parity: true, parity_timeline: true do
    seller.update_columns(confirmed_at: nil)

    create_product({ name: "Notebook", price: 500 })

    expect(response.parsed_body["warning"]).to eq("Saved as a draft: You have to confirm your email address before you can do that.")
    expect(response.parsed_body.dig("product", "published")).to be false
  end

  it "refuses a product without a price", parity: true do
    create_product({ name: "Notebook" })

    expect(message).to eq("New products should be created with a price")
    expect(Link.where(user: seller).count).to eq(0)
  end

  it "refuses a product without a name", parity: true do
    create_product({ price: 500 })

    expect(message).to eq("Name can't be blank")
  end

  it "refuses a price that is too large before saving", parity: true do
    create_product({ name: "Notebook", price: 3_000_000_000 })

    expect(message).to eq("Sorry, the price entered is too large.")
  end

  it "refuses a price under the minimum", parity: true do
    create_product({ name: "Notebook", price: 50 })

    expect(message).to start_with("Sorry, a product must be at least")
  end

  it "refuses a price above the maximum of an unverified seller", parity: true do
    seller.update_columns(verified: false)

    create_product({ name: "Notebook", price: 600_000 })

    expect(message).to eq("Sorry, we don't support pricing products above $5,000.")
  end

  it "refuses an adult keyword in the name", parity: true do
    create_product({ name: "Nude drawing", price: 500 })

    expect(message).to eq("Adult keywords are not allowed")
  end

  it "refuses a name over 255 characters", parity: true do
    create_product({ name: "n" * 256, price: 500 })

    expect(message).to eq("Name is too long (maximum is 255 characters)")
  end

  it "hands a creation beside a discount code back to Rails", parity: true do
    create(:universal_offer_code, user: seller)

    create_product({ name: "Notebook", price: 500 })

    expect(response.parsed_body).to include("success" => true)
  end

  it "creates a draft beside a discount code", parity: true do
    create(:universal_offer_code, user: seller)

    create_product({ name: "Notebook", price: 500, draft: true })

    expect(response.parsed_body).to include("success" => true)
  end

  it "hands a seller without a payment address back to Rails", parity: true do
    seller.update_columns(payment_address: "")

    create_product({ name: "Notebook", price: 500 })

    expect(response.parsed_body).to include("success" => true)
  end

  it "hands a free product back to Rails", parity: true do
    create_product({ name: "Notebook", price: 0 })

    expect(response.parsed_body).to include("success" => true)
    expect(created.customizable_price).to be true
  end

  it "hands a price with cents back to Rails", parity: true do
    create_product({ name: "Notebook", price: "5.50" })

    expect(response).to have_http_status(:ok)
  end

  it "hands a price that is null back to Rails", parity: true do
    create_product({ name: "Notebook", price: nil })

    expect(response).to have_http_status(:ok)
  end

  it "hands a custom permalink back to Rails", parity: true do
    create_product({ name: "Notebook", price: 500, custom_permalink: "notebook" })

    expect(created.custom_permalink).to eq("notebook")
  end

  it "hands a purchase limit back to Rails", parity: true do
    create_product({ name: "Notebook", price: 500, max_purchase_count: 5 })

    expect(created.max_purchase_count).to eq(5)
  end

  it "hands a pay-what-you-want price back to Rails", parity: true do
    create_product({ name: "Notebook", price: 500, customizable_price: true, suggested_price_cents: 800 })

    expect(created.customizable_price).to be true
  end

  it "hands a refund policy back to Rails", parity: true do
    seller.update!(refund_policy_enabled: false)

    create_product({ name: "Notebook", price: 500, refund_period: "30" })

    expect(response).to have_http_status(:ok)
  end

  it "hands a membership back to Rails", parity: true do
    create_product({ name: "Club", price: 500, native_type: "membership", subscription_duration: "monthly" })

    expect(response.parsed_body).to include("success" => true)
  end

  it "hands a course back to Rails", parity: true do
    create_product({ name: "Course", price: 500, native_type: "course" })

    expect(response.parsed_body).to include("success" => true)
  end

  it "hands a product priced in another currency back to Rails", parity: true do
    create_product({ name: "Notebook", price: 500, price_currency_type: "eur" })

    expect(response).to have_http_status(:ok)
  end

  it "hands a rich content page back to Rails", parity: true do
    create_product({ name: "Notebook", price: 500, rich_content: [{ title: "One", description: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }] }] })

    expect(response).to have_http_status(:ok)
  end

  it "hands a tag that is not plain lowercase back to Rails", parity: true do
    create_product({ name: "Notebook", price: 500, tags: ["Paper"] })

    expect(response.parsed_body).to include("success" => true)
  end

  it "hands a description Nokogiri would rewrite back to Rails", parity: true do
    create_product({ name: "Notebook", price: 500, description: "<ul><li>One</li></ul><p>a &nbsp; b" })

    expect(response.parsed_body).to include("success" => true)
  end

  it "hands a description with an upsell card back to Rails", parity: true do
    create_product({ name: "Notebook", price: 500, description: '<upsell-card productid="missing"></upsell-card>' })

    expect(response).to have_http_status(:ok)
  end

  it "hands a creation from the command line tool back to Rails", parity: true do
    create_product({ name: "Notebook", price: 500 }, headers: { "User-Agent" => "gumroad-cli/1.2.3" })

    expect(created.created_via_cli).to be true
  end

  it "creates a product when the upload fields are blank", parity: true do
    create_product({ name: "Book", price: 100, file: "", preview: {}, thumbnail: [] })

    expect(response.parsed_body["success"]).to be true
  end
end
