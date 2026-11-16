# frozen_string_literal: true

require "spec_helper"

# The page SubscribePreviewGeneratorService screenshots (UsersController#subscribe_preview on /:username), recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/users-controller.replay.test.ts, which sends the last request of each example.
# Examples whose name says "hands" are the ones the port leaves to Rails.
describe "Subscribe preview page", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:named_seller, name: "Preview Seller", bio: "Makes things.\nAll of them.", username: "previewseller") }

  before { host! DOMAIN }

  # The row an upload leaves, without the S3 request: the recorder would capture the image bytes and cannot write them as JSON.
  def attach_without_upload(name, file)
    blob = ActiveStorage::Blob.create!(key: "parity-#{name}", filename: file, content_type: "image/png", byte_size: 1024, checksum: "parity", service_name: "test")
    ActiveStorage::Attachment.create!(record: seller, name:, blob:)
  end

  it "renders the seller's name and bio with the default avatar", parity: true do
    get "/#{seller.username}/subscribe_preview"

    expect(response).to be_successful
    expect(response.headers["X-Robots-Tag"]).to eq("noindex")
  end

  it "renders a seller without a bio", parity: true do
    seller.update!(bio: nil)

    get "/#{seller.username}/subscribe_preview"

    expect(response).to be_successful
  end

  it "finds the seller by external id", parity: true do
    get "/#{seller.external_id}/subscribe_preview"

    expect(response).to be_successful
  end

  it "does not ask search engines to skip a seller with a sale", parity: true do
    product = create(:product, user: seller)
    build(:purchase, link: product, seller:, purchase_state: "successful").save!(validate: false)

    get "/#{seller.username}/subscribe_preview"

    expect(response).to be_successful
    expect(response.headers["X-Robots-Tag"]).to be_nil
  end

  it "answers 404 for an unknown username", parity: true do
    get "/nobody-here/subscribe_preview"

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 for a deleted seller", parity: true do
    seller.update_columns(deleted_at: Time.utc(2025, 1, 2))

    get "/#{seller.username}/subscribe_preview"

    expect(response).to have_http_status(:not_found)
  end

  it "hands a seller with an uploaded avatar to Rails", parity: true do
    attach_without_upload("avatar", "smilie.png")

    get "/#{seller.username}/subscribe_preview"

    expect(response).to be_successful
  end

  it "hands a seller with an uploaded subscribe preview to Rails", parity: true do
    attach_without_upload("subscribe_preview", "subscribe_preview.png")

    get "/#{seller.username}/subscribe_preview"

    expect(response).to be_successful
  end
end
