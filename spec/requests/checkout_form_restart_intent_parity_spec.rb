# frozen_string_literal: true

require "spec_helper"

# A membership offered by a cross-sell on the checkout form carries `restart_intent`, a Checkout::RestartIntentToken for a guest.
# Recorded for the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/checkout-form.replay.test.ts. The token holds the
# clock (`issued_at`, the expiry), so the replay does not compare it byte for byte: it decodes the one Rails recorded and the one Node
# issued with the same secret and compares the payloads and the lifetime. spec/services/checkout/restart_intent_token_node_spec.rb has
# Rails verify tokens Node issued.
describe "Checkout form restart intent", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Form Seller", username: "formseller", created_at: Time.utc(2025, 1, 1)) }
  let!(:base) { create(:product, user: seller, name: "Base", created_at: Time.utc(2025, 1, 2)) }

  before { host! DOMAIN }

  def offer(product)
    create(:upsell, seller:, product:, name: "Add", cross_sell: true, selected_products: [base])
  end

  def offered_product = inertia_props_of(response)["cart_item"]["product"]["cross_sells"].sole["offered_product"]

  def get_form
    log_in(seller)
    get checkout_form_path
  end

  it "signs the membership a cross-sell offers", parity: true do
    membership = create(:membership_product_with_preset_tiered_pricing, user: seller, name: "Club", created_at: Time.utc(2025, 1, 1))
    offer(membership)

    get_form

    token = offered_product["restart_intent"]
    expect(token).to be_present
    expect(Checkout::RestartIntentToken.restart_intended?(token, product: membership, buyer: nil, lapsed_at: 1.minute.ago)).to eq(true)
    expect(offered_product["recurrence"]).to eq("monthly")
  end

  it "signs a yearly membership offered at its default recurrence", parity: true do
    membership = create(:membership_product_with_preset_tiered_pricing, user: seller, name: "Yearly club", subscription_duration: :yearly, created_at: Time.utc(2025, 1, 1),
                                                                        recurrence_price_values: [
                                                                          { monthly: { enabled: true, price: 3 }, yearly: { enabled: true, price: 30 } },
                                                                          { monthly: { enabled: true, price: 5 }, yearly: { enabled: true, price: 50 } },
                                                                        ])
    offer(membership)

    get_form

    expect(offered_product["restart_intent"]).to be_present
    expect(offered_product["recurrence"]).to eq("yearly")
  end

  it "signs a non-tiered subscription product", parity: true do
    subscription = create(:subscription_product, user: seller, name: "Plain subscription", created_at: Time.utc(2025, 1, 1))
    offer(subscription)

    get_form

    expect(offered_product["restart_intent"]).to be_present
  end

  it "does not sign a product that is not recurring", parity: true do
    offer(create(:product, user: seller, name: "One time", created_at: Time.utc(2025, 1, 1)))

    get_form

    expect(offered_product).not_to have_key("restart_intent")
  end

  it "does not sign the products of the cart item itself", parity: true do
    membership = create(:membership_product_with_preset_tiered_pricing, user: seller, name: "Newest club", created_at: Time.utc(2025, 2, 1))

    get_form

    expect(inertia_props_of(response)["cart_item"]).not_to have_key("restart_intent")
    expect(inertia_props_of(response)["cart_item"]["product"]["id"]).to eq(membership.external_id)
  end
end
