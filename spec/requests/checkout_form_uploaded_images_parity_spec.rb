# frozen_string_literal: true

require "spec_helper"

# The uploaded images on the checkout form, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/checkout-form.replay.test.ts: a product's uploaded thumbnail (the cart item's `thumbnail_url` and the card's
# `thumbnail_url`) and the seller's uploaded avatar (`creator.avatar_url`).
#
# As in help_center_signed_in_gaps_spec.rb, the processed variant Rails keeps is created by hand with Active Storage's own digest and a
# stand-in file, because reading an existing variant needs no ImageMagick. A thumbnail whose variant is not processed yet is handed
# back, but cannot be recorded: Rails makes the variant during the request and the recorder cannot serialize the PNG it uploads.
describe "Checkout form uploaded images", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Form Seller", username: "formseller", created_at: Time.utc(2025, 1, 1)) }
  let!(:product) { create(:product, user: seller, name: "Pictured", created_at: Time.utc(2025, 1, 2)) }

  before { host! DOMAIN }

  def upload(fixture, filename:, content_type:)
    ActiveStorage::Blob.create_and_upload!(io: File.open(Rails.root.join("spec/support/fixtures", fixture)), filename:, content_type:)
  end

  def attach_thumbnail(blob, limit: Thumbnail::DISPLAY_THUMBNAIL_DIMENSION, processed: true)
    thumbnail = Thumbnail.new(product:)
    thumbnail.save!(validate: false)
    ActiveStorage::Attachment.create!(name: "file", record: thumbnail, blob:)
    attach_variant(thumbnail.reload.file, blob, limit) if processed
    thumbnail
  end

  def attach_variant(attached, blob, limit)
    digest = attached.variant(resize_to_limit: [limit, limit]).variation.digest
    variant_record = blob.variant_records.create!(variation_digest: digest)
    ActiveStorage::Attachment.create!(name: "image", record: variant_record, blob: upload("kFDzu.png", filename: "resized.png", content_type: "image/png"))
  end

  def get_form
    log_in(seller)
    get checkout_form_path
  end

  def props = inertia_props_of(response)

  describe "the product thumbnail" do
    it "links the processed variant of a png thumbnail", parity: true do
      thumbnail = attach_thumbnail(upload("lemons-640x362.png", filename: "lemons.png", content_type: "image/png"))

      get_form

      expect(props["cart_item"]["product"]["thumbnail_url"]).to eq(thumbnail.url)
      expect(props["card_product"]["thumbnail_url"]).to eq(thumbnail.url)
    end

    it "links the processed variant of a jpeg thumbnail named in capitals", parity: true do
      thumbnail = attach_thumbnail(upload("autumn-leaves-1280x720.jpeg", filename: "LEAVES.JPG", content_type: "image/jpeg"))

      get_form

      expect(props["cart_item"]["product"]["thumbnail_url"]).to eq(thumbnail.url)
    end

    it "links the file itself for a gif, which is not transformed", parity: true do
      thumbnail = attach_thumbnail(upload("sample.gif", filename: "sample.gif", content_type: "image/gif"), processed: false)

      get_form

      expect(props["cart_item"]["product"]["thumbnail_url"]).to eq(thumbnail.url)
    end

    it "links the file itself when it cannot be turned into a variant", parity: true do
      thumbnail = attach_thumbnail(upload("test.pdf", filename: "not-an-image.pdf", content_type: "application/pdf"), processed: false)

      get_form

      expect(props["cart_item"]["product"]["thumbnail_url"]).to eq(thumbnail.url)
    end

    it "prefers an unsplash thumbnail over an uploaded file", parity: true do
      thumbnail = attach_thumbnail(upload("lemons-640x362.png", filename: "lemons.png", content_type: "image/png"))
      thumbnail.update_columns(unsplash_url: "https://images.unsplash.com/photo-1?w=600")

      get_form

      expect(props["cart_item"]["product"]["thumbnail_url"]).to eq("https://images.unsplash.com/photo-1?w=600")
    end
  end

  describe "the seller avatar" do
    it "links the processed variant of an uploaded avatar", parity: true do
      blob = upload("lemons-640x362.png", filename: "lemons.png", content_type: "image/png")
      ActiveStorage::Attachment.create!(name: "avatar", record: seller, blob:)
      attach_variant(seller.reload.avatar, blob, 400)

      get_form

      expect(props["cart_item"]["product"]["creator"]["avatar_url"]).to eq(seller.reload.avatar_url)
      expect(props["cart_item"]["product"]["creator"]["avatar_url"]).not_to include("default-avatar")
    end
  end
end
