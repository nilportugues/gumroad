# frozen_string_literal: true

require "spec_helper"

# Bundles::ContentController#update (add, remove, reorder and re-add the products of a bundle) and #update_purchases_content, recorded for
# the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/bundle-content.replay.test.ts, which sends the last request
# of each example. An example named "hands a ..." records what Node passes to Rails whole: it would write something Node does not port.
describe "Bundle content update", type: :request, elasticsearch_wait_for_refresh: true do
  include Parity::AudienceSignedIn

  let(:seller) { create(:named_seller, name: "Bundle Seller") }
  let(:bundle) { create(:product, :bundle, user: seller, name: "Content bundle", native_type: Link::NATIVE_TYPE_BUNDLE) }
  let(:first_member) { bundle.bundle_products.order(:id).first }
  let(:second_member) { bundle.bundle_products.order(:id).second }

  before { host! DOMAIN }

  def update_content(products, extra = {}, headers: {})
    patch "/bundles/#{bundle.external_id}/content",
          params: { products: }.merge(extra).to_json,
          headers: { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml", "Content-Type" => "application/json", "X-CSRF-Token" => csrf_token }.merge(headers)
  end

  def entry(bundle_product, **overrides)
    { product_id: bundle_product.product.external_id, variant_id: bundle_product.variant&.external_id, quantity: bundle_product.quantity, position: bundle_product.position }.merge(overrides)
  end

  def new_entry(product, **overrides)
    { product_id: product.external_id, variant_id: nil, quantity: 1, position: 2 }.merge(overrides)
  end

  def sell(product)
    build(:purchase, link: product, seller:, email: "buyer@example.com", purchase_state: "successful").tap { _1.save!(validate: false) }
    index_model_records(Purchase)
  end

  describe "PATCH /bundles/:bundle_id/content" do
    before do
      first_member.update_columns(position: 0)
      second_member.update_columns(position: 1)
      log_in(seller)
    end

    it "changes the quantity and order of the products it keeps", parity: true do
      update_content([entry(second_member, quantity: 3, position: 0), entry(first_member, quantity: 2, position: 1)])

      expect(response).to have_http_status(:see_other)
      expect(flash[:notice]).to eq("Changes saved!")
      expect(second_member.reload.quantity).to eq(3)
      expect(first_member.reload.position).to eq(1)
    end

    it "keeps a bundle as it is when the list matches", parity: true do
      update_content([entry(first_member), entry(second_member)])

      expect(response).to have_http_status(:see_other)
      expect(response.location).to eq("#{PROTOCOL}://#{DOMAIN}/bundles/#{bundle.external_id}/content/edit")
    end

    it "adds a product", parity: true do
      added = create(:product, user: seller, name: "Added product")

      update_content([entry(first_member), entry(second_member), new_entry(added, quantity: 4)])

      expect(response).to have_http_status(:see_other)
      expect(bundle.bundle_products.alive.where(product: added).pick(:quantity)).to eq(4)
    end

    it "removes the products missing from the list", parity: true do
      update_content([entry(first_member)])

      expect(response).to have_http_status(:see_other)
      expect(second_member.reload).to be_deleted
    end

    it "removes a product and adds another in one save", parity: true do
      added = create(:product, user: seller, name: "Swapped in")

      update_content([entry(first_member), new_entry(added)])

      expect(response).to have_http_status(:see_other)
      expect(second_member.reload).to be_deleted
      expect(bundle.bundle_products.alive.count).to eq(2)
    end

    it "brings back a product that was removed", parity: true do
      second_member.update_columns(deleted_at: 3.days.ago)

      update_content([entry(first_member), entry(second_member, quantity: 5)])

      expect(response).to have_http_status(:see_other)
      expect(second_member.reload).to be_alive
    end

    it "stamps a product that is still removed again", parity: true do
      second_member.update_columns(deleted_at: 3.days.ago)

      update_content([entry(first_member)])

      expect(response).to have_http_status(:see_other)
    end

    it "adds a product with the variant that was picked", parity: true do
      versioned = create(:product_with_digital_versions, user: seller, name: "Versioned product")
      variant = versioned.alive_variants.second

      update_content([entry(first_member), entry(second_member), new_entry(versioned, variant_id: variant.external_id)])

      expect(response).to have_http_status(:see_other)
      expect(bundle.bundle_products.alive.find_by(product: versioned).variant).to eq(variant)
    end

    it "changes the variant of a product that stays", parity: true do
      versioned = create(:product_with_digital_versions, user: seller, name: "Versioned product")
      member = create(:bundle_product, bundle:, product: versioned, variant: versioned.alive_variants.first, position: 2)
      other = versioned.alive_variants.second

      update_content([entry(first_member), entry(second_member), entry(member, variant_id: other.external_id)])

      expect(response).to have_http_status(:see_other)
      expect(member.reload.variant).to eq(other)
    end

    it "reads a quantity and position sent as text", parity: true do
      update_content([entry(first_member, quantity: "6", position: "1"), entry(second_member, position: "0")])

      expect(response).to have_http_status(:see_other)
      expect(first_member.reload.quantity).to eq(6)
    end

    it "flags purchases with outdated content when the bundle has sales", parity: true do
      sell(bundle)
      added = create(:product, user: seller, name: "After the sale")

      update_content([entry(first_member), entry(second_member), new_entry(added)])

      expect(response).to have_http_status(:see_other)
      expect(bundle.reload.has_outdated_purchases).to eq(true)
    end

    it "flags purchases with outdated content when a kept product changes", parity: true do
      sell(bundle)

      update_content([entry(first_member, quantity: 7), entry(second_member)])

      expect(response).to have_http_status(:see_other)
      expect(bundle.reload.has_outdated_purchases).to eq(true)
    end

    it "does not flag a bundle that is emptied, as the sales are not asked about", parity: true do
      sell(bundle)
      bundle.update_columns(draft: true)

      update_content([])

      expect(response).to have_http_status(:see_other)
      expect(bundle.reload.has_outdated_purchases).to eq(false)
    end

    it "leaves a flagged bundle flagged without asking about sales", parity: true do
      bundle.update_columns(flags: bundle.flags | Link.flag_mapping["flags"][:has_outdated_purchases])

      update_content([entry(first_member, quantity: 2), entry(second_member)])

      expect(response).to have_http_status(:see_other)
      expect(bundle.reload.has_outdated_purchases).to eq(true)
    end

    it "does not flag a bundle without sales", parity: true do
      added = create(:product, user: seller, name: "No sales")

      update_content([entry(first_member), entry(second_member), new_entry(added)])

      expect(response).to have_http_status(:see_other)
      expect(bundle.reload.has_outdated_purchases).to eq(false)
    end

    it "sends the seller back to the page the save came from", parity: true do
      update_content([entry(first_member), entry(second_member)], {}, headers: { "Referer" => "#{PROTOCOL}://#{DOMAIN}/bundles/#{bundle.external_id}/content/edit?tab=1" })

      expect(response).to have_http_status(:see_other)
      expect(response.location).to end_with("/content/edit?tab=1")
    end

    it "ignores a referrer on another host", parity: true do
      update_content([entry(first_member), entry(second_member)], {}, headers: { "Referer" => "https://evil.example.com/steal" })

      expect(response).to have_http_status(:see_other)
      expect(response.location).to eq("#{PROTOCOL}://#{DOMAIN}/bundles/#{bundle.external_id}/content/edit")
    end

    it "refuses a product that belongs to another seller and keeps the earlier changes out", parity: true do
      foreign = create(:product, user: create(:user, name: "Other Seller"), name: "Foreign product")

      update_content([entry(first_member, quantity: 9), new_entry(foreign)])

      expect(response).to have_http_status(:see_other)
      expect(flash[:alert]).to include("The product must belong to the bundle's seller")
      expect(first_member.reload.quantity).not_to eq(9)
      expect(second_member.reload).to be_alive
    end

    it "refuses a product listed twice", parity: true do
      added = create(:product, user: seller, name: "Twice")

      update_content([entry(first_member), entry(second_member), new_entry(added), new_entry(added, position: 3)])

      expect(response).to have_http_status(:see_other)
      expect(flash[:alert]).to include("Product is already in bundle")
    end

    it "refuses a versioned product without a variant", parity: true do
      versioned = create(:product_with_digital_versions, user: seller, name: "Versioned product")

      update_content([entry(first_member), entry(second_member), new_entry(versioned)])

      expect(response).to have_http_status(:see_other)
      expect(flash[:alert]).to include("Bundle product must have variant specified for versioned product")
    end

    it "refuses a variant of another product", parity: true do
      versioned = create(:product_with_digital_versions, user: seller, name: "Versioned product")
      stranger = create(:product_with_digital_versions, user: seller, name: "Other versioned product")

      update_content([entry(first_member), entry(second_member), new_entry(versioned, variant_id: stranger.alive_variants.first.external_id)])

      expect(response).to have_http_status(:see_other)
      expect(flash[:alert]).to include("The bundle product's variant must belong to its product")
    end

    it "refuses another bundle", parity: true do
      other = create(:product, :bundle, user: seller, name: "Inner bundle")

      update_content([entry(first_member), entry(second_member), new_entry(other)])

      expect(response).to have_http_status(:see_other)
      expect(flash[:alert]).to include("A bundle product cannot be added to a bundle")
    end

    it "refuses a subscription product", parity: true do
      membership = create(:membership_product, user: seller, name: "Membership")

      update_content([entry(first_member), entry(second_member), new_entry(membership)])

      expect(response).to have_http_status(:see_other)
      expect(flash[:alert]).to include("A subscription product cannot be added to a bundle")
    end

    it "refuses a call product", parity: true do
      seller.update_columns(created_at: 60.days.ago)
      call = create(:call_product, user: seller, name: "Call")

      update_content([entry(first_member), entry(second_member), new_entry(call)])

      expect(response).to have_http_status(:see_other)
      expect(flash[:alert]).to include("A call product cannot be added to a bundle")
    end

    it "refuses an empty list for a published bundle", parity: true do
      update_content([])

      expect(response).to have_http_status(:see_other)
      expect(flash[:alert]).to eq("Bundles must have at least one product.")
      expect(first_member.reload).to be_alive
    end

    it "empties a bundle that is not published", parity: true do
      bundle.update_columns(draft: true)

      update_content([])

      expect(response).to have_http_status(:see_other)
      expect(bundle.bundle_products.alive.count).to eq(0)
    end

    it "answers 404 for a product that does not exist", parity: true do
      update_content([entry(first_member), entry(second_member), new_entry(first_member.product, product_id: "unknownproduct")])

      expect(response).to have_http_status(:not_found)
    end

    it "hands a publish to Rails", parity: true do
      bundle.update_columns(draft: true)

      update_content([entry(first_member), entry(second_member)], { publish: true })

      expect(response).to have_http_status(:see_other)
    end

    it "unpublishes a published bundle", parity: true do
      update_content([entry(first_member), entry(second_member)], { unpublish: true })

      expect(response).to have_http_status(:see_other)
      expect(flash[:notice]).to eq("Unpublished!")
      expect(bundle.reload.purchase_disabled_at).to be_present
    end

    it "unpublishes and saves the new list of products in one request", parity: true do
      update_content([entry(first_member, quantity: 4)], { unpublish: true })

      expect(response).to have_http_status(:see_other)
      expect(bundle.reload.purchase_disabled_at).to be_present
      expect(second_member.reload).to be_deleted
    end

    it "unpublishes back to the page the save came from", parity: true do
      update_content([entry(first_member), entry(second_member)], { unpublish: true }, headers: { "Referer" => "#{PROTOCOL}://#{DOMAIN}/bundles/#{bundle.external_id}/content/edit" })

      expect(response).to redirect_to("#{PROTOCOL}://#{DOMAIN}/bundles/#{bundle.external_id}/content/edit")
      expect(flash[:notice]).to eq("Unpublished!")
    end

    it "keeps the time a bundle was unpublished when it is unpublished again", parity: true do
      bundle.update_columns(purchase_disabled_at: 3.days.ago)

      update_content([entry(first_member), entry(second_member)], { unpublish: true })

      expect(response).to have_http_status(:see_other)
      expect(flash[:notice]).to eq("Changes saved!")
    end

    it "saves a draft bundle that is asked to unpublish as a plain save", parity: true do
      bundle.update_columns(draft: true)

      update_content([entry(first_member), entry(second_member)], { unpublish: true })

      expect(response).to have_http_status(:see_other)
      expect(flash[:notice]).to eq("Changes saved!")
      expect(bundle.reload.purchase_disabled_at).to be_nil
    end

    it "saves a published bundle that is asked to publish as a plain save", parity: true do
      update_content([entry(first_member), entry(second_member)], { publish: true })

      expect(response).to have_http_status(:see_other)
      expect(flash[:notice]).to eq("Changes saved!")
    end

    it "sends the seller to the path given as the redirect target", parity: true do
      update_content([entry(first_member), entry(second_member)], { redirect_to: "/dashboard" })

      expect(response).to redirect_to("#{PROTOCOL}://#{DOMAIN}/dashboard")
      expect(flash[:notice]).to eq("Changes saved!")
    end

    it "keeps the query of a redirect target", parity: true do
      update_content([entry(first_member), entry(second_member)], { redirect_to: "/products?sort=name" })

      expect(response).to redirect_to("#{PROTOCOL}://#{DOMAIN}/products?sort=name")
    end

    it "reduces a redirect target on another host to its path", parity: true do
      update_content([entry(first_member), entry(second_member)], { redirect_to: "https://evil.example.com/steal?x=1" })

      expect(response).to redirect_to("#{PROTOCOL}://#{DOMAIN}/steal?x=1")
    end

    it "keeps a redirect target on this host", parity: true do
      update_content([entry(first_member), entry(second_member)], { redirect_to: "#{PROTOCOL}://#{DOMAIN}/dashboard" })

      expect(response).to redirect_to("#{PROTOCOL}://#{DOMAIN}/dashboard")
    end

    it "treats a backslash in a redirect target as a slash", parity: true do
      update_content([entry(first_member), entry(second_member)], { redirect_to: "/\\evil.example.com" })

      expect(response).to have_http_status(:see_other)
    end

    it "prefers an unpublish over a redirect target", parity: true do
      update_content([entry(first_member), entry(second_member)], { unpublish: true, redirect_to: "/dashboard" })

      expect(flash[:notice]).to eq("Unpublished!")
    end

    it "ignores a blank redirect target", parity: true do
      update_content([entry(first_member), entry(second_member)], { redirect_to: "" })

      expect(flash[:notice]).to eq("Changes saved!")
    end

    it "hands a bundle that is not a bundle yet to Rails", parity: true do
      bundle.update_columns(native_type: "digital")

      update_content([entry(first_member), entry(second_member)])

      expect(response).to have_http_status(:see_other)
    end

    it "hands a bundle with an installment plan to Rails", parity: true do
      bundle.update!(price_cents: 1000)
      create(:product_installment_plan, link: bundle, number_of_installments: 2)

      update_content([entry(first_member), entry(second_member)])

      expect(response).to have_http_status(:see_other)
    end
  end

  describe "POST /bundles/:bundle_id/content/update_purchases_content" do
    before { log_in(seller) }

    def queue_update
      post "/bundles/#{bundle.external_id}/content/update_purchases_content",
           params: {}.to_json,
           headers: { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml", "Content-Type" => "application/json", "X-CSRF-Token" => csrf_token }
    end

    it "clears the flag and queues the update of the outdated purchases", parity: true do
      bundle.update_columns(flags: bundle.flags | Link.flag_mapping["flags"][:has_outdated_purchases])

      queue_update

      expect(response).to have_http_status(:see_other)
      expect(flash[:notice]).to eq("Queued an update to the content of all outdated purchases.")
      expect(bundle.reload.has_outdated_purchases).to eq(false)
      expect(UpdateBundlePurchasesContentJob.jobs.size).to eq(1)
    end

    it "queues the update for a published bundle that was sold", parity: true do
      sell(bundle)
      bundle.update_columns(flags: bundle.flags | Link.flag_mapping["flags"][:has_outdated_purchases])

      queue_update

      expect(response).to have_http_status(:see_other)
      expect(UpdateBundlePurchasesContentJob.jobs.size).to eq(1)
    end

    it "queues the update for a bundle that is not published", parity: true do
      bundle.update_columns(draft: true, flags: bundle.flags | Link.flag_mapping["flags"][:has_outdated_purchases])

      queue_update

      expect(response).to have_http_status(:see_other)
      expect(bundle.reload.has_outdated_purchases).to eq(false)
    end
  end
end
