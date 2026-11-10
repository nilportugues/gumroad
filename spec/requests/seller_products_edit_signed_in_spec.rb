# frozen_string_literal: true

require "spec_helper"

# Signed-in visits to the product editor (Products/Edit, LinksController#edit), recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/seller-products.replay.test.ts. The port renders plain
# digital, course and ebook products.
describe "Product editor when signed in", type: :request do
  include Parity::SignedInDashboard

  let(:seller) { create(:user, name: "Edit Seller") }
  let(:product) { create(:product, user: seller, name: "Plain product", price_cents: 500, unique_permalink: "plain") }

  # The first visit inserts the seller's holdout row; the port only reads it.
  before { Marketing::HoldoutAssignment.for_seller!(seller) }

  it "renders the editor for a plain digital product", parity: true do
    log_in(seller)

    get edit_link_path(product.unique_permalink)

    expect(response).to be_successful
    expect(inertia_props_of(response)["product"]).to include("name" => "Plain product", "native_type" => "digital")
  end

  it "renders the content tab", parity: true do
    log_in(seller)

    get "/products/#{product.unique_permalink}/edit/content"

    expect(response).to be_successful
  end

  it "renders the share tab and the receipt tab", parity: true do
    log_in(seller)

    get "/products/#{product.unique_permalink}/edit/share"
    expect(response).to be_successful

    get "/products/#{product.unique_permalink}/edit/receipt"
    expect(response).to be_successful
  end

  it "serves the Inertia JSON for a visit", parity: true do
    log_in(seller)

    inertia_visit edit_link_path(product.unique_permalink)

    expect(response).to be_successful
    expect(JSON.parse(response.body)["component"]).to eq("Products/Edit")
  end

  it "shows a draft product with its custom settings", parity: true do
    product.update!(draft: true, custom_permalink: "plain", customizable_price: true, suggested_price_cents: 900, is_adult: true, quantity_enabled: true, should_show_sales_count: true, hide_sold_out_variants: true, display_product_reviews: false, discover_fee_per_thousand: 300)
    product.save_custom_summary("A summary")
    product.save_custom_button_text_option("i_want_this_prompt")
    product.save_custom_attributes([{ "name" => "Pages", "value" => "12" }, { "name" => "Language", "value" => "English" }])
    product.update!(custom_view_content_button_text: "Open", custom_receipt_text: "Thanks!", custom_failed_payment_text: "Update your card")
    log_in(seller)

    get edit_link_path(product.unique_permalink)

    expect(inertia_props_of(response)["product"]).to include("custom_permalink" => "plain", "is_published" => false, "custom_summary" => "A summary")
  end

  it "reads a product-level refund policy, the profile sections and name suggestions", parity: true do
    product.update!(product_refund_policy_enabled: true)
    product.find_or_initialize_product_refund_policy.update!(max_refund_period_in_days: 14, fine_print: "No returns after download")
    other = create(:product, user: seller, name: "Other product")
    other.save_custom_attributes([{ "name" => "Format", "value" => "PDF" }, { "name" => "  Pages ", "value" => "3" }])
    create(:seller_profile_products_section, seller:, header: "Best sellers", shown_products: [product.id, other.id], add_new_products: true)
    create(:seller_profile_products_section, seller:, header: "Others", shown_products: [other.id])
    log_in(seller)

    get edit_link_path(product.unique_permalink)

    expect(inertia_props_of(response)["profile_sections"].size).to eq(2)
  end

  it "lists the Discover taxonomies and the category's attributes", parity: true do
    parent = create(:taxonomy, slug: "design")
    child = create(:taxonomy, slug: "3d", parent:)
    create(:taxonomy, slug: "other")
    create(:taxonomy_stat, taxonomy: child, recent_sales_count: 5)
    TaxonomyAttribute.create!(taxonomy: child, name: "format", label: "Format", value_type: "enum", values: %w[PDF EPUB], position: 1)
    product.update!(taxonomy: child)
    product.json_data = { "taxonomy_attribute_values" => { "format" => "PDF" } }
    product.save!
    log_in(seller)

    get edit_link_path(product.unique_permalink)

    expect(inertia_props_of(response)["taxonomies"]).not_to be_empty
  end

  it "formats the price change date in the seller's time zone", parity: true do
    seller.update_columns(timezone: "Tokyo")
    log_in(seller)

    get edit_link_path(product.unique_permalink)

    expect(inertia_props_of(response)["earliest_membership_price_change_date"]).to end_with("+09:00")
  end

  it "sends a bundle to the bundle editor", parity: true do
    bundle = create(:product, :bundle, user: seller)
    log_in(seller)

    get edit_link_path(bundle.unique_permalink)

    expect(response).to redirect_to(edit_bundle_product_path(bundle.external_id))
  end

  it "answers 404 for an unknown product", parity: true do
    log_in(seller)

    get edit_link_path("nope")

    expect(response).to have_http_status(:not_found)
  end

  it "sends a seller who may not edit a product to its product page", parity: true do
    other_product = create(:product, user: create(:user), name: "Not yours")
    log_in(seller)

    get edit_link_path(other_product.unique_permalink)

    expect(response).to redirect_to(short_link_url(other_product))
  end

  %w[admin marketing].each do |role|
    it "lets a #{role} team member edit the product", parity: true do
      member = create(:user, name: "Team #{role}")
      membership = create(:team_membership, user: member, seller:, role:)
      log_in(member)
      switch_to(membership)

      get edit_link_path(product.unique_permalink)

      expect(response).to be_successful
    end
  end

  %w[support accountant].each do |role|
    it "sends a #{role} team member to the product page", parity: true do
      member = create(:user, name: "Team #{role}")
      membership = create(:team_membership, user: member, seller:, role:)
      log_in(member)
      switch_to(membership)

      get edit_link_path(product.unique_permalink)

      expect(response).to redirect_to(short_link_url(product))
    end
  end

  it "lists the product's tags and the seller's other refund policies", parity: true do
    product.tag!("illustration")
    product.tag!("ebooks")
    visible = create(:product, user: seller, name: "Visible product")
    visible.find_or_initialize_product_refund_policy.update!(max_refund_period_in_days: 14, fine_print: "Within two weeks")
    archived = create(:product, user: seller, name: "Archived product", archived: true)
    archived.find_or_initialize_product_refund_policy.update!(max_refund_period_in_days: 7)
    log_in(seller)

    get edit_link_path(product.unique_permalink)

    props = inertia_props_of(response)
    expect(props["product"]["tags"]).to eq(%w[illustration ebooks])
    expect(props["refund_policies"].map { _1["product_name"] }).to eq(["Visible product"])
  end

  it "lists the versions of a product with their prices, limits and pages", parity: true do
    category = create(:variant_category, link: product, title: "Edition")
    create(:variant, variant_category: category, name: "Standard", price_difference_cents: 0)
    deluxe = create(:variant, variant_category: category, name: "Deluxe", description: "With extras", price_difference_cents: 500, max_purchase_count: 10)
    create(:rich_content, entity: deluxe, title: "Welcome", description: [{ "type" => "paragraph", "content" => [{ "type" => "text", "text" => "Hello" }] }])
    create(:variant_category, link: product, title: "Gone").mark_deleted!
    log_in(seller)

    get edit_link_path(product.unique_permalink)

    variants = inertia_props_of(response)["product"]["variants"]
    expect(variants.map { _1["name"] }).to eq(%w[Standard Deluxe])
    expect(variants.last).to include("price_difference_cents" => 500, "max_purchase_count" => 10, "sales_count_for_inventory" => 0)
    expect(variants.last["rich_content"].map { _1["title"] }).to eq(["Welcome"])
  end

  it "hides the versions' own pages while the product shares one set of content", parity: true do
    category = create(:variant_category, link: product, title: "Edition")
    version = create(:variant, variant_category: category, name: "Standard")
    product.update!(has_same_rich_content_for_all_variants: true)
    log_in(seller)

    get edit_link_path(product.unique_permalink)

    props = inertia_props_of(response)["product"]
    expect(props["has_same_rich_content_for_all_variants"]).to eq(true)
    expect(props["variants"].map { _1["id"] }).to eq([version.external_id])
    expect(props["variants"].first["rich_content"]).to eq([])
  end

  it "serves the editor for a product with SKUs enabled, which the editor does not read", parity: true do
    category = create(:variant_category, link: product, title: "Edition")
    version = create(:variant, variant_category: category, name: "Standard")
    product.update!(skus_enabled: true)
    create(:sku, link: product, name: "Standard - Large")
    log_in(seller)

    get edit_link_path(product.unique_permalink)

    expect(response).to be_successful
    expect(inertia_props_of(response)["product"]["variants"].map { _1["id"] }).to eq([version.external_id])
  end

  it "serves the versions' own pages when the shared content is blank and a version holds the real pages", parity: true do
    category = create(:variant_category, link: product, title: "Edition")
    version = create(:variant, variant_category: category, name: "Standard")
    create(:rich_content, entity: version, title: "Welcome", description: [{ "type" => "paragraph", "content" => [{ "type" => "text", "text" => "Hello" }] }])
    product.update!(has_same_rich_content_for_all_variants: true)
    log_in(seller)

    get edit_link_path(product.unique_permalink)

    props = inertia_props_of(response)["product"]
    expect(props["has_same_rich_content_for_all_variants"]).to eq(false)
    expect(props["variants"].first["rich_content"].map { _1["title"] }).to eq(["Welcome"])
    expect(props["rich_content"]).to eq([])
  end

  it "keeps hiding the versions' pages when they are blank", parity: true do
    category = create(:variant_category, link: product, title: "Edition")
    version = create(:variant, variant_category: category, name: "Standard")
    create(:rich_content, entity: version, title: nil, description: [{ "type" => "paragraph" }])
    product.update!(has_same_rich_content_for_all_variants: true)
    log_in(seller)

    get edit_link_path(product.unique_permalink)

    props = inertia_props_of(response)["product"]
    expect(props["has_same_rich_content_for_all_variants"]).to eq(true)
    expect(props["variants"].first["rich_content"]).to eq([])
  end

  it "reads the sales count, the ratings and the inventory of a product with a purchase limit", parity: true do
    product.update!(max_purchase_count: 10)
    purchase = build(:purchase, link: product, seller:, purchase_state: "successful").tap { |row| row.save!(validate: false) }
    create(:product_review, purchase:, link: product, rating: 4, message: "Solid")
    log_in(seller)

    get edit_link_path(product.unique_permalink)

    props = inertia_props_of(response)
    expect(props["product"]["max_purchase_count"]).to eq(10)
    expect(props).to include("successful_sales_count" => 1, "sales_count_for_inventory" => 1)
    expect(props["ratings"]).to include("count" => 1)
  end

  it "reads a purchase limit of zero as no limit", parity: true do
    product.update!(max_purchase_count: 0)
    build(:purchase, link: product, seller:, purchase_state: "successful").save!(validate: false)
    log_in(seller)

    get edit_link_path(product.unique_permalink)

    expect(inertia_props_of(response)).to include("sales_count_for_inventory" => 0)
  end

  it "sends a signed-out visitor to the login page", parity: true do
    get edit_link_path(product.unique_permalink)

    expect(response).to redirect_to(login_path(next: "/products/#{product.unique_permalink}/edit"))
  end
end
