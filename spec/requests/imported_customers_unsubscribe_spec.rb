# frozen_string_literal: true

require "spec_helper"

# The unsubscribe link of an imported customer (ImportedCustomersController#unsubscribe), recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/audience-next.replay.test.ts.
describe "Imported customer unsubscribe link", type: :request do
  let(:seller) { create(:user, name: "Importing Seller") }
  let(:product) { create(:product, user: seller, unique_permalink: "unsubimp") }

  before { host! DOMAIN }

  def import(email, **attributes)
    create(:imported_customer, importing_user: seller, email:, link_id: product.id, purchase_date: Time.utc(2025, 1, 2, 12), **attributes)
  end

  it "answers 404 for an unknown customer", parity: true do
    get unsubscribe_imported_customer_path("unknownid")

    expect(response).to have_http_status(:not_found)
  end

  it "hands a customer to unsubscribe to Rails", parity: true do
    customer = import("imported@example.com")

    get unsubscribe_imported_customer_path(customer.external_id)

    expect(response).to have_http_status(:ok)
    expect(customer.reload.deleted_at).to be_present
  end

  it "hands a customer who unsubscribed before to Rails", parity: true do
    customer = import("again@example.com", deleted_at: Time.utc(2025, 2, 5, 12))

    get unsubscribe_imported_customer_path(customer.external_id)

    expect(response).to have_http_status(:ok)
    expect(customer.reload.deleted_at).to be_nil
  end
end
