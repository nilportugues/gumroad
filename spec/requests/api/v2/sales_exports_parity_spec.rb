# frozen_string_literal: true

require "spec_helper"

# Api::V2::SalesController#export through the full Rack stack, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/api-v2-ws17c.replay.test.ts. Unlike the controller spec, nothing is stubbed: the recording holds the
# `sales_exports` row, whose `query` column is the YAML Rails writes, and the chunk worker's job.
describe "API v2 sales export", type: :request do
  include Parity::ApiV2Requests

  let(:seller) { create(:user, name: "Export Seller", email: "export-seller@example.com") }
  let(:product) { create(:product, user: seller) }

  def export(scopes: "view_sales", token: api_token(seller, scopes:), **params)
    api_call(:post, "/sales/exports", token:, params:)
  end

  it "queues an export of every sale", parity: true do
    export
  end

  it "queues an export with a date range and a product", parity: true do
    export(from: "2026-01-01", to: "2026-05-21", product_id: product.external_id)
  end

  it "queues an export from a date", parity: true do
    export(from: "2026-03-15")
  end

  it "queues an export up to a date", parity: true do
    export(to: "2026-03-15")
  end

  it "queues an export of one product", parity: true do
    export(product_id: product.external_id)
  end

  it "queues an export of a deleted product", parity: true do
    product.update_columns(deleted_at: Time.current)
    export(product_id: product.external_id)
  end

  it "queues an export for a token with the account scope", parity: true do
    export(scopes: "account")
  end

  it "queues an export for a token with the edit_sales scope", parity: true do
    export(from: "2026-02-28", scopes: "edit_sales")
  end

  it "ignores blank filters", parity: true do
    export(from: "", to: " ", product_id: "")
  end

  it "reads a date followed by a time as the date", parity: true do
    export(from: "2026-01-05 10:30:00", to: "2026-01-06")
  end

  it "queues a second export beside the first", parity: true do
    export(from: "2026-01-01")
    export(from: "2026-01-02")
  end

  it "answers 400 for a from date that is not a date", parity: true do
    export(from: "394293")
  end

  it "answers 400 for a date that does not exist", parity: true do
    export(to: "2026-02-30")
  end

  it "names the from field when both dates are wrong", parity: true do
    export(from: "394293", to: "invalid-date")
  end

  it "answers 400 for a to date that is not a date", parity: true do
    export(to: "invalid-date")
  end

  it "answers 400 for a product id that is not an id", parity: true do
    export(product_id: "invalid base64")
  end

  it "answers 400 for another seller's product", parity: true do
    export(product_id: create(:product).external_id)
  end

  it "checks the dates before the product", parity: true do
    export(from: "nope", product_id: "invalid base64")
  end

  it "answers 403 for a token without the view_sales scope", parity: true do
    export(scopes: "view_public")
  end

  it "answers 401 without a token", parity: true do
    host! API_DOMAIN
    post "/v2/sales/exports"
  end

  it "answers 401 for a token whose owner was deleted", parity: true do
    token = api_token(seller, scopes: "view_sales")
    seller.update_columns(deleted_at: Time.current)
    export(token:)
  end

  it "reads a date spelled with short month and day numbers", parity: true do
    export(from: "2026-1-5", to: "2026-2-3")
  end

  it "hands back a date followed by other text", parity: true do
    export(from: "2026-01-05abc")
  end
end
