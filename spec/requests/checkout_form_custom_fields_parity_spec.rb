# frozen_string_literal: true

require "spec_helper"

# The custom fields list of the checkout form (Checkout::FormPresenter#form_props: `seller.custom_fields.not_is_post_purchase.map(&:as_json)`)
# when a field is linked to several products, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/checkout-form.replay.test.ts.
#
# `CustomField#products` is a has_and_belongs_to_many read with no ORDER BY, so the order of `products` in the props is the order of the
# plan MySQL picks: with these small tables it walks `links` by id, a large table would drive from the join rows. Both orders agree
# whenever the products were linked in id order, and Node serves exactly that case. A field linked against the ids is a "hands a ..."
# example: the replay asserts Node passed the request to Rails untouched, because the same statement answered in a different order on
# the replay database than it did on the recording one.
describe "Checkout form custom fields linked to several products", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Form Seller", username: "formseller", created_at: Time.utc(2025, 1, 1)) }
  let!(:first) { create(:product, user: seller, name: "First", created_at: Time.utc(2025, 1, 2)) }
  let!(:second) { create(:product, user: seller, name: "Second", created_at: Time.utc(2025, 1, 3)) }
  let!(:third) { create(:product, user: seller, name: "Third", created_at: Time.utc(2025, 1, 4)) }

  before { host! DOMAIN }

  def get_form
    log_in(seller)
    get checkout_form_path
  end

  def fields = inertia_props_of(response)["custom_fields"]

  it "lists the products of a field linked in id order", parity: true do
    create(:custom_field, seller:, name: "Shared", products: [first, second, third])

    get_form

    expect(fields.first["products"]).to eq([first, second, third].map(&:external_id))
  end

  it "keeps each field's links apart when two fields are linked in interleaved id order", parity: true do
    alpha = create(:custom_field, seller:, name: "Alpha", products: [first])
    beta = create(:custom_field, seller:, name: "Beta", products: [second])
    alpha.products << second
    alpha.products << third
    beta.products << third

    get_form

    expect(fields.map { [_1["name"], _1["products"]] }).to eq(
      [["Alpha", [first, second, third].map(&:external_id)], ["Beta", [second, third].map(&:external_id)]]
    )
  end

  it "lists a product that was deleted after it was linked", parity: true do
    create(:custom_field, seller:, name: "Shared", products: [first, second, third])
    second.mark_deleted!

    get_form

    expect(fields.first["products"]).to eq([first, second, third].map(&:external_id))
  end

  it "skips a link whose product no longer exists", parity: true do
    create(:custom_field, seller:, name: "Shared", products: [first, second, third])
    second.delete

    get_form

    expect(fields.first["products"]).to eq([first, third].map(&:external_id))
  end

  it "ignores the link order of a post-purchase field, which the form does not list", parity: true do
    create(:custom_field, seller:, name: "After the sale", is_post_purchase: true, global: true, products: [third, first])
    create(:custom_field, seller:, name: "Shared", products: [first, third])

    get_form

    expect(fields.map { [_1["name"], _1["products"]] }).to eq([["Shared", [first, third].map(&:external_id)]])
  end

  it "hands a field linked against the product ids to Rails", parity: true do
    create(:custom_field, seller:, name: "Shared", products: [third, first, second])

    get_form

    expect(fields.first["products"]).to match_array([first, second, third].map(&:external_id))
  end

  it "hands a second field linked against the product ids to Rails", parity: true do
    create(:custom_field, seller:, name: "Alpha", products: [first, second])
    create(:custom_field, seller:, name: "Beta", products: [third, second])

    get_form

    expect(fields.map { _1["name"] }).to eq(%w[Alpha Beta])
  end

  describe "a product's own custom fields in the cart item" do
    let!(:alpha) { create(:custom_field, seller:, name: "Alpha") }
    let!(:beta) { create(:custom_field, seller:, name: "Beta") }
    let!(:gamma) { create(:custom_field, seller:, name: "Gamma") }

    before do
      first.mark_deleted!
      third.mark_deleted!
    end

    def own_field_names = inertia_props_of(response)["cart_item"]["product"]["custom_fields"].map { _1["name"] }

    it "lists them when they were linked in id order", parity: true do
      [alpha, beta, gamma].each { second.custom_fields << _1 }

      get_form

      expect(own_field_names).to eq(%w[Alpha Beta Gamma])
    end

    it "hands a product whose fields were linked against their ids to Rails", parity: true do
      [gamma, alpha, beta].each { second.custom_fields << _1 }

      get_form

      expect(own_field_names).to match_array(%w[Alpha Beta Gamma])
    end
  end
end
