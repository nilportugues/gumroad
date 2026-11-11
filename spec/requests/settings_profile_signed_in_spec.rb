# frozen_string_literal: true

require "spec_helper"

# Saving the profile editor (PUT /profile, JSON body and the CSRF token in a header, as the editor sends it), recorded for the
# Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/settings-profile.replay.test.ts, which sends the last
# request of each example. Examples named "hands a ..." are the requests Node leaves to Rails whole.
describe "Profile settings when signed in", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Profile Seller", username: "profileseller", created_at: Time.utc(2025, 1, 1)) }
  let(:json_headers) { { "Accept" => "application/json", "Content-Type" => "application/json" } }
  let(:section_time) { Time.utc(2025, 2, 1, 12, 0, 0) }

  before { host! DOMAIN }

  def send_json(method, body)
    token = csrf_token
    public_send(method, profile_path, params: body.to_json, headers: json_headers.merge("X-CSRF-Token" => token))
  end

  def as_team_member(role)
    member = create(:user, name: "#{role.to_s.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  def products_section(**attributes)
    create(:seller_profile_products_section, seller:, header: "Products", shown_products: [], created_at: section_time, updated_at: section_time, **attributes)
  end

  def save_tabs(*tabs)
    profile = seller.seller_profile
    profile.update!(json_data: { tabs: })
    profile
  end

  def layout_version = SellerProfile.find_by!(seller_id: seller.id).layout_version

  def stored_tabs = SellerProfile.find_by!(seller_id: seller.id).json_data["tabs"]

  describe "profile fields" do
    it "saves the name, bio and switches", parity: true do
      log_in(seller)

      send_json(:put, user: { name: "New Name", bio: "About me", product_page_storefront_enabled: false, hide_follow_form: true })

      expect(response.parsed_body).to eq("success" => true)
      expect(seller.reload).to have_attributes(name: "New Name", bio: "About me", product_page_storefront_enabled: false, hide_follow_form: true)
    end

    it "accepts PATCH", parity: true do
      log_in(seller)

      send_json(:patch, user: { bio: "Patched" })

      expect(response.parsed_body).to eq("success" => true)
      expect(seller.reload.bio).to eq("Patched")
    end

    it "saves an empty user hash without changing anything", parity: true do
      log_in(seller)

      send_json(:put, user: {})

      expect(response.parsed_body).to eq("success" => true)
    end

    it "saves an empty body", parity: true do
      log_in(seller)

      send_json(:put, {})

      expect(response.parsed_body).to eq("success" => true)
    end

    it "ignores attributes the policy does not permit", parity: true do
      log_in(seller)

      send_json(:put, user: { name: "Kept", username: "stolenname", email: "stolen@example.com" })

      expect(response.parsed_body).to eq("success" => true)
      expect(seller.reload).to have_attributes(name: "Kept", username: "profileseller")
    end

    it "answers a name that is too long with the validation message", parity: true do
      log_in(seller)

      send_json(:put, user: { name: "a" * 101, bio: "Not saved" })

      expect(response.parsed_body).to eq("success" => false, "error_message" => "Name Your name is too long. Please try again with a shorter one.")
      expect(seller.reload.bio).to be_nil
    end

    it "answers a name with a colon with the validation message", parity: true do
      log_in(seller)

      send_json(:put, user: { name: "Bad: Name" })

      expect(response.parsed_body["success"]).to eq(false)
      expect(seller.reload.name).to eq("Profile Seller")
    end

    it "accepts a blank custom_html when the seller has no page", parity: true do
      log_in(seller)

      send_json(:put, user: { name: "No page", custom_html: "" })

      expect(response.parsed_body).to eq("success" => true)
      expect(seller.reload.name).to eq("No page")
    end

    it "refuses custom_html with content", parity: true do
      log_in(seller)

      send_json(:put, user: { name: "Not saved", custom_html: "<p>hi</p>" })

      expect(response.parsed_body).to eq("success" => false, "error_message" => "Custom HTML can only be edited through the Gumroad CLI or API.")
      expect(seller.reload.name).to eq("Profile Seller")
    end

    it "answers an unconfirmed seller with the confirmation message", parity: true do
      log_in(seller)
      seller.update_columns(confirmed_at: nil)

      send_json(:put, user: { name: "Not saved" })

      expect(response.parsed_body).to eq("success" => false, "error_message" => "You have to confirm your email address before you can do that.")
      expect(seller.reload.name).to eq("Profile Seller")
    end

    it "saves a profile as an admin team member", parity: true do
      as_team_member(TeamMembership::ROLE_ADMIN)

      send_json(:put, user: { bio: "By admin" })

      expect(response.parsed_body).to eq("success" => true)
      expect(seller.reload.bio).to eq("By admin")
    end

    it "saves a profile as a marketing team member", parity: true do
      as_team_member(TeamMembership::ROLE_MARKETING)

      send_json(:put, user: { bio: "By marketing" })

      expect(response.parsed_body).to eq("success" => true)
      expect(seller.reload.bio).to eq("By marketing")
    end

    it "does not let a support team member save", parity: true do
      as_team_member(TeamMembership::ROLE_SUPPORT)

      send_json(:put, user: { bio: "Not saved" })

      expect(response).to have_http_status(:unauthorized)
      expect(seller.reload.bio).to be_nil
    end

    it "does not let an accountant save", parity: true do
      as_team_member(TeamMembership::ROLE_ACCOUNTANT)

      send_json(:put, user: { bio: "Not saved" })

      expect(response).to have_http_status(:unauthorized)
    end
  end

  describe "theme" do
    it "creates the profile with the chosen theme", parity: true do
      SellerProfile.where(seller_id: seller.id).delete_all
      log_in(seller)

      send_json(:put, seller_profile: { font: "Inter", background_color: "#abc", highlight_color: "#112233", border_radius: "large", button_hover: "none" })

      expect(response.parsed_body).to eq("success" => true)
      expect(SellerProfile.find_by!(seller_id: seller.id)).to have_attributes(font: "Inter", background_color: "#aabbcc", highlight_color: "#112233", border_radius: "large", button_hover: "none")
    end

    it "updates the theme of an existing profile and the name together", parity: true do
      seller.seller_profile.update!(font: "Domine")
      log_in(seller)

      send_json(:put, user: { name: "Themed" }, seller_profile: { font: "Roboto Mono" })

      expect(response.parsed_body).to eq("success" => true)
      expect(seller.reload.name).to eq("Themed")
      expect(seller.seller_profile.font).to eq("Roboto Mono")
    end

    it "saves a theme the profile already has without writing", parity: true do
      seller.seller_profile.update!(font: "Domine")
      log_in(seller)

      send_json(:put, seller_profile: { font: "Domine" })

      expect(response.parsed_body).to eq("success" => true)
    end

    it "answers an unknown font with the validation message", parity: true do
      log_in(seller)

      send_json(:put, user: { name: "Not saved" }, seller_profile: { font: "Comic Sans" })

      expect(response.parsed_body).to eq("success" => false, "error_message" => "Font is not included in the list")
      expect(seller.reload.name).to eq("Profile Seller")
    end

    it "answers several invalid theme values as one sentence", parity: true do
      log_in(seller)

      send_json(:put, seller_profile: { background_color: "red", highlight_color: "nope", border_radius: "huge", button_hover: "spin" })

      expect(response.parsed_body["success"]).to eq(false)
      expect(response.parsed_body["error_message"]).to include("Background color is not a valid hexadecimal color")
    end

    it "ignores an empty seller_profile hash", parity: true do
      log_in(seller)

      send_json(:put, seller_profile: {})

      expect(response.parsed_body).to eq("success" => true)
    end
  end

  describe "sections and tabs" do
    it "adds a section and a tab that lists it by the id the editor gave it", parity: true do
      product = create(:product, user: seller)
      log_in(seller)

      send_json(:put, profile_version: layout_version, sections: [{ id: "client-guid-1", type: "SellerProfileProductsSection", header: "Shop", shown_products: [product.external_id], default_product_sort: "newest", show_filters: false, add_new_products: true }],
                      tabs: [{ name: "Home", sections: ["client-guid-1"] }])

      section = seller.seller_profile_sections.sole
      expect(response.parsed_body).to eq("success" => true)
      expect(section).to have_attributes(header: "Shop", shown_products: [product.id])
      expect(stored_tabs).to eq([{ "name" => "Home", "sections" => [section.id] }])
    end

    it "adds several sections in the order sent", parity: true do
      log_in(seller)

      send_json(:put, profile_version: layout_version, sections: [{ id: "a", type: "SellerProfileSubscribeSection", header: "Join", button_label: "Join" },
                                 { id: "b", type: "SellerProfilePostsSection", header: "", shown_posts: [] }],
                      tabs: [{ name: "One", sections: ["b"] }, { name: "Two", sections: ["a"] }])

      expect(response.parsed_body).to eq("success" => true)
      expect(seller.seller_profile_sections.count).to eq(2)
    end

    it "updates a section and keeps it in the tab", parity: true do
      section = products_section
      save_tabs({ name: "Home", sections: [section.id] })
      log_in(seller)

      send_json(:put, profile_version: layout_version, sections: [{ id: section.external_id, header: "Renamed" }], tabs: [{ name: "Home", sections: [section.external_id] }])

      expect(response.parsed_body).to eq("success" => true)
      expect(section.reload).to have_attributes(header: "Renamed")
    end

    it "updates a section's posts, which the editor may change", parity: true do
      post = create(:published_installment, installment_type: Installment::AUDIENCE_TYPE, seller:, shown_on_profile: true)
      posts_section = create(:seller_profile_posts_section, seller:, shown_posts: [], created_at: section_time, updated_at: section_time)
      save_tabs({ name: "Home", sections: [posts_section.id] })
      log_in(seller)

      send_json(:put, profile_version: layout_version, sections: [{ id: posts_section.external_id, shown_posts: [post.external_id] }], tabs: [{ name: "Home", sections: [posts_section.external_id] }])

      expect(response.parsed_body).to eq("success" => true)
      expect(posts_section.reload.shown_posts).to eq([post.id])
    end

    it "destroys the profile sections no tab lists any more", parity: true do
      kept = products_section(header: "Kept")
      dropped = products_section(header: "Dropped")
      save_tabs({ name: "Home", sections: [kept.id, dropped.id] })
      log_in(seller)

      send_json(:put, profile_version: layout_version, tabs: [{ name: "Home", sections: [kept.external_id] }])

      expect(response.parsed_body).to eq("success" => true)
      expect(seller.seller_profile_sections.pluck(:id)).to eq([kept.id])
    end

    it "destroys every profile section when the tabs are empty", parity: true do
      products_section
      save_tabs({ name: "Home", sections: [] })
      log_in(seller)

      send_json(:put, profile_version: layout_version, tabs: [])

      expect(response.parsed_body).to eq("success" => true)
      expect(seller.seller_profile_sections.count).to eq(0)
      expect(stored_tabs).to eq([])
    end

    it "keeps a section that a product page owns", parity: true do
      product = create(:product, user: seller)
      owned = create(:seller_profile_products_section, seller:, product:, header: "Owned", shown_products: [], created_at: section_time, updated_at: section_time)
      save_tabs({ name: "Home", sections: [] })
      log_in(seller)

      send_json(:put, profile_version: layout_version, tabs: [{ name: "Home", sections: [] }])

      expect(response.parsed_body).to eq("success" => true)
      expect(owned.reload.header).to eq("Owned")
    end

    it "drops a tab reference that does not resolve and prunes nothing", parity: true do
      section = products_section
      save_tabs({ name: "Home", sections: [section.id] })
      log_in(seller)

      send_json(:put, profile_version: layout_version, tabs: [{ name: "Home", sections: ["not-a-real-id"] }])

      expect(response.parsed_body).to eq("success" => true)
      expect(section.reload.header).to eq("Products")
      expect(stored_tabs).to eq([{ "name" => "Home", "sections" => [] }])
    end

    it "saves tabs for a seller whose profile does not exist yet without a version", parity: true do
      log_in(seller)
      SellerProfile.where(seller_id: seller.id).delete_all

      send_json(:put, tabs: [{ name: "Home", sections: [] }])

      expect(response.parsed_body).to eq("success" => true)
      expect(stored_tabs).to eq([{ "name" => "Home", "sections" => [] }])
    end

    it "saves the theme without a version when no layout is sent", parity: true do
      save_tabs({ name: "Home", sections: [] })
      log_in(seller)

      send_json(:put, seller_profile: { font: "Inter" })

      expect(response.parsed_body).to eq("success" => true)
      expect(stored_tabs).to eq([{ "name" => "Home", "sections" => [] }])
    end

    it "refuses a layout saved against an old version and writes nothing", parity: true do
      section = products_section
      save_tabs({ name: "Home", sections: [section.id] })
      log_in(seller)

      send_json(:put, profile_version: "0" * 64, user: { name: "Not saved" }, sections: [{ id: section.external_id, header: "Stale" }], tabs: [{ name: "Home", sections: [] }])

      expect(response.parsed_body).to eq("success" => false, "error_message" => "Your profile was changed somewhere else. Please reload the page and try again.")
      expect(section.reload.header).to eq("Products")
      expect(seller.reload.name).to eq("Profile Seller")
    end

    it "refuses a layout saved with no version once the profile exists", parity: true do
      save_tabs({ name: "Home", sections: [] })
      log_in(seller)

      send_json(:put, tabs: [{ name: "Other", sections: [] }])

      expect(response.parsed_body).to eq("success" => false, "error_message" => "Your profile was changed somewhere else. Please reload the page and try again.")
      expect(stored_tabs).to eq([{ "name" => "Home", "sections" => [] }])
    end

    it "refuses sections saved with a blank version", parity: true do
      section = products_section
      save_tabs({ name: "Home", sections: [section.id] })
      log_in(seller)

      send_json(:put, profile_version: "  ", sections: [{ id: section.external_id, header: "Stale" }])

      expect(response.parsed_body["success"]).to eq(false)
      expect(section.reload.header).to eq("Products")
    end

    it "answers 'Invalid section type' and rolls back the sections before it", parity: true do
      log_in(seller)

      send_json(:put, profile_version: layout_version, sections: [{ id: "a", type: "SellerProfileSubscribeSection", header: "Join", button_label: "Join" },
                                 { id: "b", type: "SellerProfileFakeSection", header: "Nope" }],
                      tabs: [{ name: "Home", sections: ["a", "b"] }])

      expect(response.parsed_body).to eq("success" => false, "error_message" => "Invalid section type")
      expect(seller.seller_profile_sections.count).to eq(0)
    end

    it "creates a section for an id that belongs to no section of the seller", parity: true do
      other = create(:seller_profile_products_section, seller: create(:user), header: "Theirs", shown_products: [])
      log_in(seller)

      send_json(:put, profile_version: layout_version, sections: [{ id: other.external_id, type: "SellerProfileSubscribeSection", header: "Mine", button_label: "Join" }])

      expect(response.parsed_body).to eq("success" => true)
      expect(other.reload.header).to eq("Theirs")
      expect(seller.seller_profile_sections.sole.header).to eq("Mine")
    end

    it "hides the header of a section saved with a blank one", parity: true do
      section = products_section
      save_tabs({ name: "Home", sections: [section.id] })
      log_in(seller)

      send_json(:put, profile_version: layout_version, sections: [{ id: section.external_id, header: "" }], tabs: [{ name: "Home", sections: [section.external_id] }])

      expect(response.parsed_body).to eq("success" => true)
      expect(section.reload).to have_attributes(header: "", hide_header: true)
    end

    it "saves the layout, the theme and the profile together as a marketing team member", parity: true do
      section = products_section
      save_tabs({ name: "Home", sections: [section.id] })
      as_team_member(TeamMembership::ROLE_MARKETING)

      send_json(:put, profile_version: layout_version, user: { bio: "All at once" }, seller_profile: { highlight_color: "#00ff00" },
                      sections: [{ id: section.external_id, header: "Edited" }], tabs: [{ name: "Shop", sections: [section.external_id] }])

      expect(response.parsed_body).to eq("success" => true)
      expect(seller.reload.bio).to eq("All at once")
    end
  end

  describe "requests left to Rails" do
    it "hands a profile picture", parity: true do
      log_in(seller)

      send_json(:put, user: { name: "With logo" }, profile_picture_blob_id: "not-a-signed-id")

      expect(response.parsed_body).to eq("success" => false, "error_message" => "The logo is already removed. Please refresh the page and try again.")
      expect(seller.reload.name).to eq("Profile Seller")
    end

    it "hands a removed profile picture", parity: true do
      log_in(seller)

      send_json(:put, user: { name: "Without logo" }, profile_picture_blob_id: nil)

      expect(response.parsed_body).to eq("success" => true)
    end

    it "hands a rich text section", parity: true do
      log_in(seller)

      send_json(:put, profile_version: layout_version, sections: [{ id: "a", type: "SellerProfileRichTextSection", header: "About", text: {} }], tabs: [{ name: "Home", sections: ["a"] }])

      expect(response.parsed_body).to eq("success" => true)
      expect(seller.seller_profile_sections.sole).to be_a(SellerProfileRichTextSection)
    end

    it "hands a section whose data breaks its schema", parity: true do
      log_in(seller)

      send_json(:put, profile_version: layout_version, sections: [{ id: "a", type: "SellerProfileProductsSection", show_filters: "i hack u :)" }])

      expect(response.parsed_body["success"]).to eq(false)
      expect(seller.seller_profile_sections.count).to eq(0)
    end

    it "hands a layout that lists a section twice", parity: true do
      section = products_section
      save_tabs({ name: "Home", sections: [section.id] })
      log_in(seller)

      send_json(:put, profile_version: layout_version, tabs: [{ name: "Home", sections: [section.external_id, section.external_id] }])

      expect(response.parsed_body["success"]).to eq(false)
      expect(stored_tabs).to eq([{ "name" => "Home", "sections" => [section.id] }])
    end

    it "hands a blank custom_html when the seller has a page", parity: true do
      seller.update!(custom_html: "<p>hello</p>")
      log_in(seller)

      send_json(:put, user: { custom_html: "" })

      expect(response.parsed_body).to eq("success" => true)
      expect(seller.reload.custom_html).to be_nil
    end

    it "hands a request the Inertia client sends", parity: true do
      log_in(seller)
      token = csrf_token

      put profile_path, params: { user: { name: "Via Inertia" } }.to_json,
                        headers: { "Content-Type" => "application/json", "Accept" => "text/html, application/xhtml+xml", "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "X-CSRF-Token" => token }

      expect(response).to have_http_status(:see_other)
      expect(seller.reload.name).to eq("Via Inertia")
    end
  end
end
