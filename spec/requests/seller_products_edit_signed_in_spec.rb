# frozen_string_literal: true

require "spec_helper"

# Signed-in visits to the product editor (Products/Edit, LinksController#edit), recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/seller-products.replay.test.ts. The port renders plain
# digital, course and ebook products, the same products in their pre-order state, and products with a collaborator.
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
    recreate_model_index(Purchase)
    index_model_records(Purchase)
    log_in(seller)

    get edit_link_path(product.unique_permalink)

    props = inertia_props_of(response)
    expect(props["product"]["max_purchase_count"]).to eq(10)
    expect(props["successful_sales_count"]).to eq(1)
    expect(props["sales_count_for_inventory"]).to eq(1)
    expect(props["ratings"]).to include("count" => 1)
  end

  it "reads a purchase limit of zero as no limit", parity: true do
    product.update!(max_purchase_count: 0)
    build(:purchase, link: product, seller:, purchase_state: "successful").save!(validate: false)
    recreate_model_index(Purchase)
    index_model_records(Purchase)
    log_in(seller)

    get edit_link_path(product.unique_permalink)

    expect(inertia_props_of(response)).to include("sales_count_for_inventory" => 0)
  end

  it "reads the free trial and subscription duration settings", parity: true do
    product.free_trial_enabled = true
    product.free_trial_duration_amount = 2
    product.free_trial_duration_unit = :month
    product.subscription_duration = :yearly
    product.save!(validate: false)
    log_in(seller)

    get edit_link_path(product.unique_permalink)

    expect(inertia_props_of(response)["product"]).to include("free_trial_enabled" => true, "free_trial_duration_amount" => 2, "free_trial_duration_unit" => "month", "subscription_duration" => "yearly")
  end

  it "reads the product's live installment plan and ignores a deleted one", parity: true do
    create(:product_installment_plan, link: product, number_of_installments: 3, recurrence: "monthly", deleted_at: 1.day.ago)
    create(:product_installment_plan, link: product, number_of_installments: 4, recurrence: "monthly")
    log_in(seller)

    get edit_link_path(product.unique_permalink)

    expect(inertia_props_of(response)["product"]).to include("allow_installment_plan" => true, "installment_plan" => { "number_of_installments" => 4, "recurrence" => "monthly" })
  end

  it "serves the editor for a product in its pre-order state, which is not eligible for installment plans", parity: true do
    product.is_in_preorder_state = true
    product.save!(validate: false)
    log_in(seller)

    get edit_link_path(product.unique_permalink)

    expect(response).to be_successful
    expect(inertia_props_of(response)["product"]).to include("eligible_for_installment_plans" => false, "allow_installment_plan" => false, "installment_plan" => nil)
  end

  it "reads the live installment plan of a pre-order product that is ineligible for plans", parity: true do
    product.is_in_preorder_state = true
    product.save!(validate: false)
    build(:product_installment_plan, link: product, number_of_installments: 2, recurrence: "monthly").save!(validate: false)
    log_in(seller)

    get edit_link_path(product.unique_permalink)

    expect(inertia_props_of(response)["product"]).to include("eligible_for_installment_plans" => false, "allow_installment_plan" => true, "installment_plan" => { "number_of_installments" => 2, "recurrence" => "monthly" })
  end

  describe "collaborations" do
    let(:collab_product) { create(:product, user: seller, name: "Shared product", price_cents: 500, unique_permalink: "shared", is_collab: true) }

    it "credits the owner's collaborator as the co-creator", parity: true do
      affiliate_user = create(:affiliate_user, name: "Edit Collaborator")
      create(:collaborator, seller:, affiliate_user:, products: [collab_product])
      log_in(seller)

      get edit_link_path(collab_product.unique_permalink)

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["collaborating_user"]).to include("name" => "Edit Collaborator")
    end

    it "does not credit a collaborator who opted out of the co-creator credit on every product", parity: true do
      create(:collaborator, seller:, products: [collab_product], dont_show_as_co_creator: true)
      log_in(seller)

      get edit_link_path(collab_product.unique_permalink)

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["collaborating_user"]).to be_nil
    end

    it "does not credit a collaborator who opted out of the co-creator credit on this product", parity: true do
      collaborator = create(:collaborator, seller:, apply_to_all_products: false)
      create(:product_affiliate, product: collab_product, affiliate: collaborator, affiliate_basis_points: 30_00, dont_show_as_co_creator: true)
      log_in(seller)

      get edit_link_path(collab_product.unique_permalink)

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["collaborating_user"]).to be_nil
    end

    it "does not credit a collaborator whose invitation is still pending", parity: true do
      create(:collaborator, :with_pending_invitation, seller:, products: [collab_product])
      log_in(seller)

      get edit_link_path(collab_product.unique_permalink)

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["collaborating_user"]).to be_nil
    end

    it "lets the collaborator edit the owner's product, with the owner in the byline and their own account as the uploader", parity: true do
      affiliate_user = create(:affiliate_user, name: "Edit Collaborator")
      create(:collaborator, seller:, affiliate_user:, products: [collab_product])
      create(:product_file, link: create(:product, user: seller, name: "Other product"))
      log_in(affiliate_user)

      get edit_link_path(collab_product.unique_permalink)

      props = inertia_props_of(response)
      expect(response).to be_successful
      expect(props["seller"]["id"]).to eq(seller.external_id)
      expect(props["current_seller_external_id"]).to eq(affiliate_user.external_id)
      expect(props["existing_files"]).to eq([])
      expect(props["waitlist"]).to be_nil
      expect(props["product"]["collaborating_user"]).to include("name" => "Edit Collaborator")
    end

    it "serves the bundle editor with the bundle's collaborator", parity: true do
      bundle = create(:product, :bundle, user: seller, price_cents: 200, native_type: Link::NATIVE_TYPE_BUNDLE, is_collab: true)
      # The editor lists each bundled product's created_at; a fixed date keeps the fixture clear of the recording's slow clock.
      bundle.bundle_products.each { _1.product.update_column(:created_at, Time.utc(2026, 1, 2, 3, 4, 5)) }
      affiliate_user = create(:affiliate_user, name: "Bundle Collaborator")
      create(:collaborator, seller:, affiliate_user:, products: [bundle])
      log_in(seller)

      get edit_bundle_product_path(bundle.external_id)

      expect(response).to be_successful
      expect(inertia_props_of(response)["bundle"]["collaborating_user"]).to include("name" => "Bundle Collaborator")
    end

    it "lets the collaborator edit the owner's bundle", parity: true do
      bundle = create(:product, :bundle, user: seller, price_cents: 200, native_type: Link::NATIVE_TYPE_BUNDLE, is_collab: true)
      # The editor lists each bundled product's created_at; a fixed date keeps the fixture clear of the recording's slow clock.
      bundle.bundle_products.each { _1.product.update_column(:created_at, Time.utc(2026, 1, 2, 3, 4, 5)) }
      affiliate_user = create(:affiliate_user, name: "Bundle Collaborator")
      create(:collaborator, seller:, affiliate_user:, products: [bundle])
      log_in(affiliate_user)

      get edit_bundle_product_path(bundle.external_id)

      expect(response).to be_successful
      expect(inertia_props_of(response)["bundle"]["collaborating_user"]).to include("name" => "Bundle Collaborator")
    end
  end

  it "sends a signed-out visitor to the login page", parity: true do
    get edit_link_path(product.unique_permalink)

    expect(response).to redirect_to(login_path(next: "/products/#{product.unique_permalink}/edit"))
  end
end
