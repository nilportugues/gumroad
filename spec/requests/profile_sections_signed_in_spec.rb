# frozen_string_literal: true

require "spec_helper"

# Adding, editing and removing profile sections the way the profile editor does (JSON body, CSRF token in a header), recorded
# for the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/ws11b.replay.test.ts, which sends the
# last request of each example.
describe "Profile sections when signed in", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Sectioned Seller") }
  let(:json_headers) { { "Accept" => "application/json", "Content-Type" => "application/json" } }

  before { host! DOMAIN }

  def send_json(method, path, body = nil)
    token = csrf_token
    public_send(method, path, params: body&.to_json, headers: json_headers.merge("X-CSRF-Token" => token))
  end

  def as_team_member(role)
    member = create(:user, name: "#{role.to_s.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  describe "adding" do
    it "adds a products section", parity: true do
      products = create_list(:product, 2, user: seller)
      log_in(seller)

      send_json(:post, profile_sections_path, type: "SellerProfileProductsSection", header: "Hello", hide_header: false, show_filters: false,
                                              shown_products: products.map(&:external_id), default_product_sort: "page_layout", add_new_products: true)

      section = SellerProfileSection.find_by_external_id(response.parsed_body["id"])
      expect(response).to have_http_status(:ok)
      expect(section.seller).to eq(seller)
      expect(section).to have_attributes(header: "Hello", hide_header: false, shown_products: products.map(&:id))
    end

    it "adds a products section the way the editor sends it", parity: true do
      product = create(:product, user: seller)
      log_in(seller)

      send_json(:post, profile_sections_path, type: "SellerProfileProductsSection", header: "", hide_header: true, shown_products: [product.external_id],
                                              default_product_sort: "newest", show_filters: true, add_new_products: false,
                                              search_results: { products: [], total: 0, filetypes_data: [], tags_data: [], taxonomy_attributes_data: [] })

      expect(response).to have_http_status(:ok)
      expect(SellerProfileSection.find_by_external_id(response.parsed_body["id"])).to have_attributes(header: "", hide_header: true, default_product_sort: "newest", show_filters: true, add_new_products: false)
    end

    it "adds a posts section", parity: true do
      posts = create_list(:published_installment, 2, installment_type: Installment::AUDIENCE_TYPE, seller:, shown_on_profile: true)
      log_in(seller)

      send_json(:post, profile_sections_path, type: "SellerProfilePostsSection", header: "Posts", shown_posts: posts.map(&:external_id))

      expect(response).to have_http_status(:ok)
      expect(seller.seller_profile_posts_sections.sole).to have_attributes(header: "Posts", hide_header: false, shown_posts: posts.map(&:id))
    end

    it "adds a posts section with no posts", parity: true do
      log_in(seller)

      send_json(:post, profile_sections_path, type: "SellerProfilePostsSection", header: "Nothing yet", shown_posts: [])

      expect(response).to have_http_status(:ok)
      expect(seller.seller_profile_posts_sections.sole.shown_posts).to eq([])
    end

    it "adds a featured product section", parity: true do
      product = create(:product, user: seller, name: "Special product")
      log_in(seller)

      send_json(:post, profile_sections_path, type: "SellerProfileFeaturedProductSection", header: "My amazing product", hide_header: false, featured_product_id: product.external_id)

      expect(response).to have_http_status(:ok)
      expect(seller.seller_profile_featured_product_sections.sole).to have_attributes(header: "My amazing product", featured_product_id: product.id, product_id: nil)
    end

    it "adds a featured product section with nothing featured yet", parity: true do
      log_in(seller)

      send_json(:post, profile_sections_path, type: "SellerProfileFeaturedProductSection", header: "Soon")

      expect(response).to have_http_status(:ok)
      expect(seller.seller_profile_featured_product_sections.sole.featured_product_id).to be_nil
    end

    it "adds a section that belongs to a product", parity: true do
      product = create(:product, user: seller)
      log_in(seller)

      send_json(:post, profile_sections_path, type: "SellerProfileFeaturedProductSection", product_id: product.external_id)

      expect(response).to have_http_status(:ok)
      expect(seller.seller_profile_sections.sole.product_id).to eq(product.id)
    end

    it "adds a subscribe section", parity: true do
      log_in(seller)

      send_json(:post, profile_sections_path, type: "SellerProfileSubscribeSection", header: "Subscribe to me!", hide_header: false, button_label: "Subscribe")

      expect(response).to have_http_status(:ok)
      expect(seller.seller_profile_subscribe_sections.sole).to have_attributes(header: "Subscribe to me!", button_label: "Subscribe")
    end

    it "adds a wishlists section", parity: true do
      wishlist = create(:wishlist, user: seller)
      log_in(seller)

      send_json(:post, profile_sections_path, type: "SellerProfileWishlistsSection", header: "Hello", hide_header: false, shown_wishlists: [wishlist.external_id])

      expect(response).to have_http_status(:ok)
      expect(seller.seller_profile_wishlists_sections.sole.shown_wishlists).to eq([wishlist.id])
    end

    it "adds a section for a marketing team member", parity: true do
      as_team_member(TeamMembership::ROLE_MARKETING)

      send_json(:post, profile_sections_path, type: "SellerProfileSubscribeSection", header: "Join", button_label: "Join")

      expect(response).to have_http_status(:ok)
      expect(seller.seller_profile_subscribe_sections.count).to eq(1)
    end

    it "does not let a support team member add a section", parity: true do
      as_team_member(TeamMembership::ROLE_SUPPORT)

      send_json(:post, profile_sections_path, type: "SellerProfileSubscribeSection", header: "Join", button_label: "Join")

      expect(response).to have_http_status(:unauthorized)
      expect(seller.seller_profile_sections.count).to eq(0)
    end

    it "hands a rich text section", parity: true do
      log_in(seller)

      send_json(:post, profile_sections_path, type: "SellerProfileRichTextSection", header: "About", text: {})

      expect(response).to have_http_status(:ok)
      expect(seller.seller_profile_rich_text_sections.count).to eq(1)
    end

    it "answers 422 for a section of an unknown type", parity: true do
      log_in(seller)

      send_json(:post, profile_sections_path, type: "SellerProfileFakeSection", header: "Hello")

      expect(response).to have_http_status(:unprocessable_content)
      expect(response.parsed_body).to eq("error" => "Invalid section type")
    end

    it "answers 422 with the schema messages for a products section whose show_filters is not a boolean", parity: true do
      log_in(seller)

      send_json(:post, profile_sections_path, type: "SellerProfileProductsSection", show_filters: "i hack u :)")

      expect(response).to have_http_status(:unprocessable_content)
      expect(response.parsed_body["error"]).to include("The property '#/show_filters' of type string did not match the following type: boolean")
    end
  end

  describe "editing" do
    let(:section) { create(:seller_profile_products_section, seller:, header: "A!", shown_products: [1], hide_header: true) }

    it "updates a products section", parity: true do
      products = create_list(:product, 2, user: seller)
      log_in(seller)

      send_json(:patch, profile_section_path(section.external_id), header: "B!", shown_products: products.map(&:external_id))

      expect(response).to have_http_status(:no_content)
      expect(section.reload).to have_attributes(header: "B!", shown_products: products.map(&:id), hide_header: false)
    end

    it "updates a section with the whole section the editor holds", parity: true do
      log_in(seller)

      send_json(:patch, profile_section_path(section.external_id), id: section.external_id, type: "SellerProfileProductsSection", header: "Whole", hide_header: false,
                                                                    shown_products: [], default_product_sort: "price_asc", show_filters: true, add_new_products: false,
                                                                    search_results: { products: [], total: 0 })

      expect(response).to have_http_status(:no_content)
      expect(section.reload).to have_attributes(header: "Whole", shown_products: [], default_product_sort: "price_asc", show_filters: true, add_new_products: false)
    end

    it "hides the header of a section saved with a blank one", parity: true do
      visible = create(:seller_profile_products_section, seller:, header: "Shown", hide_header: false)
      log_in(seller)

      send_json(:patch, profile_section_path(visible.external_id), header: "")

      expect(response).to have_http_status(:no_content)
      expect(visible.reload).to have_attributes(header: "", hide_header: true)
    end

    it "shows the header of a section saved with one", parity: true do
      log_in(seller)

      send_json(:patch, profile_section_path(section.external_id), header: "A!")

      expect(response).to have_http_status(:no_content)
      expect(section.reload.hide_header).to be(false)
    end

    it "writes nothing when nothing changes", parity: true do
      shown = create(:seller_profile_products_section, seller:, header: "Same", hide_header: false)
      log_in(seller)

      send_json(:patch, profile_section_path(shown.external_id), header: "Same", shown_products: [], show_filters: false)

      expect(response).to have_http_status(:no_content)
    end

    it "does not change the posts a posts section shows", parity: true do
      post1 = create(:published_installment, installment_type: Installment::AUDIENCE_TYPE, seller:, shown_on_profile: true)
      post2 = create(:published_installment, installment_type: Installment::AUDIENCE_TYPE, seller:, shown_on_profile: true)
      posts_section = create(:seller_profile_posts_section, seller:, shown_posts: [post1.id])
      log_in(seller)

      send_json(:patch, profile_section_path(posts_section.external_id), header: "B!", shown_posts: [post1.external_id, post2.external_id])

      expect(response).to have_http_status(:no_content)
      expect(posts_section.reload).to have_attributes(header: "B!", shown_posts: [post1.id])
    end

    it "does not change the type or the product of a section", parity: true do
      other_product = create(:product, user: seller)
      section
      log_in(seller)

      send_json(:patch, profile_section_path(section.external_id), type: "SellerProfileFakeSection", product_id: other_product.external_id, header: "Same type")

      expect(response).to have_http_status(:no_content)
      expect(section.reload).to have_attributes(type: "SellerProfileProductsSection", product_id: nil, header: "Same type")
    end

    it "updates the header of a rich text section", parity: true do
      rich = create(:seller_profile_rich_text_section, seller:, header: "Old", text: { "type" => "doc", "content" => [] })
      log_in(seller)

      send_json(:patch, profile_section_path(rich.external_id), header: "New")

      expect(response).to have_http_status(:no_content)
      expect(rich.reload.header).to eq("New")
    end

    it "updates a subscribe section as a marketing team member", parity: true do
      subscribe = create(:seller_profile_subscribe_section, seller:, header: "Join", button_label: "Join")
      as_team_member(TeamMembership::ROLE_MARKETING)

      send_json(:patch, profile_section_path(subscribe.external_id), header: "Join us", button_label: "Join us")

      expect(response).to have_http_status(:no_content)
      expect(subscribe.reload).to have_attributes(header: "Join us", button_label: "Join us")
    end

    it "does not let a support team member edit a section", parity: true do
      as_team_member(TeamMembership::ROLE_SUPPORT)

      send_json(:patch, profile_section_path(section.external_id), header: "Nope")

      expect(response).to have_http_status(:unauthorized)
      expect(section.reload.header).to eq("A!")
    end

    it "answers 404 for a section that does not exist", parity: true do
      log_in(seller)

      send_json(:patch, profile_section_path("no"), header: "B!")

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for the section of another seller", parity: true do
      stranger = create(:seller_profile_products_section, seller: create(:user), header: "Theirs")
      log_in(seller)

      send_json(:patch, profile_section_path(stranger.external_id), header: "Mine")

      expect(response).to have_http_status(:not_found)
      expect(stranger.reload.header).to eq("Theirs")
    end

    it "answers 422 with the schema message for an update whose show_filters is not a boolean", parity: true do
      log_in(seller)

      send_json(:patch, profile_section_path(section.external_id), show_filters: "i hack u :)")

      expect(response).to have_http_status(:unprocessable_content)
      expect(response.parsed_body).to eq("error" => "The property '#/show_filters' of type string did not match the following type: boolean")
    end

    it "hands a rich text section update with new text", parity: true do
      rich = create(:seller_profile_rich_text_section, seller:, header: "Old", text: { "type" => "doc", "content" => [] })
      log_in(seller)

      send_json(:patch, profile_section_path(rich.external_id), text: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] })

      expect(response).to have_http_status(:no_content)
      expect(rich.reload.text["content"].size).to eq(1)
    end
  end

  describe "removing" do
    it "removes a section", parity: true do
      create(:seller_profile_products_section, seller:)
      section = create(:seller_profile_products_section, seller:)
      log_in(seller)

      send_json(:delete, profile_section_path(section.external_id))

      expect(response).to have_http_status(:no_content)
      expect(seller.seller_profile_sections.count).to eq(1)
    end

    it "removes a section as a marketing team member", parity: true do
      section = create(:seller_profile_posts_section, seller:)
      as_team_member(TeamMembership::ROLE_MARKETING)

      send_json(:delete, profile_section_path(section.external_id))

      expect(response).to have_http_status(:no_content)
      expect(seller.seller_profile_sections.count).to eq(0)
    end

    it "does not let a support team member remove a section", parity: true do
      section = create(:seller_profile_products_section, seller:)
      as_team_member(TeamMembership::ROLE_SUPPORT)

      send_json(:delete, profile_section_path(section.external_id))

      expect(response).to have_http_status(:unauthorized)
      expect(seller.seller_profile_sections.count).to eq(1)
    end

    it "answers 404 for a section that does not exist", parity: true do
      log_in(seller)

      send_json(:delete, profile_section_path("no"))

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for the section of another seller", parity: true do
      stranger = create(:seller_profile_products_section, seller: create(:user))
      log_in(seller)

      send_json(:delete, profile_section_path(stranger.external_id))

      expect(response).to have_http_status(:not_found)
      expect(SellerProfileSection.exists?(stranger.id)).to be(true)
    end
  end
end
