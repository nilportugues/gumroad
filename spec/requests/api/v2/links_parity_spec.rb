# frozen_string_literal: true

require "spec_helper"

# Api::V2::LinksController#index, #show, #disable, #destroy and #update_sections through the full Rack stack, recorded for the Next.js port
# (PARITY_RECORD=1). #create, #update, #enable, #comps and the custom HTML writes publish, upload, search or sanitize, so they stay in Rails.
describe "API v2 products", type: :request do
  let(:seller) { create(:user, username: "dude", name: "Dude", email: "dude@example.com") }
  let(:application) { create(:oauth_application, owner: create(:user)) }
  let(:product) { create(:product, user: seller, name: "Pencil", description: "Writes", unique_permalink: "pencil", created_at: 2.days.ago) }

  before { host! API_DOMAIN }

  def auth(scopes = "edit_products") = { "Authorization" => "Bearer #{create("doorkeeper/access_token", application:, resource_owner_id: seller.id, scopes:).token}" }

  def json_headers(scopes = "edit_products") = auth(scopes).merge("Content-Type" => "application/json")

  def section(type = :seller_profile_rich_text_section, **attributes)
    create(type, seller:, product:, header: "Section #{SellerProfileSection.count + 1}", **attributes)
  end

  describe "GET /v2/products/:id" do
    it "shows a product with a tag, a version and a custom field", parity: true do
      product.tag!("stationery")
      category = create(:variant_category, link: product, title: "Size")
      create(:variant, variant_category: category, name: "Small", price_difference_cents: 0)
      create(:variant, variant_category: category, name: "Large", price_difference_cents: 250)
      field = create(:custom_field, seller:, name: "Engraving", required: true, global: true)
      product.custom_fields << create(:custom_field, seller:, name: "Colour")
      expect(field).to be_present
      get "/v2/products/#{product.external_id}", headers: auth
    end

    it "shows a product by its unique permalink", parity: true do
      get "/v2/products/#{product.unique_permalink}", headers: auth("view_public")
    end

    it "shows the rich content of a product and of its versions", parity: true do
      create(:rich_content, entity: product, title: "Page one", description: [{ "type" => "paragraph", "content" => [{ "type" => "text", "text" => "Hello" }] }])
      category = create(:variant_category, link: product, title: "Edition")
      variant = create(:variant, variant_category: category, name: "Deluxe")
      create(:rich_content, entity: variant, title: "Extras", description: [{ "type" => "paragraph", "content" => [{ "type" => "text", "text" => "More" }] }])
      get "/v2/products/#{product.external_id}", headers: auth
    end

    it "shows the custom landing page of a product", parity: true do
      product.update!(custom_html: "<div data-gumroad-action=\"buy\">Buy</div>")
      get "/v2/products/#{product.external_id}", headers: auth
    end

    it "shows the profile sections of a product in the order the product keeps them", parity: true do
      other = create(:product, user: seller, name: "Eraser")
      rich_text = section(:seller_profile_rich_text_section)
      products = section(:seller_profile_products_section, shown_products: [other.id, product.id], default_product_sort: "newest", show_filters: true)
      featured = section(:seller_profile_featured_product_section, featured_product_id: other.id)
      product.update!(sections: [products.id, rich_text.id, featured.id], main_section_index: 1)
      get "/v2/products/#{product.external_id}", headers: auth
    end

    it "shows a deleted product as deleted", parity: true do
      product.update_columns(deleted_at: 1.day.ago)
      get "/v2/products/#{product.external_id}", headers: auth
    end

    it "shows an unpublished product as not published", parity: true do
      product.update_columns(purchase_disabled_at: 1.day.ago)
      get "/v2/products/#{product.external_id}", headers: auth
    end

    it "shows a pay-what-you-want product with a single-use permalink", parity: true do
      product.update_columns(customizable_price: true, custom_permalink: "custom-pencil", max_purchase_count: 5, require_shipping: true)
      get "/v2/products/#{product.external_id}", headers: auth
    end

    it "serves /api/v2 on the main domain", parity: true do
      host! DOMAIN
      get "/api/v2/products/#{product.external_id}", params: { access_token: create("doorkeeper/access_token", application:, resource_owner_id: seller.id, scopes: "edit_products").token }
    end

    it "answers that another seller's product was not found", parity: true do
      get "/v2/products/#{create(:product).external_id}", headers: auth
    end

    it "answers that an unknown product was not found", parity: true do
      get "/v2/products/nothing", headers: auth
    end

    it "answers 401 without a token", parity: true do
      get "/v2/products/#{product.external_id}"
    end

    it "hands back a product with a taxonomy category to Rails", parity: true do
      product.update!(taxonomy: create(:taxonomy))
      get "/v2/products/#{product.external_id}", headers: auth
    end

    it "hands back a product with files to Rails", parity: true do
      create(:product_file, link: product)
      get "/v2/products/#{product.external_id}", headers: auth
    end

    it "hands back a token that can see sales to Rails", parity: true do
      get "/v2/products/#{product.external_id}", headers: auth("view_sales")
    end

    it "hands back a tiered membership to Rails", parity: true do
      get "/v2/products/#{create(:membership_product, user: seller).external_id}", headers: auth
    end

    it "hands back the comps collection to Rails", parity: true do
      get "/v2/products/comps", headers: auth
    end
  end

  describe "GET /v2/products" do
    it "lists the products newest first without the deleted ones", parity: true do
      product
      newer = create(:product, user: seller, name: "Eraser", created_at: 1.day.ago)
      create(:variant, variant_category: create(:variant_category, link: newer, title: "Size"), name: "Small")
      create(:product, user: seller, name: "Gone", created_at: 3.days.ago).update_columns(deleted_at: 1.day.ago)
      create(:product, name: "Someone else's")
      get "/v2/products", headers: auth
    end

    it "lists no products for a seller without any", parity: true do
      get "/v2/products", headers: auth("view_public")
    end

    it "pages through the products ten at a time", parity: true do
      12.times { |i| create(:product, user: seller, name: "Product #{i}", created_at: (i + 1).hours.ago) }
      get "/v2/products", headers: auth
    end

    it "serves the page after a page key", parity: true do
      products = Array.new(12) { |i| create(:product, user: seller, name: "Product #{i}", created_at: (i + 1).hours.ago) }
      last = products[9]
      key = "#{last.created_at.to_fs(:usec)}-#{ObfuscateIds.encrypt_numeric(last.id)}"
      get "/v2/products", params: { page_key: key }, headers: auth
    end

    it "refuses an invalid page key", parity: true do
      get "/v2/products", params: { page_key: "garbage" }, headers: auth
    end

    it "hands back a token that can see sales to Rails", parity: true do
      product
      get "/v2/products", headers: auth("account")
    end

    it "hands back a page with a product that has a cover to Rails", parity: true do
      create(:asset_preview_youtube, link: product)
      get "/v2/products", headers: auth
    end
  end

  describe "PUT /v2/products/:id/disable" do
    it "unpublishes a published product", parity: true do
      put "/v2/products/#{product.external_id}/disable", headers: auth
    end

    it "keeps the time a product was already unpublished", parity: true do
      product.update_columns(purchase_disabled_at: 3.days.ago)
      put "/v2/products/#{product.external_id}/disable", headers: auth
    end

    it "answers that another seller's product was not found", parity: true do
      put "/v2/products/#{create(:product).external_id}/disable", headers: auth
    end

    it "refuses a token without the edit_products scope", parity: true do
      put "/v2/products/#{product.external_id}/disable", headers: auth("view_public")
    end

    it "hands back the product with files to Rails", parity: true do
      create(:product_file, link: product)
      put "/v2/products/#{product.external_id}/disable", headers: auth
    end
  end

  describe "DELETE /v2/products/:id" do
    it "deletes a product and takes it off the profile sections", parity: true do
      other = create(:product, user: seller, name: "Eraser")
      section(:seller_profile_featured_product_section, featured_product_id: product.id)
      expect(other).to be_present
      delete "/v2/products/#{product.external_id}", headers: auth
    end

    it "deletes a product with a rich content page", parity: true do
      create(:rich_content, entity: product, description: [])
      delete "/v2/products/#{product.external_id}", headers: auth
    end

    it "answers that another seller's product was not found", parity: true do
      delete "/v2/products/#{create(:product).external_id}", headers: auth
    end

    it "refuses a token without the edit_products scope", parity: true do
      delete "/v2/products/#{product.external_id}", headers: auth("view_public")
    end

    it "hands back a product that was already deleted to Rails", parity: true do
      product.update_columns(deleted_at: 1.day.ago)
      delete "/v2/products/#{product.external_id}", headers: auth
    end
  end

  describe "PUT /v2/products/:id/sections" do
    let!(:first) { section(:seller_profile_rich_text_section) }
    let!(:second) { section(:seller_profile_rich_text_section) }
    let!(:third) { section(:seller_profile_rich_text_section) }

    before { product.update!(sections: [first.id, second.id, third.id]) }

    it "reorders the sections and destroys the ones left out", parity: true do
      put "/v2/products/#{product.external_id}/sections", params: { sections: [third.external_id, first.external_id] }.to_json, headers: json_headers
    end

    it "moves the main section index, capped at the number of sections", parity: true do
      put "/v2/products/#{product.external_id}/sections", params: { sections: [second.external_id, first.external_id, third.external_id], main_section_index: 9 }.to_json, headers: json_headers
    end

    it "reads form parameters", parity: true do
      put "/v2/products/#{product.external_id}/sections", params: { sections: [second.external_id], main_section_index: "1" }, headers: auth
    end

    it "keeps every section when the known ids match", parity: true do
      put "/v2/products/#{product.external_id}/sections", params: { sections: [first.external_id, second.external_id, third.external_id], known_section_ids: [first.external_id, second.external_id, third.external_id] }.to_json, headers: json_headers
    end

    it "clears the sections with an empty list", parity: true do
      put "/v2/products/#{product.external_id}/sections", params: { sections: [] }.to_json, headers: json_headers
    end

    it "refuses to drop a section the caller never saw", parity: true do
      put "/v2/products/#{product.external_id}/sections", params: { sections: [first.external_id], known_section_ids: [first.external_id, second.external_id] }.to_json, headers: json_headers
    end

    it "refuses a section of another product", parity: true do
      stranger = create(:seller_profile_rich_text_section, seller:)
      put "/v2/products/#{product.external_id}/sections", params: { sections: [stranger.external_id] }.to_json, headers: json_headers
    end

    it "refuses a list that names a section twice", parity: true do
      put "/v2/products/#{product.external_id}/sections", params: { sections: [first.external_id, first.external_id] }.to_json, headers: json_headers
    end

    it "refuses an id that does not decrypt", parity: true do
      put "/v2/products/#{product.external_id}/sections", params: { sections: ["nope"] }.to_json, headers: json_headers
    end

    it "refuses sections that are not a list of strings", parity: true do
      put "/v2/products/#{product.external_id}/sections", params: { sections: [1, 2] }.to_json, headers: json_headers
    end

    it "refuses a missing sections list", parity: true do
      put "/v2/products/#{product.external_id}/sections", params: {}.to_json, headers: json_headers
    end

    it "hands back a null inside the list to Rails", parity: true do
      put "/v2/products/#{product.external_id}/sections", params: { sections: [nil] }.to_json, headers: json_headers
    end

    it "refuses a known_section_ids that is not a list", parity: true do
      put "/v2/products/#{product.external_id}/sections", params: { sections: [first.external_id], known_section_ids: "x" }.to_json, headers: json_headers
    end

    it "refuses a negative main section index", parity: true do
      put "/v2/products/#{product.external_id}/sections", params: { sections: [first.external_id], main_section_index: -1 }.to_json, headers: json_headers
    end

    it "answers that another seller's product was not found", parity: true do
      put "/v2/products/#{create(:product).external_id}/sections", params: { sections: [] }.to_json, headers: json_headers
    end

    it "hands back a product with a tiered membership to Rails", parity: true do
      membership = create(:membership_product, user: seller)
      put "/v2/products/#{membership.external_id}/sections", params: { sections: [] }.to_json, headers: json_headers
    end
  end

  describe "the routes that stay in Rails" do
    it "hands back an enable to Rails", parity: true do
      product.update_columns(purchase_disabled_at: 1.day.ago)
      put "/v2/products/#{product.external_id}/enable", headers: auth
    end
  end
end
