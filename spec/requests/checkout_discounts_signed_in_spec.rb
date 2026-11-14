# frozen_string_literal: true

require "spec_helper"

# The discounts dashboard (GET /checkout/discounts, /paged and /:id/statistics), recorded for the Next.js port (PARITY_RECORD=1) and
# replayed by nextjs/parity/__tests__/checkout-discounts.replay.test.ts, which sends the last request of each example.
describe "Checkout discounts when signed in", type: :request do
  include Parity::SignedInDashboard

  JSON_HEADERS = { "Accept" => "application/json" }.freeze

  let(:seller) { create(:user, name: "Discount Seller") }
  let(:alpha) { create(:product, user: seller, name: "Alpha", price_cents: 500) }
  let(:beta) { create(:product, user: seller, name: "Beta", price_cents: 900) }

  # Distinct update times keep the `updated_at DESC` tiebreak deterministic.
  def stamp(code, day)
    code.update_columns(updated_at: Time.utc(2026, 1, day, 12), created_at: Time.utc(2026, 1, day, 12))
    code
  end

  def sell(product, code, price_cents: 400, quantity: 1, discount: nil)
    purchase = build(:purchase, link: product, seller:, offer_code: code, purchase_state: "successful", price_cents:, quantity:)
    purchase.save!(validate: false)
    if discount
      PurchaseOfferCodeDiscount.new(purchase:, offer_code: code, offer_code_amount: 100, pre_discount_minimum_price_cents: 500, **discount).save!(validate: false)
    end
    purchase
  end

  def seed_codes
    stamp(create(:offer_code, user: seller, products: [alpha], code: "ALPHA1", name: "Alpha deal", amount_cents: 100, valid_at: Time.utc(2030, 1, 1), expires_at: Time.utc(2031, 1, 1)), 1)
    stamp(create(:percentage_offer_code, user: seller, products: [alpha, beta], code: "HALF", name: "", amount_percentage: 50, max_purchase_count: 20), 2)
    stamp(create(:universal_offer_code, user: seller, code: "ALLSALE", name: "Everything", amount_percentage: 10, excluded_products: [beta], auto_apply: true, sale_label: "Spring"), 3)
  end

  def fetch(params = {}) = get(paged_checkout_discounts_path, params:, headers: JSON_HEADERS)

  describe "the page" do
    it "lists the codes and the products with their options", parity: true do
      category = create(:variant_category, link: alpha, title: "Size")
      small = create(:variant, variant_category: category, name: "Small")
      create(:variant, variant_category: category, name: "Untitled")
      seed_codes
      stamp(create(:offer_code, user: seller, products: [alpha], variants: [small], code: "SMALLONLY", amount_cents: 50), 4)
      log_in(seller)

      inertia_visit checkout_discounts_path

      expect(response).to be_successful
      expect(response.parsed_body["component"]).to eq("Checkout/Discounts/Index")
    end

    it "lists the versions of a product whose rows carry no position or timestamp", parity: true do
      category = create(:variant_category, link: alpha, title: "Size")
      untimestamped = [create(:variant, variant_category: category, name: "Small"), create(:variant, variant_category: category, name: "Large")]
      untimestamped.each { |variant| variant.update_columns(position_in_category: nil, created_at: nil) }
      create(:variant, variant_category: category, name: "Medium").update_columns(position_in_category: nil, created_at: Time.utc(2025, 1, 1))
      seed_codes
      log_in(seller)

      inertia_visit checkout_discounts_path

      expect(response).to be_successful
      expect(response.parsed_body["props"]["products"].find { _1["name"] == "Alpha" }["options"].map { _1["name"] }).to match_array(%w[Small Large Medium])
    end

    it "shows the Black Friday banner when the feature is on", parity: true do
      Feature.activate(:black_friday_seller_banner)
      seed_codes
      log_in(seller)

      inertia_visit checkout_discounts_path

      expect(response.parsed_body["props"]["show_black_friday_banner"]).to eq(true)
    end

    it "keeps a membership, a tiered code and an existing-customers code readable", parity: true do
      tier = create(:membership_product_with_preset_tiered_pricing, user: seller, name: "Club")
      stamp(create(:tiered_offer_code, user: seller, products: [alpha], code: "TIERED", name: "Loyalty"), 1)
      stamp(create(:offer_code, :for_existing_customers, user: seller, products: [alpha], ownership_products: [alpha, tier], code: "LOYAL", name: "Returning", amount_cents: 75), 2)
      log_in(seller)

      inertia_visit checkout_discounts_path

      expect(response.parsed_body["props"]["offer_codes"].size).to eq(2)
    end

    it "opens the second page and honours the sort in the address", parity: true do
      12.times { |i| stamp(create(:offer_code, user: seller, products: [alpha], code: "BULK#{i}", name: "Bulk #{i}", amount_cents: 10 + i), i + 1) }
      log_in(seller)

      inertia_visit checkout_discounts_path(page: 2, sort: { key: "name", direction: "desc" })

      expect(response.parsed_body["props"]["pagination"]).to eq("pages" => 2, "page" => 2)
    end

    it "lets a support team member read the page without editing", parity: true do
      seed_codes
      member = create(:user, name: "Team Support")
      membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_SUPPORT)
      log_in(member)
      switch_to(membership)

      inertia_visit checkout_discounts_path

      expect(response.parsed_body["props"]["offer_codes"].map { _1["can_update"] }.uniq).to eq([false])
    end

    it "redirects a signed-out visitor to the login page", parity: true do
      get checkout_discounts_path

      expect(response).to redirect_to(login_path(next: checkout_discounts_path))
    end

    it "hands a page with an array query to Rails", parity: true do
      seed_codes
      log_in(seller)

      inertia_visit "#{checkout_discounts_path}?query[]=alpha"

      expect(response).to be_successful
    end
  end

  describe "paged" do
    it "lists the first page newest first", parity: true do
      seed_codes
      log_in(seller)

      fetch

      expect(response.parsed_body["offer_codes"].map { _1["code"] }).to eq(%w[ALLSALE HALF ALPHA1])
    end

    it "reports the second page", parity: true do
      12.times { |i| stamp(create(:offer_code, user: seller, products: [alpha], code: "BULK#{i}", name: "Bulk #{i}"), i + 1) }
      log_in(seller)

      fetch(page: 2)

      expect(response.parsed_body["pagination"]).to eq("pages" => 2, "page" => 2)
    end

    it "maps a page past the last one to the last page", parity: true do
      12.times { |i| stamp(create(:offer_code, user: seller, products: [alpha], code: "BULK#{i}", name: "Bulk #{i}"), i + 1) }
      log_in(seller)

      fetch(page: 99)

      expect(response.parsed_body["pagination"]["page"]).to eq(2)
    end

    it "answers the first page for an empty list and a page of zero", parity: true do
      log_in(seller)

      fetch(page: 0)

      expect(response.parsed_body).to eq("offer_codes" => [], "pagination" => { "pages" => 1, "page" => 1 })
    end

    it "searches names and codes", parity: true do
      seed_codes
      log_in(seller)

      fetch(query: "ALL")

      expect(response.parsed_body["offer_codes"].map { _1["code"] }).to eq(%w[ALLSALE])
    end

    it "sorts by name descending", parity: true do
      seed_codes
      log_in(seller)

      fetch(sort: { key: "name", direction: "desc" })

      expect(response.parsed_body["offer_codes"].map { _1["name"] }).to eq(["Everything", "Alpha deal", ""])
    end

    it "sorts by term", parity: true do
      seed_codes
      log_in(seller)

      fetch(sort: { key: "term", direction: "asc" })

      expect(response).to be_successful
    end

    it "sorts by revenue", parity: true do
      seed_codes
      sell(alpha, OfferCode.find_by!(code: "HALF"), price_cents: 700)
      sell(alpha, OfferCode.find_by!(code: "ALPHA1"), price_cents: 300)
      log_in(seller)

      fetch(sort: { key: "revenue", direction: "desc" })

      expect(response.parsed_body["offer_codes"].map { _1["code"] }).to eq(%w[HALF ALPHA1 ALLSALE])
    end

    it "sorts by uses, counting a per-cart code once per cart", parity: true do
      seed_codes
      per_cart = stamp(create(:offer_code, user: seller, products: [alpha], code: "CART", amount_cents: 100, flags: 4), 4)
      sell(alpha, OfferCode.find_by!(code: "HALF"), quantity: 3)
      sell(alpha, per_cart, discount: { once_per_cart: true, once_per_cart_allocation_id: "alloc-1" })
      sell(beta, per_cart, discount: { once_per_cart: true, once_per_cart_allocation_id: "alloc-1" })
      log_in(seller)

      fetch(sort: { key: "uses", direction: "desc" })

      expect(response.parsed_body["offer_codes"].map { _1["code"] }.first).to eq("HALF")
    end

    it "reads the legacy column and sort params", parity: true do
      seed_codes
      log_in(seller)

      fetch(column: "name", sort: "asc")

      expect(response.parsed_body["offer_codes"].map { _1["name"] }).to eq(["", "Alpha deal", "Everything"])
    end

    it "serializes options, tiers, ownership products and the per-cart flag", parity: true do
      category = create(:variant_category, link: alpha, title: "Size")
      small = create(:variant, variant_category: category, name: "Small")
      stamp(create(:offer_code, user: seller, products: [alpha], variants: [small], code: "SMALLONLY", amount_cents: 50, flags: 4), 1)
      stamp(create(:tiered_offer_code, user: seller, products: [beta], code: "TIERED"), 2)
      stamp(create(:offer_code, :for_existing_customers, user: seller, products: [alpha], code: "LOYAL", amount_cents: 75, minimum_quantity: 2, minimum_amount_cents: 300, duration_in_billing_cycles: 3), 3)
      log_in(seller)

      fetch

      expect(response.parsed_body["offer_codes"].size).to eq(3)
    end

    it "lists the options an existing-customers code requires, live and deleted", parity: true do
      category = create(:variant_category, link: alpha, title: "Size")
      small = create(:variant, variant_category: category, name: "Small")
      removed = create(:variant, variant_category: category, name: "Removed")
      removed.mark_deleted!
      gone_category = create(:variant_category, link: beta, title: "Gone")
      stranded = create(:variant, variant_category: gone_category, name: "Stranded")
      gone_category.mark_deleted!
      loyal = create(:offer_code, :for_existing_customers, user: seller, products: [alpha], code: "LOYAL", amount_cents: 75)
      loyal.ownership_variants << small
      loyal.ownership_variants << removed
      loyal.ownership_variants << stranded
      stamp(loyal, 1)
      log_in(seller)

      fetch

      expect(response.parsed_body["offer_codes"][0]["ownership_options"].values.map { _1["deleted"] }).to eq([false, true, true])
    end

    it "lets an accountant read but not edit", parity: true do
      seed_codes
      member = create(:user, name: "Team Accountant")
      membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_ACCOUNTANT)
      log_in(member)
      switch_to(membership)

      fetch

      expect(response.parsed_body["offer_codes"].map { _1["can_update"] }.uniq).to eq([false])
    end

    it "hands a paged request with an array query to Rails", parity: true do
      seed_codes
      log_in(seller)

      get "#{paged_checkout_discounts_path}?query[]=alpha", headers: JSON_HEADERS

      expect(response).to be_successful
    end

    it "hands a sort key that is not text to Rails", parity: true do
      seed_codes
      log_in(seller)

      get "#{paged_checkout_discounts_path}?sort[key][]=name", headers: JSON_HEADERS

      expect(response).to be_successful
    end
  end

  describe "statistics" do
    def stats(code) = get(statistics_checkout_discount_path(code.external_id), headers: JSON_HEADERS)

    it "adds up uses and revenue per product", parity: true do
      seed_codes
      half = OfferCode.find_by!(code: "HALF")
      sell(alpha, half, price_cents: 700, quantity: 2)
      sell(beta, half, price_cents: 300)
      log_in(seller)

      stats(half)

      expect(response.parsed_body["uses"]["total"]).to eq(3)
      expect(response.parsed_body["revenue_cents"]).to eq(1000)
    end

    it "counts a per-cart allocation once and a legacy per-cart purchase once", parity: true do
      code = create(:offer_code, user: seller, products: [alpha, beta], code: "CART", amount_cents: 100, flags: 4)
      sell(alpha, code, quantity: 2, discount: { once_per_cart: true, once_per_cart_allocation_id: "alloc-1" })
      sell(beta, code, discount: { once_per_cart: true, once_per_cart_allocation_id: "alloc-1" })
      sell(beta, code, quantity: 3, discount: { once_per_cart: true })
      sell(alpha, code, quantity: 2, discount: { once_per_cart: false })
      log_in(seller)

      stats(code)

      expect(response.parsed_body["uses"]["total"]).to eq(4)
    end

    it "answers zero for a code nobody used", parity: true do
      seed_codes
      log_in(seller)

      stats(OfferCode.find_by!(code: "HALF"))

      expect(response.parsed_body).to eq("uses" => { "total" => 0, "products" => {} }, "revenue_cents" => 0)
    end

    it "answers not found for another seller's code", parity: true do
      other = create(:user)
      foreign = create(:offer_code, user: other, products: [create(:product, user: other)], code: "THEIRS")
      log_in(seller)

      stats(foreign)

      expect(response).to have_http_status(:not_found)
    end

    it "answers not found for an unknown id", parity: true do
      log_in(seller)

      get statistics_checkout_discount_path("nope"), headers: JSON_HEADERS

      expect(response).to have_http_status(:not_found)
    end

    it "lets a support team member read the statistics", parity: true do
      seed_codes
      member = create(:user, name: "Team Support")
      membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_SUPPORT)
      log_in(member)
      switch_to(membership)

      stats(OfferCode.find_by!(code: "HALF"))

      expect(response).to be_successful
    end
  end
end
