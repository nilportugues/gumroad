# frozen_string_literal: true

require "spec_helper"

# GET /profile/products/:id (Settings::Profile::ProductsController#show): ProductPresenter#product_props for the seller's own
# product, rendered as a visitor sees it. Recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/profile-product-props.replay.test.ts, which sends the last request of each example. An example named
# "hands a ..." is one Node leaves to Rails whole.
describe "Settings::Profile::ProductsController#show", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Profile Seller", username: "profileseller", created_at: User::MIN_AGE_FOR_SERVICE_PRODUCTS.ago - 1.day) }
  let(:product) { create(:product, user: seller, name: "Profile card", unique_permalink: "profilecard", price_cents: 700) }
  let(:json_headers) { { "Accept" => "application/json" } }
  let(:snapshot_key) { "seller_reputation_summary/v2/snapshot/#{seller.id}" }

  before { host! DOMAIN }

  def fetch(record = product)
    get "/profile/products/#{record.external_id}", headers: json_headers
  end

  def purchase_by_guid(guid, **attributes)
    purchase = build(:purchase, link: product, seller:, purchaser: nil, browser_guid: guid, purchase_state: "successful", **attributes)
    purchase.save!(validate: false)
    create(:url_redirect, purchase:, link: product)
    purchase
  end

  # Review stats of the viewed product and two others, with the rollup the warm job would have stored an hour ago.
  def reviewed_catalogue(snapshot: true)
    Feature.activate_user(:seller_reputation_summary, seller)
    other = create(:product, user: seller, name: "Alpha ebook", display_product_reviews: true)
    another = create(:product, user: seller, name: "Beta course", display_product_reviews: true)
    product.update!(display_product_reviews: true)
    ProductReviewStat.create!(link: other, reviews_count: 8, average_rating: 5.0, ratings_of_five_count: 8)
    ProductReviewStat.create!(link: another, reviews_count: 6, average_rating: 3.5, ratings_of_four_count: 4, ratings_of_three_count: 2)
    ProductReviewStat.create!(link: product, reviews_count: 4, average_rating: 4.0, ratings_of_five_count: 2, ratings_of_three_count: 2)
    return unless snapshot

    seller.warm_reputation_snapshot
    stored = JSON.parse($redis.get(snapshot_key))
    $redis.set(snapshot_key, stored.merge("computed_at" => 1.day.ago.to_i).to_json)
  end

  it "renders the seller's product card", parity: true do
    log_in(seller)

    fetch

    expect(response).to be_successful
    expect(response.parsed_body["product"]).to include("name" => "Profile card", "price_cents" => 700, "can_edit" => false)
    expect(response.parsed_body["wishlists"]).to eq([])
  end

  it "leaves the seller's wishlists out of the card", parity: true do
    wishlist = create(:wishlist, user: seller)
    create(:wishlist_product, wishlist:, product:)
    log_in(seller)

    fetch

    expect(response.parsed_body["wishlists"]).to eq([])
  end

  it "renders a cover that is an Unsplash photo", parity: true do
    AssetPreview.create!(link: product, unsplash_url: "https://images.example.com/photo.jpg", guid: "coverguidone")
    AssetPreview.create!(link: product, unsplash_url: "https://images.example.com/second.jpg", guid: "coverguidtwo")
    log_in(seller)

    fetch

    expect(response.parsed_body["product"]["covers"].map { _1["id"] }).to eq(%w[coverguidone coverguidtwo])
    expect(response.parsed_body["product"]["main_cover_id"]).to eq("coverguidone")
  end

  it "skips a cover that was deleted", parity: true do
    AssetPreview.create!(link: product, unsplash_url: "https://images.example.com/gone.jpg", guid: "goneguid").mark_deleted!
    log_in(seller)

    fetch

    expect(response.parsed_body["product"]).to include("covers" => [], "main_cover_id" => nil)
  end

  it "hands a product with a YouTube cover to Rails", parity: true do
    create(:asset_preview_youtube, link: product)
    log_in(seller)

    fetch

    expect(response.parsed_body["product"]["covers"].first).to include("type" => "oembed")
  end

  it "hands a product with an uploaded cover to Rails", parity: true do
    create(:asset_preview_jpg, link: product)
    log_in(seller)

    fetch

    expect(response.parsed_body["product"]["covers"].first).to include("type" => "image")
  end

  it "renders a call product", parity: true do
    call = create(:call_product, :available_for_a_year, user: seller, name: "Office hours")
    log_in(seller)

    fetch(call)

    expect(response.parsed_body["product"]).to include("native_type" => "call", "name" => "Office hours")
  end

  it "renders the waitlist of an unpublished product without its count", parity: true do
    waiting = create(:product, user: seller, name: "Coming soon", draft: true, waitlist_enabled: true)
    follower = create(:active_follower, user: seller)
    WaitlistEntry.create!(product: waiting, follower:)
    log_in(seller)

    fetch(waiting)

    expect(response.parsed_body["product"]["waitlist"]).to include("count" => nil)
  end

  it "hands a product with a public file to Rails", parity: true do
    create(:public_file, :with_audio, resource: product)
    log_in(seller)

    fetch

    expect(response.parsed_body["product"]["public_files"].size).to eq(1)
  end

  it "renders a public file whose upload is gone as no file", parity: true do
    PublicFile.create!(resource: product, public_id: PublicFile.generate_public_id, display_name: "Orphan", original_file_name: "orphan.mp3")
    log_in(seller)

    fetch

    expect(response.parsed_body["product"]["public_files"]).to eq([])
  end

  describe "the seller's reputation summary" do
    it "leaves the key out while the flag is off", parity: true do
      log_in(seller)

      fetch

      expect(response.parsed_body["product"]).not_to have_key("seller_reputation")
    end

    it "shows the rollup without this product's own reviews, and queues the refresh of a day-old snapshot", parity: true do
      reviewed_catalogue
      log_in(seller)

      fetch

      expect(response.parsed_body["product"]["seller_reputation"]).to eq("average" => 4.4, "count" => 14, "products_count" => 2)
      expect(WarmSellerReputationSummaryJob.jobs.size).to eq(1)
    end

    it "keeps the rollup null with no snapshot, and queues the job that builds it", parity: true do
      reviewed_catalogue(snapshot: false)
      log_in(seller)

      fetch

      expect(response.parsed_body["product"]).to include("seller_reputation" => nil)
      expect(WarmSellerReputationSummaryJob.jobs.size).to eq(1)
    end

    it "keeps the rollup null when the snapshot is behind the review version", parity: true do
      reviewed_catalogue
      $redis.incr("seller_reputation_summary/version/#{seller.id}")
      log_in(seller)

      fetch

      expect(response.parsed_body["product"]).to include("seller_reputation" => nil)
    end
  end

  describe "a purchase the browser made" do
    let(:guid) { "parity-profile-browser-guid" }

    it "renders a card for a browser whose purchase was refunded", parity: true do
      purchase_by_guid(guid, stripe_refunded: true)
      cookies[:_gumroad_guid] = guid
      log_in(seller)

      fetch

      expect(response.parsed_body["purchase"]).to be_nil
    end

    it "renders a card for a browser that bought another product", parity: true do
      other = create(:product, user: seller, name: "Other")
      purchase = build(:purchase, link: other, seller:, purchaser: nil, browser_guid: guid, purchase_state: "successful")
      purchase.save!(validate: false)
      cookies[:_gumroad_guid] = guid
      log_in(seller)

      fetch

      expect(response.parsed_body["purchase"]).to be_nil
    end

    it "hands a card for a browser that bought the product to Rails", parity: true do
      purchase_by_guid(guid)
      cookies[:_gumroad_guid] = guid
      log_in(seller)

      fetch

      expect(response.parsed_body["purchase"]).to be_present
    end
  end

  it "is a 404 for a product of another seller", parity: true do
    stranger = create(:product, user: create(:user), name: "Not mine")
    log_in(seller)

    fetch(stranger)

    expect(response).to have_http_status(:not_found)
  end

  it "is a 404 for an id that is not a product", parity: true do
    log_in(seller)

    get "/profile/products/nope", headers: json_headers

    expect(response).to have_http_status(:not_found)
  end

  it "refuses a support team member", parity: true do
    member = create(:user, name: "Support Member")
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_SUPPORT)
    log_in(member)
    switch_to(membership)

    fetch

    expect(response).to have_http_status(:unauthorized)
  end
end
