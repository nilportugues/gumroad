# frozen_string_literal: true

require "spec_helper"

# The LinksController actions Node answers by their guards or their empty answers: the landing iframe endpoints, update, publish,
# release_preorder, disable_downloads_for_all_files, price_check, send_sample_price_change_email, search and card. Recorded for the
# Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/links-controller.replay.test.ts, which sends the last request of
# each example. An example named "hands a ..." is one Node leaves to Rails.
describe "Links controller guards", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Links Seller", is_team_member: true) }
  let(:product) { create(:product, user: seller, name: "Guarded product", unique_permalink: "guarded", created_at: Time.utc(2025, 1, 1)) }
  let(:json_headers) do
    { "Accept" => "application/json, text/html", "Content-Type" => "application/json", "Referer" => "http://#{DOMAIN}/products" }
  end

  before { host! DOMAIN }

  def send_json(method, path, body = {})
    public_send(method, path, params: body.to_json, headers: json_headers.merge("X-CSRF-Token" => csrf_token))
  end

  def team_member(role)
    member = create(:user, name: "#{role.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  def collaborate_on(target)
    collaborator = create(:collaborator, seller:)
    create(:product_affiliate, affiliate: collaborator, product: target)
    log_in(collaborator.affiliate_user)
  end

  def with_landing_page(target = product, **attributes)
    Feature.activate_user(:custom_html_pages, target.user)
    target.update!(custom_html: "<section><h1>Landing</h1></section>")
    target.page.update_columns(updated_at: Time.utc(2025, 1, 2))
    target.update_columns(attributes) if attributes.any?
  end

  describe "the landing version" do
    it "tells a visitor that the landing page is absent", parity: true do
      with_landing_page

      get "/l/#{product.unique_permalink}/landing/version"

      expect(response.parsed_body).to eq("present" => false, "version" => nil)
    end

    it "gives the seller the version of a live landing page", parity: true do
      with_landing_page
      log_in(seller)

      get "/l/#{product.unique_permalink}/landing/version"

      expect(response.parsed_body).to eq("present" => true, "version" => Time.utc(2025, 1, 2).to_i)
    end

    it "gives the seller the version of the landing page of an unpublished product", parity: true do
      with_landing_page(purchase_disabled_at: Time.utc(2025, 1, 3))
      log_in(seller)

      get "/l/#{product.unique_permalink}/landing/version"

      expect(response.parsed_body).to eq("present" => true, "version" => Time.utc(2025, 1, 2).to_i)
    end

    it "gives a collaborator the version of the landing page", parity: true do
      with_landing_page
      collaborate_on(product)

      get "/l/#{product.unique_permalink}/landing/version"

      expect(response.parsed_body).to eq("present" => true, "version" => Time.utc(2025, 1, 2).to_i)
    end

    it "tells a signed-in buyer that the landing page is absent", parity: true do
      with_landing_page
      log_in(create(:user, name: "Links Buyer"))

      get "/l/#{product.unique_permalink}/landing/version"

      expect(response.parsed_body).to eq("present" => false, "version" => nil)
    end

    it "tells the seller that a product without a landing page has none", parity: true do
      Feature.activate_user(:custom_html_pages, seller)
      product
      log_in(seller)

      get "/l/#{product.unique_permalink}/landing/version"

      expect(response.parsed_body).to eq("present" => false, "version" => nil)
    end

    it "tells the seller that the landing page is absent while the feature is off", parity: true do
      with_landing_page
      Feature.deactivate_user(:custom_html_pages, seller)
      log_in(seller)

      get "/l/#{product.unique_permalink}/landing/version"

      expect(response.parsed_body).to eq("present" => false, "version" => nil)
    end

    it "answers 404 for a product that does not exist", parity: true do
      get "/l/nosuchproduct/landing/version"

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a banned product", parity: true do
      with_landing_page(banned_at: Time.utc(2025, 1, 3))

      get "/l/#{product.unique_permalink}/landing/version"

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for the product of a deleted seller", parity: true do
      with_landing_page
      seller.update_columns(deleted_at: Time.utc(2025, 1, 3))

      get "/l/#{product.unique_permalink}/landing/version"

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "the landing iframe" do
    it "answers 404 for a product that does not exist", parity: true do
      get "/l/nosuchproduct/landing/embed"

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a banned product", parity: true do
      with_landing_page(banned_at: Time.utc(2025, 1, 3))

      get "/l/#{product.unique_permalink}/landing/embed"

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a product that has no landing page", parity: true do
      Feature.activate_user(:custom_html_pages, seller)
      product

      get "/l/#{product.unique_permalink}/landing/embed"

      expect(response).to have_http_status(:not_found)
      expect(response.body).to be_empty
    end

    it "answers 404 while the custom HTML feature is off", parity: true do
      with_landing_page
      Feature.deactivate_user(:custom_html_pages, seller)

      get "/l/#{product.unique_permalink}/landing/embed"

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 to a visitor of the landing page of an unpublished product", parity: true do
      with_landing_page(purchase_disabled_at: Time.utc(2025, 1, 3))

      get "/l/#{product.unique_permalink}/landing/embed"

      expect(response).to have_http_status(:not_found)
    end

    it "hands the landing page of a live product to Rails", parity: true do
      with_landing_page

      get "/l/#{product.unique_permalink}/landing/embed"

      expect(response).to have_http_status(:ok)
      expect(response.body).to include("<h1>Landing</h1>")
    end

    it "hands the landing page of an unpublished product to its seller's Rails", parity: true do
      with_landing_page(purchase_disabled_at: Time.utc(2025, 1, 3))
      log_in(seller)

      get "/l/#{product.unique_permalink}/landing/embed"

      expect(response).to have_http_status(:ok)
    end
  end

  describe "updating a product" do
    it "hands the save of an owner's product to Rails", parity: true do
      product
      log_in(seller)

      send_json(:post, link_path(product.unique_permalink), { link: { name: "Renamed" } })

      expect(response).to have_http_status(:ok)
    end

    it "hands the save of a collaborator to Rails", parity: true do
      product
      collaborate_on(product)

      send_json(:post, link_path(product.unique_permalink), { link: { name: "Renamed by a collaborator" } })

      expect(response).to have_http_status(:ok)
    end

    it "answers 404 when updating a product of another seller", parity: true do
      other = create(:product, unique_permalink: "notmine")
      log_in(seller)

      send_json(:post, link_path(other.unique_permalink), { link: { name: "Stolen" } })

      expect(response).to have_http_status(:not_found)
      expect(other.reload.name).not_to eq("Stolen")
    end

    it "answers 404 when updating a product that does not exist", parity: true do
      log_in(seller)

      send_json(:post, link_path("nosuchproduct"), { link: { name: "Ghost" } })

      expect(response).to have_http_status(:not_found)
    end

    it "does not let a support team member update a product", parity: true do
      product
      team_member(TeamMembership::ROLE_SUPPORT)

      send_json(:post, link_path(product.unique_permalink), { link: { name: "Renamed" } })

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body).to eq("success" => false, "error" => "Your current role as Support cannot perform this action.")
      expect(product.reload.name).to eq("Guarded product")
    end

    it "answers 404 when a collaborator updates another product of the seller", parity: true do
      collaborate_on(create(:product, user: seller, unique_permalink: "collabone"))
      product

      send_json(:post, link_path(product.unique_permalink), { link: { name: "Renamed" } })

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "publishing a product" do
    it "hands the publication of an owner's product to Rails", parity: true do
      product.update!(purchase_disabled_at: Time.utc(2025, 1, 3))
      log_in(seller)

      send_json(:post, publish_link_path(product.unique_permalink))

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to include("success" => true)
    end

    it "answers 404 when publishing a product of another seller", parity: true do
      other = create(:product, unique_permalink: "notmine", purchase_disabled_at: Time.utc(2025, 1, 3))
      log_in(seller)

      send_json(:post, publish_link_path(other.unique_permalink))

      expect(response).to have_http_status(:not_found)
      expect(other.reload.purchase_disabled_at).to be_present
    end

    it "does not let an accountant publish a product", parity: true do
      product.update!(purchase_disabled_at: Time.utc(2025, 1, 3))
      team_member(TeamMembership::ROLE_ACCOUNTANT)

      send_json(:post, publish_link_path(product.unique_permalink))

      expect(response).to have_http_status(:unauthorized)
      expect(product.reload.purchase_disabled_at).to be_present
    end
  end

  describe "disabling downloads for all files" do
    it "counts nothing for a product without files", parity: true do
      product
      log_in(seller)

      send_json(:post, disable_downloads_for_all_files_link_path(product.unique_permalink))

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to include("success" => true, "disabled_count" => 0)
    end

    it "turns downloads off for the eligible files and counts the rest", parity: true, parity_timeline: true do
      pdf = create(:readable_document, link: product, position: 2)
      video = create(:streamable_video, link: product, position: 1)
      create(:non_readable_document, link: product, position: 3)
      create(:streamable_video, link: product, stream_only: true, position: 4)
      log_in(seller)

      send_json(:post, disable_downloads_for_all_files_link_path(product.unique_permalink))

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to include("success" => true, "disabled_count" => 2, "already_disabled_count" => 1, "ineligible_count" => 1)
      expect(response.parsed_body["disabled_file_ids"]).to eq([video.external_id, pdf.external_id])
    end

    it "hands the change of two flipped files that share a position to Rails", parity: true do
      create(:streamable_video, link: product)
      create(:readable_document, link: product)
      log_in(seller)

      send_json(:post, disable_downloads_for_all_files_link_path(product.unique_permalink))

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to include("disabled_count" => 2)
    end

    it "changes nothing when no file can change", parity: true, parity_timeline: true do
      create(:streamable_video, link: product, stream_only: true)
      create(:non_readable_document, link: product)
      log_in(seller)

      send_json(:post, disable_downloads_for_all_files_link_path(product.unique_permalink))

      expect(response.parsed_body).to include("disabled_count" => 0, "already_disabled_count" => 1, "ineligible_count" => 1)
    end

    it "hands the change of a product with a ready folder archive to Rails", parity: true do
      video = create(:streamable_video, link: product)
      text = create(:non_readable_document, link: product)
      folder_id = SecureRandom.uuid
      create(:rich_content, entity: product, description: [
               { "type" => "fileEmbedGroup", "attrs" => { "name" => "folder", "uid" => folder_id }, "content" => [
                 { "type" => "fileEmbed", "attrs" => { "id" => video.external_id, "uid" => SecureRandom.uuid } },
                 { "type" => "fileEmbed", "attrs" => { "id" => text.external_id, "uid" => SecureRandom.uuid } },
               ] }
             ])
      archive = product.product_files_archives.create!(folder_id:, product_files: [video, text])
      archive.mark_in_progress!
      archive.mark_ready!
      log_in(seller)

      send_json(:post, disable_downloads_for_all_files_link_path(product.unique_permalink))

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to include("disabled_count" => 1)
    end

    it "hands the change of a stamped PDF to Rails", parity: true do
      pdf = create(:readable_document, link: product)
      pdf.update!(pdf_stamp_enabled: true)
      log_in(seller)

      send_json(:post, disable_downloads_for_all_files_link_path(product.unique_permalink))

      expect(response).to have_http_status(:ok)
    end

    it "answers 404 for a product of another seller", parity: true do
      other = create(:product, unique_permalink: "notmine")
      log_in(seller)

      send_json(:post, disable_downloads_for_all_files_link_path(other.unique_permalink))

      expect(response).to have_http_status(:not_found)
    end

    it "does not let a support team member change the downloads", parity: true do
      product
      team_member(TeamMembership::ROLE_SUPPORT)

      send_json(:post, disable_downloads_for_all_files_link_path(product.unique_permalink))

      expect(response).to have_http_status(:unauthorized)
    end
  end

  describe "releasing a preorder" do
    it "hands the release of a preorder to Rails", parity: true do
      product.update!(is_in_preorder_state: true)
      create(:preorder_link, link: product, release_at: 1.month.from_now)
      log_in(seller)

      send_json(:post, release_preorder_path(product.unique_permalink))

      expect(response).to have_http_status(:ok)
    end

    it "answers 404 for a product of another seller", parity: true do
      other = create(:product, unique_permalink: "notmine")
      log_in(seller)

      send_json(:post, release_preorder_path(other.unique_permalink))

      expect(response).to have_http_status(:not_found)
    end

    it "does not let a support team member release a preorder", parity: true do
      product
      team_member(TeamMembership::ROLE_SUPPORT)

      send_json(:post, release_preorder_path(product.unique_permalink))

      expect(response).to have_http_status(:unauthorized)
    end
  end

  describe "the price check" do
    before { allow(PriceCheckerService).to receive(:call).and_return({ "verdict" => "ok" }) }

    it "hands a price check to Rails while the price checker is on", parity: true do
      Feature.activate_user(:price_checker, seller)
      product
      log_in(seller)

      send_json(:post, price_check_product_path(product.unique_permalink))

      expect(response).to have_http_status(:ok)
    end

    it "answers 404 while the price checker is off for the seller", parity: true do
      product
      log_in(seller)

      send_json(:post, price_check_product_path(product.unique_permalink))

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a product that does not exist", parity: true do
      log_in(seller)

      send_json(:post, price_check_product_path("nosuchproduct"))

      expect(response).to have_http_status(:not_found)
    end

    it "does not let a support team member check a price", parity: true do
      Feature.activate_user(:price_checker, seller)
      product
      team_member(TeamMembership::ROLE_SUPPORT)

      send_json(:post, price_check_product_path(product.unique_permalink))

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body).to eq("success" => false, "error" => "Your current role as Support cannot perform this action.")
    end

    it "hands a collaborator's price check to Rails", parity: true do
      Feature.activate_user(:price_checker, seller)
      product
      collaborate_on(product)

      send_json(:post, price_check_product_path(product.unique_permalink))

      expect(response).to have_http_status(:ok)
    end
  end

  describe "the sample price change email" do
    let(:membership) { create(:membership_product, user: seller, unique_permalink: "samplemem") }
    let(:tier) { membership.tiers.first }

    def send_sample(body)
      send_json(:post, sample_membership_price_change_email_path(membership.unique_permalink), body)
    end

    it "queues the email for an existing tier", parity: true, parity_mail_jobs: true do
      log_in(seller)

      send_sample({ tier_id: tier.external_id, amount: "5", recurrence: "monthly" })

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to eq("success" => true)
    end

    it "queues the email with the effective date and a custom message", parity: true, parity_mail_jobs: true do
      log_in(seller)

      send_sample({ tier_id: tier.external_id, amount: "12.5", recurrence: "yearly", effective_date: "2030-03-04", custom_message: "Prices go up" })

      expect(response.parsed_body).to eq("success" => true)
    end

    it "queues the email without a message when the custom message is blank", parity: true, parity_mail_jobs: true do
      tier.update!(subscription_price_change_effective_date: 1.year.from_now.to_date, subscription_price_change_message: "Stored message")
      log_in(seller)

      send_sample({ tier_id: tier.external_id, amount: "3", recurrence: "monthly", custom_message: "   " })

      expect(response.parsed_body).to eq("success" => true)
    end

    it "rounds a fractional amount to cents", parity: true, parity_mail_jobs: true do
      log_in(seller)

      send_sample({ tier_id: tier.external_id, amount: "4.995", recurrence: "monthly" })

      expect(response.parsed_body).to eq("success" => true)
    end

    it "queues the email for a tier of a single unit currency product", parity: true, parity_mail_jobs: true do
      membership.update_columns(price_currency_type: "jpy")
      log_in(seller)

      send_sample({ tier_id: tier.external_id, amount: "500", recurrence: "monthly" })

      expect(response.parsed_body).to eq("success" => true)
    end

    it "answers 422 for an amount that is not a price", parity: true, parity_mail_jobs: true do
      log_in(seller)

      send_sample({ tier_id: tier.external_id, amount: "five", recurrence: "monthly" })

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body).to eq("success" => false, "error" => "Invalid amount")
    end

    it "answers 422 for an amount above the maximum price", parity: true, parity_mail_jobs: true do
      log_in(seller)

      send_sample({ tier_id: tier.external_id, amount: "99999999999", recurrence: "monthly" })

      expect(response).to have_http_status(:unprocessable_entity)
    end

    it "answers 400 for a request without a tier", parity: true do
      log_in(seller)

      send_sample({ amount: "5", recurrence: "monthly" })

      expect(response).to have_http_status(:bad_request)
    end

    it "answers 400 for a request without an amount", parity: true do
      log_in(seller)

      send_sample({ tier_id: tier.external_id, recurrence: "monthly" })

      expect(response).to have_http_status(:bad_request)
    end

    it "hands a custom message with markup to Rails", parity: true, parity_mail_jobs: true do
      log_in(seller)

      send_sample({ tier_id: tier.external_id, amount: "5", recurrence: "monthly", custom_message: "<b>Hello</b> &amp; welcome" })

      expect(response.parsed_body).to eq("success" => true)
    end

    it "answers 404 for a tier that does not exist", parity: true do
      log_in(seller)

      send_json(:post, sample_membership_price_change_email_path(membership.unique_permalink), { tier_id: "nosuchtier", amount: "5", recurrence: "monthly" })

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "error" => "Not found")
    end

    it "answers 404 for the tier of another product", parity: true do
      other_tier = create(:membership_product, user: seller, unique_permalink: "othermem").tiers.first
      log_in(seller)

      send_json(:post, sample_membership_price_change_email_path(membership.unique_permalink), { tier_id: other_tier.external_id, amount: "5", recurrence: "monthly" })

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a product that does not exist", parity: true do
      log_in(seller)

      send_json(:post, sample_membership_price_change_email_path("nosuchproduct"), { tier_id: "x", amount: "5", recurrence: "monthly" })

      expect(response).to have_http_status(:not_found)
    end

    it "does not let a support team member send the email", parity: true do
      membership
      team_member(TeamMembership::ROLE_SUPPORT)

      send_json(:post, sample_membership_price_change_email_path(membership.unique_permalink), { tier_id: tier.external_id, amount: "5", recurrence: "monthly" })

      expect(response).to have_http_status(:unauthorized)
    end
  end

  describe "the products search" do
    let(:section) { create(:seller_profile_products_section, seller:, shown_products: [product.id]) }

    it "answers an empty page for a seller that does not exist", parity: true do
      get "/products/search", params: { user_id: "nosuchseller", section_id: "nosuchsection" }

      expect(response.parsed_body).to eq("total" => 0, "filetypes_data" => [], "tags_data" => [], "taxonomy_attributes_data" => [], "products" => [])
    end

    it "answers an empty page for a section that does not exist", parity: true do
      get "/products/search", params: { user_id: seller.external_id, section_id: "nosuchsection" }

      expect(response.parsed_body).to include("total" => 0, "products" => [])
    end

    it "answers an empty page for a section of another seller", parity: true do
      other_section = create(:seller_profile_products_section, seller: create(:user), shown_products: [])

      get "/products/search", params: { user_id: seller.external_id, section_id: other_section.external_id }

      expect(response.parsed_body).to include("total" => 0, "products" => [])
    end

    it "answers an empty page when no section is named", parity: true do
      get "/products/search", params: { user_id: seller.external_id }

      expect(response.parsed_body).to include("total" => 0, "products" => [])
    end

    it "hands the search of an existing section to Rails", parity: true do
      get "/products/search", params: { user_id: seller.external_id, section_id: section.external_id }

      expect(response).to have_http_status(:ok)
    end

    it "hands the search of the default products section to Rails", parity: true do
      get "/products/search", params: { user_id: seller.external_id, section_id: "default-products" }

      expect(response).to have_http_status(:ok)
    end

    it "hands a search by ids to Rails", parity: true do
      get "/products/search", params: { user_id: seller.external_id, section_id: "nosuchsection", ids: product.external_id }

      expect(response).to have_http_status(:ok)
    end

    it "hands a discover search to Rails", parity: true do
      get "/products/search", params: { query: "guarded" }

      expect(response).to have_http_status(:ok)
    end
  end

  describe "the product card" do
    it "answers 404 because the controller has no card action", parity: true do
      get "/products/#{product.unique_permalink}/card"

      expect(response).to have_http_status(:not_found)
    end
  end
end
