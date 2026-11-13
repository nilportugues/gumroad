# frozen_string_literal: true

require "spec_helper"

# LinksController#show: the public product page (Products/Show) on the Gumroad domain, which always
# redirects to the seller's host, on a seller subdomain and on a product's custom domain. Recorded for
# the Next.js port (PARITY_RECORD=1) through the full Rack stack. Replayed by
# nextjs/parity/__tests__/product-page.replay.test.ts, which sends the last request of each example.
describe "Product page", type: :request do
  include Parity::SignedInRequests

  let(:seller) { create(:named_seller, name: "Parity Seller", bio: "Makes things.", created_at: User::MIN_AGE_FOR_SERVICE_PRODUCTS.ago - 1.day) }
  let(:buyer) { create(:user, name: "Parity Buyer") }

  def seller_host!(user = seller)
    host! user.subdomain
  end

  def inertia_visit(path)
    get path, headers: { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest" }
  end

  describe "on the Gumroad domain" do
    let(:product) { create(:product, user: seller, name: "Redirected") }

    before { host! DOMAIN }

    it "redirects to the seller's subdomain", parity: true do
      get "/l/#{product.unique_permalink}"

      expect(response).to have_http_status(:moved_permanently)
    end

    it "keeps the query string and the offer code of the redirect", parity: true do
      get "/l/#{product.unique_permalink}/sxsw?recommended_by=search&variant=Large%20Size"

      expect(response).to have_http_status(:moved_permanently)
    end

    it "redirects a custom permalink to the general permalink", parity: true do
      product.update!(custom_permalink: "my-thing")

      get "/l/#{product.unique_permalink}"

      expect(response).to have_http_status(:moved_permanently)
    end

    it "is a 404 for an unknown permalink", parity: true do
      get "/l/does-not-exist"

      expect(response).to have_http_status(:not_found)
    end

    it "sets the affiliate cookie before redirecting", parity: true do
      affiliate = create(:direct_affiliate, seller:, products: [product])

      get "/l/#{product.unique_permalink}?affiliate_id=#{affiliate.external_id_numeric}"

      expect(response).to have_http_status(:moved_permanently)
      expect(set_cookies).to include(affiliate.cookie_key)
    end

    it "reads the short affiliate parameter", parity: true do
      affiliate = create(:direct_affiliate, seller:, products: [product])

      get "/l/#{product.unique_permalink}?a=#{affiliate.external_id_numeric}&recommended_by=search"

      expect(response).to have_http_status(:moved_permanently)
      expect(set_cookies).to include(affiliate.cookie_key)
    end

    it "sets no cookie for an unknown or deleted affiliate", parity: true do
      deleted = create(:direct_affiliate, seller:, products: [product], deleted_at: Time.current)

      get "/l/#{product.unique_permalink}?a=999999&affiliate_id=#{deleted.external_id_numeric}"

      expect(response).to have_http_status(:moved_permanently)
    end

    it "moves a code query parameter into the path", parity: true do
      get "/l/#{product.unique_permalink}?code=five"

      expect(response).to have_http_status(:moved_permanently)
      expect(response.headers["X-Robots-Tag"]).to include("noindex")
    end

    it "redirects a differently cased permalink to the stored one", parity: true do
      get "/l/#{product.unique_permalink.upcase}"

      expect(response).to have_http_status(:moved_permanently)
    end

    it "redirects the pre-coffee page of a coffee product", parity: true do
      coffee = create(:coffee_product, user: seller)

      get "/l/#{coffee.unique_permalink}?native=true&wanted=true"

      expect(response).to have_http_status(:moved_permanently)
    end

    it "is a 404 for a banned product", parity: true do
      product.update!(banned_at: Time.current)

      get "/l/#{product.unique_permalink}"

      expect(response).to have_http_status(:not_found)
    end

    it "is a 404 for a deleted product", parity: true do
      product.mark_deleted!

      get "/l/#{product.unique_permalink}"

      expect(response).to have_http_status(:not_found)
    end

    it "is a 404 for a product of a deleted seller", parity: true do
      product
      seller.update_columns(deleted_at: Time.current)

      get "/l/#{product.unique_permalink}"

      expect(response).to have_http_status(:moved_permanently).or have_http_status(:not_found)
    end

    it "serves a product found through its legacy permalink", parity: true do
      LegacyPermalink.create!(permalink: "old-name", product:)

      get "/l/old-name"

      expect(response).to have_http_status(:moved_permanently)
    end

    it "keeps the redirect for a signed-in visitor", parity: true do
      host! DOMAIN
      log_in(buyer, token_path: "/help")

      get "/l/#{product.unique_permalink}"

      expect(response).to have_http_status(:moved_permanently)
    end

    it "sends a coffee product to the custom domain coffee page", parity: true do
      coffee = create(:coffee_product, user: seller)

      get "/l/#{coffee.unique_permalink}"

      expect(response).to have_http_status(:moved_permanently)
    end
  end

  describe "on a seller subdomain" do
    before { seller_host! }

    it "renders a digital product", parity: true do
      product = create(:product_with_pdf_file, user: seller, name: "Digital thing", price_cents: 500)

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]).to include("name" => "Digital thing", "price_cents" => 500)
    end

    it "renders an ebook with its book files in the structured data", parity: true do
      product = create(:product_with_pdf_file, user: seller, name: "Ebook thing", price_cents: 500, native_type: Link::NATIVE_TYPE_EBOOK)
      product.alive_product_files.first.update!(isbn: "978-3-16-148410-0")

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["native_type"]).to eq("ebook")
      expect(response.body).to include("workExample")
    end

    it "renders a euro product with its price converted to dollars in the structured data", parity: true do
      product = create(:product, user: seller, name: "Euro thing", price_cents: 1250, price_currency_type: "eur")

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]).to include("name" => "Euro thing", "currency_code" => "eur", "price_cents" => 1250)
      expect(response.body).to include("\"priceCurrency\":\"USD\"")
      expect(response.body).to include("product:price:currency")
    end

    it "renders a product by its custom permalink", parity: true do
      create(:product, user: seller, name: "Custom", custom_permalink: "custom-one")

      get "/l/custom-one"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["name"]).to eq("Custom")
    end

    it "renders a tiered membership with its tiers", parity: true do
      product = create(:membership_product_with_preset_tiered_pricing, user: seller, name: "Membership")

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["options"].size).to eq(2)
    end

    it "renders a membership with a free trial", parity: true do
      product = create(:membership_product, :with_free_trial_enabled, user: seller, name: "Trial membership")

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["free_trial"]).to be_present
    end

    it "renders a versioned product", parity: true do
      product = create(:product_with_digital_versions_with_price_difference_cents, user: seller, name: "Versions")

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["options"].size).to eq(2)
    end

    it "renders a physical product with SKUs", parity: true do
      product = create(:physical_product, user: seller, name: "Physical")

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["is_physical"]).to eq(true)
    end

    it "renders a bundle with its products", parity: true do
      product = create(:product, :bundle, user: seller)

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["bundle_products"].size).to eq(2)
    end

    it "renders a call product", parity: true do
      product = create(:call_product, :available_for_a_year, user: seller, name: "Call")

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["native_type"]).to eq("call")
    end

    it "renders a commission product", parity: true do
      product = create(:commission_product, user: seller, name: "Commission")

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["native_type"]).to eq("commission")
    end

    it "sends a coffee product to the coffee page", parity: true do
      product = create(:coffee_product, user: seller)

      get "/l/#{product.unique_permalink}?wanted=true"

      expect(response).to have_http_status(:found)
    end

    it "renders a preorder", parity: true do
      product = create(:product, user: seller, name: "Preorder")
      create(:preorder_link, link: product, release_at: 1.month.from_now)
      product.update!(is_in_preorder_state: true)

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["preorder"]).to be_present
    end

    it "renders a pay-what-you-want product", parity: true do
      product = create(:product, user: seller, name: "PWYW", price_cents: 0, customizable_price: true, suggested_price_cents: 300)

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["pwyw"]).to be_present
    end

    it "renders a product whose covers are Unsplash photos", parity: true do
      product = create(:product, user: seller, name: "Pictured")
      AssetPreview.create!(link: product, unsplash_url: "https://images.example.com/photo.jpg", guid: "pagecoverone")
      AssetPreview.create!(link: product, unsplash_url: "https://images.example.com/second.jpg", guid: "pagecovertwo")

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["main_cover_id"]).to eq("pagecoverone")
      expect(response.body).to include("summary_large_image")
    end

    it "renders an ebook whose cover is an Unsplash photo", parity: true do
      product = create(:product_with_pdf_file, user: seller, name: "Pictured ebook", price_cents: 500, native_type: Link::NATIVE_TYPE_EBOOK)
      AssetPreview.create!(link: product, unsplash_url: "https://images.example.com/book.jpg", guid: "pagebookcover")

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(response.body).to include("https://images.example.com/book.jpg")
    end

    # Rails.cache keys the cover URLs by attachment id, and the replay's Next.js process keeps its cache across fixtures while the
    # database restarts at id 1, so each upload example takes a different attachment id.
    def burn_attachment_ids(count)
      count.times { |index| create(:asset_preview_jpg, link: create(:product, user: seller, name: "Spare #{index}")) }
    end

    it "renders a product whose cover is an uploaded image the retina worker has not processed", parity: true do
      product = create(:product, user: seller, name: "Uploaded cover")
      create(:asset_preview_jpg, link: product, guid: "pageuploadedcover")
      ProcessAssetPreviewRetinaWorker.jobs.clear

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      cover = inertia_props_of(response)["product"]["covers"].first
      expect(cover).to include("type" => "image", "filetype" => "jpg")
    end

    it "renders a product whose cover is an uploaded image with a processed retina variant", parity: true do
      burn_attachment_ids(1)
      product = create(:product, user: seller, name: "Retina cover")
      preview = create(:asset_preview_jpg, link: product, guid: "pageretinacover")
      preview.retina_variant.processed
      Rails.cache.clear
      ProcessAssetPreviewRetinaWorker.jobs.clear

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      cover = inertia_props_of(response)["product"]["covers"].first
      expect(cover["url"]).not_to eq(cover["original_url"])
      expect(ProcessAssetPreviewRetinaWorker.jobs.size).to eq(0)
    end

    it "renders a product whose cover is an uploaded GIF", parity: true do
      burn_attachment_ids(2)
      product = create(:product, user: seller, name: "Animated cover")
      create(:asset_preview_gif, link: product, guid: "pagegifcover")

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      cover = inertia_props_of(response)["product"]["covers"].first
      expect(cover).to include("type" => "image", "filetype" => "gif")
      expect(cover["url"]).to eq(cover["original_url"])
    end

    it "renders a product whose cover is an uploaded image the analyzer wrote no dimensions for", parity: true do
      burn_attachment_ids(3)
      product = create(:product, user: seller, name: "Unanalyzed cover")
      preview = create(:asset_preview_jpg, link: product, guid: "pageunanalyzedcover")
      blob = preview.file.blob
      blob.update_column(:metadata, { identified: true, analyzed: true })
      ProcessAssetPreviewRetinaWorker.jobs.clear

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      cover = inertia_props_of(response)["product"]["covers"].first
      expect(cover).to include("type" => "image", "width" => nil, "height" => nil, "native_width" => nil, "native_height" => nil)
    end

    it "renders a product whose cover is an uploaded image with a width and no height", parity: true do
      burn_attachment_ids(4)
      product = create(:product, user: seller, name: "Half analyzed cover")
      preview = create(:asset_preview_jpg, link: product, guid: "pagehalfanalyzedcover")
      blob = preview.file.blob
      blob.update_column(:metadata, { identified: true, analyzed: true, width: 25 })
      ProcessAssetPreviewRetinaWorker.jobs.clear

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      cover = inertia_props_of(response)["product"]["covers"].first
      expect(cover).to include("height" => nil, "native_height" => nil)
      expect(cover["width"]).to be_present
    end

    it "renders a product whose cover is a YouTube video", parity: true do
      product = create(:product, user: seller, name: "Video cover")
      create(:asset_preview_youtube, link: product, guid: "pageyoutubecover")

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      cover = inertia_props_of(response)["product"]["covers"].first
      expect(cover).to include("type" => "oembed", "native_width" => 356, "width" => 356, "height" => 200)
      expect(cover["url"]).to include("enablejsapi=1")
      expect(response.body).to include("twitter:player")
    end

    it "renders a product whose cover is a Vimeo video with a protocol-relative player and a scaled size", parity: true do
      product = create(:product, user: seller, name: "Vimeo cover")
      create(:asset_preview, attach: false, link: product, guid: "pagevimeocover", oembed: {
        "html" => "<iframe src=\"//player.vimeo.com/video/76979871\" width=\"1280\" height=\"720\" frameborder=\"0\"></iframe>",
        "info" => { "width" => 1280, "height" => 721, "thumbnail_url" => "https://i.vimeocdn.com/video/452001751_640.jpg?mw=1&x=2" }
      })

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      cover = inertia_props_of(response)["product"]["covers"].first
      expect(cover).to include("url" => "https://player.vimeo.com/video/76979871?api=1", "width" => 670, "height" => 377)
      expect(response.body).to include("og:image")
    end

    it "renders a product whose oEmbed cover reports a width that is not a number", parity: true do
      product = create(:product, user: seller, name: "Odd cover")
      create(:asset_preview, attach: false, link: product, guid: "pageoddcover", oembed: {
        "html" => "<IFRAME SRC='https://example.com/player?x=1&y=2'></IFRAME>",
        "info" => { "width" => "auto", "height" => "300px", "thumbnail_url" => "  https://example.com/thumb.png  " }
      })

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      cover = inertia_props_of(response)["product"]["covers"].first
      expect(cover).to include("url" => "https://example.com/player?x=1&y=2", "thumbnail" => "https://example.com/thumb.png", "width" => nil, "height" => nil, "native_width" => 0, "native_height" => 300)
    end

    it "renders an oEmbed cover whose document has a comment before the player", parity: true do
      product = create(:product, user: seller, name: "Commented cover")
      create(:asset_preview, attach: false, link: product, guid: "pagecommentcover", oembed: {
        "html" => "<!-- player --><iframe src=\"https://example.com/player\"></iframe>",
        "info" => { "width" => 640, "height" => 360, "thumbnail_url" => "https://example.com/thumb.png" }
      })

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      cover = inertia_props_of(response)["product"]["covers"].first
      expect(cover).to include("url" => "https://example.com/player")
    end

    it "renders an oEmbed cover whose comment holds another player", parity: true do
      product = create(:product, user: seller, name: "Hidden player cover")
      create(:asset_preview, attach: false, link: product, guid: "pagehiddencover", oembed: {
        "html" => "<div><!-- <iframe src=\"https://example.com/decoy\"></iframe> --><iframe src=\"https://example.com/real\"></iframe></div>",
        "info" => { "width" => 640, "height" => 360, "thumbnail_url" => "https://example.com/thumb.png" }
      })

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      cover = inertia_props_of(response)["product"]["covers"].first
      expect(cover).to include("url" => "https://example.com/real")
    end

    it "renders an oEmbed cover whose player URL has character references", parity: true do
      product = create(:product, user: seller, name: "Entity cover")
      create(:asset_preview, attach: false, link: product, guid: "pageentitycover", oembed: {
        "html" => "<iframe src=\"https://example.com/player?a=1&amp;b=2&#38;c=3&quot;&lt;&gt;\"></iframe>",
        "info" => { "width" => 640, "height" => 360, "thumbnail_url" => "https://example.com/thumb.png" }
      })

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      cover = inertia_props_of(response)["product"]["covers"].first
      expect(cover["url"]).to start_with("https://example.com/player?a=1&b=2&c=3")
    end

    it "renders an oEmbed cover with a player and no thumbnail", parity: true do
      product = create(:product, user: seller, name: "No thumbnail cover")
      create(:asset_preview, attach: false, link: product, guid: "pagenothumbcover", oembed: {
        "html" => "<iframe src=\"https://example.com/player\"></iframe>",
        "info" => { "width" => 640, "height" => 360 }
      })

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["covers"].first).to include("thumbnail" => nil)
    end

    it "renders an oEmbed cover with a thumbnail and no player", parity: true do
      product = create(:product, user: seller, name: "No player cover")
      preview = create(:asset_preview, attach: false, link: product, guid: "pagenoplayercover", oembed: {
        "html" => "<iframe src=\"https://example.com/player\"></iframe>",
        "info" => { "width" => 640, "height" => 360, "thumbnail_url" => "https://example.com/thumb.png" }
      })
      # Creation demands a player; a document saved before that rule, or edited since, can lack one.
      preview.update_column(:oembed, { "html" => "<p>no player</p>", "info" => { "width" => 640, "height" => 360, "thumbnail_url" => "https://example.com/thumb.png" } })

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["covers"].first).to include("url" => nil)
    end

    it "renders an oEmbed cover with neither a player nor a thumbnail", parity: true do
      product = create(:product, user: seller, name: "Bare cover")
      preview = create(:asset_preview, attach: false, link: product, guid: "pagebarecover", oembed: {
        "html" => "<iframe src=\"https://example.com/player\"></iframe>",
        "info" => { "width" => 640, "height" => 360 }
      })
      preview.update_column(:oembed, { "html" => "<p>no player</p>", "info" => { "width" => 640, "height" => 360 } })

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["covers"].first).to include("url" => nil, "thumbnail" => nil)
    end

    it "hands an oEmbed cover whose thumbnail Addressable would re-encode to Rails", parity: true do
      product = create(:product, user: seller, name: "Spaced cover")
      create(:asset_preview, attach: false, link: product, guid: "pagespacedcover", oembed: {
        "html" => "<iframe src=\"https://example.com/player\"></iframe>",
        "info" => { "width" => 640, "height" => 360, "thumbnail_url" => "https://example.com/a b.png" }
      })

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(response.body).to include("https://example.com/a%20b.png")
    end

    it "renders the waitlist of an unpublished product to a visitor", parity: true do
      product = create(:product, user: seller, name: "Coming soon", draft: true, waitlist_enabled: true)

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["waitlist"]).to include("count" => nil)
    end

    it "renders an unpublished product with a noindex header", parity: true do
      product = create(:product, :unpublished, user: seller, name: "Draft")

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(response.headers["X-Robots-Tag"]).to include("noindex")
    end

    it "renders a deleted product with a noindex header", parity: true do
      product = create(:product, user: seller, name: "Deleted")
      product.mark_deleted!

      get "/l/#{product.unique_permalink}"
    end

    it "renders an adult product", parity: true do
      product = create(:product, user: seller, name: "Adult", is_adult: true)

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
    end

    it "is a 404 for a banned product", parity: true do
      product = create(:product, user: seller)
      product.update!(banned_at: Time.current)

      get "/l/#{product.unique_permalink}"

      expect(response).to have_http_status(:not_found)
    end

    it "is a 404 for a product of a deleted seller", parity: true do
      product = create(:product, user: seller)
      seller.update_columns(deleted_at: Time.current)

      get "/l/#{product.unique_permalink}"

      expect(response).to have_http_status(:not_found)
    end

    it "shows the ratings and the sales count", parity: true, elasticsearch_wait_for_refresh: true do
      product = create(:product, user: seller, name: "Rated", price_cents: 0, should_show_sales_count: true)
      purchase = create(:free_purchase, link: product)
      create(:product_review, purchase:, rating: 4)
      Purchase.__elasticsearch__.create_index!(force: true)
      index_model_records(Purchase)

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["ratings"]).to be_present
      expect(inertia_props_of(response)["product"]["sales_count"]).to eq(1)
    end

    it "shows a limited quantity remaining", parity: true do
      product = create(:product, user: seller, name: "Limited", price_cents: 0, max_purchase_count: 10)
      create(:free_purchase, link: product)

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["quantity_remaining"]).to eq(9)
    end

    it "shows the product's refund policy", parity: true do
      product = create(:product, user: seller, name: "Refundable")
      product.update!(product_refund_policy_enabled: true)
      product.find_or_initialize_product_refund_policy.update!(max_refund_period_in_days: 14, fine_print: "No refunds on tuesdays")

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
    end

    it "credits the product's collaborator as a co-creator", parity: true do
      product = create(:product, user: seller, name: "Shared", is_collab: true)
      affiliate_user = create(:affiliate_user, name: "Parity Collaborator")
      create(:collaborator, seller:, affiliate_user:, products: [product])

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["collaborating_user"]).to include("name" => "Parity Collaborator")
    end

    it "does not credit a collaborator who opted out of the co-creator credit on every product", parity: true do
      product = create(:product, user: seller, name: "Shared", is_collab: true)
      collaborator = create(:collaborator, seller:, products: [product])
      collaborator.update!(dont_show_as_co_creator: true)

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["collaborating_user"]).to be_nil
    end

    it "does not credit a collaborator who opted out of the co-creator credit on this product", parity: true do
      product = create(:product, user: seller, name: "Shared", is_collab: true)
      collaborator = create(:collaborator, seller:, apply_to_all_products: false)
      create(:product_affiliate, product:, affiliate: collaborator, affiliate_basis_points: 30_00, dont_show_as_co_creator: true)

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["collaborating_user"]).to be_nil
    end

    it "does not credit a collaborator whose invitation is still pending", parity: true do
      product = create(:product, user: seller, name: "Shared", is_collab: true)
      create(:collaborator, :with_pending_invitation, seller:, products: [product])

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["collaborating_user"]).to be_nil
    end

    it "applies the offer code of the path", parity: true do
      product = create(:product, user: seller, name: "Discounted", price_cents: 1000)
      create(:offer_code, user: seller, products: [product], code: "half", amount_cents: nil, amount_percentage: 50)

      get "/l/#{product.unique_permalink}/half"

      expect(response).to be_successful
      expect(inertia_props_of(response)["discount_code"]).to include("valid" => true)
    end

    it "applies the code query parameter", parity: true do
      product = create(:product, user: seller, name: "Discounted", price_cents: 1000)
      create(:offer_code, user: seller, products: [product], code: "five", amount_cents: 500)

      get "/l/#{product.unique_permalink}?code=five&quantity=2"

      expect(response).to be_successful
      expect(inertia_props_of(response)["discount_code"]).to include("valid" => true)
    end

    it "reports an invalid code", parity: true do
      product = create(:product, user: seller)

      get "/l/#{product.unique_permalink}?code=nope"

      expect(response).to be_successful
      expect(inertia_props_of(response)["discount_code"]).to include("valid" => false)
    end

    it "shows the seller's auto-applied sale", parity: true do
      product = create(:product, user: seller, name: "On sale", price_cents: 1000)
      create(:universal_offer_code, user: seller, code: "sale", amount_cents: nil, amount_percentage: 20, auto_apply: true, sale_label: "Spring sale")

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
    end

    it "sets the affiliate cookie of an affiliate_id", parity: true do
      product = create(:product, user: seller)
      affiliate = create(:direct_affiliate, seller:, products: [product])

      get "/l/#{product.unique_permalink}?affiliate_id=#{affiliate.external_id_numeric}"

      expect(response).to be_successful
      expect(set_cookies).to include(affiliate.cookie_key)
    end

    it "ignores an unknown affiliate", parity: true do
      product = create(:product, user: seller)

      get "/l/#{product.unique_permalink}?a=999999"

      expect(response).to be_successful
    end

    it "marks a code URL as noindex", parity: true do
      product = create(:product, user: seller)

      get "/l/#{product.unique_permalink}/anything"

      expect(response.headers["X-Robots-Tag"]).to include("noindex")
    end

    it "redirects ?wanted=true to checkout", parity: true do
      product = create(:product, user: seller, price_cents: 700)

      get "/l/#{product.unique_permalink}?wanted=true"

      expect(response).to have_http_status(:found)
    end

    it "renders the page for a wanted value other than true", parity: true do
      product = create(:product, user: seller, name: "Not wanted", price_cents: 700)

      get "/l/#{product.unique_permalink}?wanted=false"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]).to include("name" => "Not wanted")
    end

    describe "with a review-reminder link" do
      let(:product) { create(:product, user: seller, name: "Reminded", price_cents: 700) }
      let(:purchase) do
        build(:purchase, link: product, email: "reminded@example.com", purchase_state: "successful").tap { |sale| sale.save!(validate: false) }
      end

      it "renders the page when the link carries a purchase and no digest", parity: true do
        get "/l/#{product.unique_permalink}?purchase_id=#{purchase.external_id}"

        expect(response).to be_successful
        expect(inertia_props_of(response)["purchase"]).to be_nil
      end

      it "renders the page when the digest belongs to no purchase", parity: true do
        get "/l/#{product.unique_permalink}?purchase_id=#{purchase.external_id}&purchase_email_digest=wrong"

        expect(response).to be_successful
        expect(inertia_props_of(response)["purchase"]).to be_nil
      end

      it "renders the page when the purchase id is unknown", parity: true do
        get "/l/#{product.unique_permalink}?purchase_id=unknown&purchase_email_digest=#{purchase.email_digest}"

        expect(response).to be_successful
        expect(inertia_props_of(response)["purchase"]).to be_nil
      end

      it "renders the page when the purchase belongs to another product", parity: true do
        other = create(:product, user: seller, name: "Other", price_cents: 700)

        get "/l/#{other.unique_permalink}?purchase_id=#{purchase.external_id}&purchase_email_digest=#{purchase.email_digest}"

        expect(response).to be_successful
        expect(inertia_props_of(response)["purchase"]).to be_nil
      end

      it "hands a matching purchase and digest to Rails", parity: true do
        get "/l/#{product.unique_permalink}?purchase_id=#{purchase.external_id}&purchase_email_digest=#{purchase.email_digest}"

        expect(response).to be_successful
        expect(inertia_props_of(response)["purchase"]).to be_present
      end
    end

    it "renders the iframe layout for embeds", parity: true do
      product = create(:product, user: seller)

      get "/l/#{product.unique_permalink}?embed=true"

      expect(response).to be_successful
    end

    it "renders the iframe layout for an overlay", parity: true do
      product = create(:product, user: seller)

      get "/l/#{product.unique_permalink}?overlay=true"

      expect(response).to be_successful
    end

    it "renders the iframe layout of a call product", parity: true do
      product = create(:call_product, :available_for_a_year, user: seller, name: "Call")

      get "/l/#{product.unique_permalink}?embed=true"

      expect(response).to be_successful
    end

    it "renders the profile layout", parity: true do
      product = create(:product, user: seller)

      get "/l/#{product.unique_permalink}?layout=profile"

      expect(response).to be_successful
    end

    it "renders the profile layout with an offer code and the bundle's product links", parity: true do
      product = create(:product, :bundle, user: seller)

      get "/l/#{product.unique_permalink}/sxsw?layout=profile&recommended_by=library"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["bundle_products"].first["url"]).to include("layout=profile")
    end

    it "prefers the layout over embed", parity: true do
      product = create(:product, user: seller)

      get "/l/#{product.unique_permalink}?layout=profile&embed=true"

      expect(response).to be_successful
    end

    it "renders the standard page for an unknown layout", parity: true do
      product = create(:product, user: seller)

      get "/l/#{product.unique_permalink}?layout=something"

      expect(response).to be_successful
    end

    describe "with the discover layout" do
      before do
        root = Taxonomy.create!(slug: "3d")
        modeling = Taxonomy.create!(slug: "3d-modeling", parent: root)
        [root, modeling].each { |record| TaxonomyStat.create!(taxonomy: record, recent_sales_count: record.id) }
      end

      it "renders the taxonomy path and the navigation", parity: true do
        product = create(:product, user: seller, taxonomy: Taxonomy.find_by!(slug: "3d-modeling"))

        get "/l/#{product.unique_permalink}?layout=discover"

        expect(response).to be_successful
        expect(inertia_props_of(response)["taxonomy_path"]).to eq("3d/3d-modeling")
      end

      it "renders a product without a taxonomy", parity: true do
        product = create(:product, user: seller)

        get "/l/#{product.unique_permalink}?layout=discover"

        expect(response).to be_successful
        expect(inertia_props_of(response)["taxonomy_path"]).to be_nil
      end

      it "answers the search box's autocomplete request with the suggestions alone", parity: true do
        product = create(:product, user: seller)

        get "/l/#{product.unique_permalink}?layout=discover&query=blender", headers: {
          "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest",
          "X-Inertia-Partial-Component" => "Products/Discover/Show", "X-Inertia-Partial-Data" => "autocomplete_results"
        }

        expect(response).to be_successful
        expect(response.parsed_body["props"].keys).to include("autocomplete_results")
      end

      context "for a visitor with curated products" do
        let(:product) { create(:product, user: seller, name: "Viewed") }
        let(:other_seller) { create(:user, name: "Curated Seller") }
        let(:visitor) { create(:user, name: "Curated Visitor") }

        # Roots that outrank "3d" in the default order, so a curated "3d" or "writing" product moves it.
        before do
          design = Taxonomy.create!(slug: "design")
          writing = Taxonomy.create!(slug: "writing")
          TaxonomyStat.create!(taxonomy: design, recent_sales_count: 500)
          TaxonomyStat.create!(taxonomy: writing, recent_sales_count: 400)
        end

        def curated(name, slug)
          create(:product, user: other_seller, name:, taxonomy: Taxonomy.find_by!(slug:))
        end

        def relate(seed, related)
          CachedSalesRelatedProductsInfo.create!(product: seed, counts: related.transform_keys { _1.id.to_s })
        end

        def seed_product(name = "Seed") = create(:product, user: other_seller, name:)

        def buy(seed)
          build(:purchase, purchaser: visitor, link: seed, purchase_state: "successful").save!(validate: false)
        end

        def visit_signed_in
          host! DOMAIN
          log_in(visitor, token_path: "/help")
          seller_host!
          get "/l/#{product.unique_permalink}?layout=discover"
        end

        def nav_slugs = inertia_props_of(response)["taxonomies_for_nav"].map { _1["slug"] }

        it "orders the navigation by the roots of a buyer's curated products", parity: true do
          seed = seed_product
          relate(seed, curated("Modeling pick", "3d-modeling") => 5, curated("Writing pick", "writing") => 3)
          buy(seed)

          visit_signed_in

          expect(response).to be_successful
          expect(nav_slugs.first(3)).to eq(%w[3d writing design])
        end

        it "orders the navigation by the cart of a signed-in visitor", parity: true do
          seed = seed_product
          relate(seed, curated("Writing pick", "writing") => 3)
          create(:cart_product, cart: create(:cart, user: visitor), product: seed)

          visit_signed_in

          expect(response).to be_successful
          expect(nav_slugs.first).to eq("writing")
        end

        it "orders the navigation by the cart of a guest", parity: true do
          cookies[:_gumroad_guid] = "product-guest-guid"
          seed = seed_product
          relate(seed, curated("Writing pick", "writing") => 3)
          create(:cart_product, cart: create(:cart, :guest, browser_guid: "product-guest-guid"), product: seed)

          get "/l/#{product.unique_permalink}?layout=discover"

          expect(response).to be_successful
          expect(nav_slugs.first).to eq("writing")
        end

        it "sums the counts of three seeds and keeps the better seller's root first", parity: true do
          first, second, third = Array.new(3) { |index| seed_product("Seed #{index}") }
          writing = curated("Writing pick", "writing")
          modeling = curated("Modeling pick", "3d-modeling")
          relate(first, writing => 2, modeling => 1)
          relate(second, modeling => 2)
          relate(third, modeling => 1)
          cart = create(:cart, user: visitor)
          [first, second].each { create(:cart_product, cart:, product: _1) }
          buy(third)

          visit_signed_in

          expect(response).to be_successful
          expect(nav_slugs.first(2)).to eq(%w[3d writing])
        end

        it "leaves the navigation alone when the seeds have no related products", parity: true do
          create(:cart_product, cart: create(:cart, user: visitor), product: seed_product)

          visit_signed_in

          expect(response).to be_successful
          expect(nav_slugs.first).to eq("design")
        end

        it "leaves the navigation alone when the curated products have no category", parity: true do
          seed = seed_product
          relate(seed, create(:product, user: other_seller, name: "Uncategorized") => 3)
          buy(seed)

          visit_signed_in

          expect(response).to be_successful
          expect(nav_slugs.first).to eq("design")
        end

        it "hands a visitor with four products in the cart to Rails", parity: true do
          cart = create(:cart, user: visitor)
          Array.new(4) { |index| create(:cart_product, cart:, product: seed_product("Seed #{index}")) }

          visit_signed_in

          expect(response).to be_successful
        end

        it "hands a visitor with three purchases and a cart product to Rails", parity: true do
          Array.new(3) { |index| buy(seed_product("Bought #{index}")) }
          create(:cart_product, cart: create(:cart, user: visitor), product: seed_product("Carted"))

          visit_signed_in

          expect(response).to be_successful
        end
      end

      it "renders a storefront seller's product without the catalogue", parity: true do
        seller.update!(product_page_storefront_enabled: true)
        product = create(:product, user: seller)

        get "/l/#{product.unique_permalink}?layout=discover"

        expect(response).to be_successful
      end
    end

    describe "arriving from Discover" do
      let(:product) { create(:product, user: seller, name: "Clicked", taxonomy: Taxonomy.create!(slug: "design")) }

      before do
        Feature.activate(:store_discover_searches)
        cookies[:_gumroad_guid] = "discover-click-guid" unless RSpec.current_example.metadata[:signed_in]
      end

      it "stores a search click on the product with the product's own category", parity: true do
        expect { get "/l/#{product.unique_permalink}?recommended_by=search&query=rig+kit" }.to change(DiscoverSearch, :count).by(1)

        expect(response).to be_successful
        search = DiscoverSearch.last
        expect(search).to have_attributes(query: "rig kit", clicked_resource: product, taxonomy_id: product.taxonomy_id, autocomplete: false)
        expect(search.discover_search_suggestion).to be_present
      end

      it "stores a Discover click that carries no query", parity: true do
        expect { get "/l/#{product.unique_permalink}?recommended_by=discover" }.to change(DiscoverSearch, :count).by(1)

        expect(response).to be_successful
        expect(DiscoverSearch.last.query).to be_nil
      end

      it "stores an autocomplete click without a suggestion", parity: true do
        get "/l/#{product.unique_permalink}?recommended_by=search&query=rig&autocomplete=true"

        expect(response).to be_successful
        expect(DiscoverSearch.last).to have_attributes(autocomplete: true, discover_search_suggestion: nil)
      end

      it "stores a click of a signed-in buyer on a product without a category", parity: true, signed_in: true do
        product.update!(taxonomy: nil)
        host! DOMAIN
        log_in(buyer, token_path: "/help")
        seller_host!
        # Logging in sets the guid the click is attributed to.

        get "/l/#{product.unique_permalink}?recommended_by=search&query=rig"

        expect(response).to be_successful
        expect(DiscoverSearch.last).to have_attributes(user_id: buyer.id, taxonomy_id: nil)
      end

      it "stores a click on the Inertia visit", parity: true do
        inertia_visit "/l/#{product.unique_permalink}?recommended_by=discover&query=kit"

        expect(response).to be_successful
        expect(DiscoverSearch.count).to eq(1)
      end

      it "stores nothing for a crawler", parity: true do
        get "/l/#{product.unique_permalink}?recommended_by=search&query=rig", headers: { "User-Agent" => "Googlebot/2.1" }

        expect(response).to be_successful
        expect(DiscoverSearch.count).to eq(0)
      end

      it "stores nothing while the flag is off", parity: true do
        Feature.deactivate(:store_discover_searches)

        get "/l/#{product.unique_permalink}?recommended_by=search&query=rig"

        expect(response).to be_successful
        expect(DiscoverSearch.count).to eq(0)
      end

      it "stores nothing for another recommender", parity: true do
        get "/l/#{product.unique_permalink}?recommended_by=library&query=rig"

        expect(response).to be_successful
        expect(DiscoverSearch.count).to eq(0)
      end

      it "hands a nested query back to Rails", parity: true do
        get "/l/#{product.unique_permalink}?recommended_by=search&query[]=rig"

        expect(response).to be_successful
      end
    end

    describe "of a storefront seller", elasticsearch_wait_for_refresh: true do
      let(:product) { create(:product, user: seller, name: "Viewed", price_cents: 700) }

      before do
        seller.update!(product_page_storefront_enabled: true)
        Link.__elasticsearch__.create_index!(force: true)
      end

      def catalogue_page(path = "/l/#{product.unique_permalink}", **options)
        index_model_records(Link)
        get path, **options
      end

      def catalogue_sections
        inertia_props_of(response)["sections"]
      end

      def show_products_section(shown, **attributes)
        section = create(:seller_profile_products_section, seller:, header: "Shop", shown_products: shown.map(&:id), **attributes)
        seller.seller_profile.json_data[:tabs] = [{ name: "Home", sections: [section.id] }]
        seller.seller_profile.save!
        section
      end

      it "shows the rest of the catalogue under the product, headed by the seller's name", parity: true do
        create(:product, user: seller, name: "Other one", price_cents: 300)
        create(:product, user: seller, name: "Other two", price_cents: 400)

        catalogue_page

        expect(response).to be_successful
        expect(response.body).to include("Products/Profile/Show")
        section = catalogue_sections.first
        expect(section["header"]).to eq("More from #{seller.name_or_username}")
        expect(section["search_results"]["products"].map { _1["name"] }).to match_array(["Other one", "Other two"])
        expect(section["exclude_ids"]).to eq([product.external_id])
      end

      it "shows an empty catalogue when the viewed product is the only one", parity: true do
        catalogue_page

        expect(response).to be_successful
        expect(catalogue_sections.first["search_results"]).to include("total" => 0, "products" => [])
      end

      it "leaves a sold-out product that hides its sold-out state out of the catalogue", parity: true do
        sold_out = create(:product, user: seller, name: "Sold out", max_purchase_count: 1, hide_sold_out_variants: true)
        build(:purchase, link: sold_out, seller:, purchase_state: "successful").save!(validate: false)
        create(:product, user: seller, name: "Available")

        catalogue_page

        expect(response).to be_successful
        expect(catalogue_sections.first["search_results"]["products"].map { _1["name"] }).to eq(["Available"])
      end

      it "shows the seller's saved products sections instead of the default one", parity: true do
        shown = create(:product, user: seller, name: "Shown")
        create(:product, user: seller, name: "Not shown")
        show_products_section([shown, product])

        catalogue_page

        expect(response).to be_successful
        section = catalogue_sections.first
        expect(section["header"]).to eq("Shop")
        expect(section["search_results"]["products"].map { _1["name"] }).to eq(["Shown"])
        expect(section["search_results"]["total"]).to eq(1)
      end

      it "keeps a hidden header of a saved section hidden", parity: true do
        shown = create(:product, user: seller, name: "Shown")
        show_products_section([shown], hide_header: true)

        catalogue_page

        expect(response).to be_successful
        expect(catalogue_sections.first["header"]).to be_nil
      end

      it "shrinks the total for a viewed product beyond the fetched page", parity: true do
        product.update_columns(created_at: 10.days.ago)
        3.times { |n| create(:product, user: seller, name: "Other #{n}", created_at: (n + 1).days.ago) }

        catalogue_page("/l/#{product.unique_permalink}?size=1")

        expect(response).to be_successful
        expect(catalogue_sections.first["search_results"]["products"].map { _1["name"] }).to eq(["Other 0"])
        expect(catalogue_sections.first["search_results"]["total"]).to eq(3)
      end

      it "shrinks the total for a viewed product on the fetched page", parity: true do
        3.times { |n| create(:product, user: seller, name: "Other #{n}", created_at: (n + 1).days.ago) }

        catalogue_page("/l/#{product.unique_permalink}?size=1")

        expect(response).to be_successful
        expect(catalogue_sections.first["search_results"]["products"]).to eq([])
        expect(catalogue_sections.first["search_results"]["total"]).to eq(3)
      end

      it "applies the visitor's filters to the catalogue", parity: true do
        create(:product, user: seller, name: "Alpha ebook")
        create(:product, user: seller, name: "Beta course")

        catalogue_page("/l/#{product.unique_permalink}?query=alpha&sort=price_asc")

        expect(response).to be_successful
        expect(catalogue_sections.first["search_results"]["products"].map { _1["name"] }).to eq(["Alpha ebook"])
      end

      it "shows a membership with tiers in the catalogue", parity: true do
        create(:membership_product_with_preset_tiered_pricing, user: seller, name: "Membership")

        catalogue_page

        expect(response).to be_successful
      end

      it "wraps the profile layout with the catalogue as well", parity: true do
        create(:product, user: seller, name: "Other one")

        catalogue_page("/l/#{product.unique_permalink}?layout=profile")

        expect(response).to be_successful
        expect(catalogue_sections.first["search_results"]["products"].map { _1["name"] }).to eq(["Other one"])
      end

      it "answers an Inertia visit with the profile component", parity: true do
        create(:product, user: seller, name: "Other one")

        index_model_records(Link)
        inertia_visit "/l/#{product.unique_permalink}"

        expect(response.parsed_body["component"]).to eq("Products/Profile/Show")
        expect(response.parsed_body["props"]["sections"].first["search_results"]["products"].size).to eq(1)
      end

      it "keeps the embed layout free of the catalogue", parity: true do
        create(:product, user: seller, name: "Other one")

        catalogue_page("/l/#{product.unique_permalink}?embed=true")

        expect(response).to be_successful
        expect(response.body).to include("Products/Iframe/Show")
      end

      it "keeps the discover layout free of the catalogue", parity: true do
        Taxonomy.create!(slug: "design")
        create(:product, user: seller, name: "Other one")

        catalogue_page("/l/#{product.unique_permalink}?layout=discover")

        expect(response).to be_successful
        expect(catalogue_sections).to eq([])
      end

      it "keeps the seller's own view standalone", parity: true do
        create(:product, user: seller, name: "Other one")
        host! DOMAIN
        log_in(seller, token_path: "/help")
        seller_host!

        catalogue_page

        expect(response).to be_successful
        expect(response.body).to include("Products/Show")
        expect(catalogue_sections).to eq([])
      end

      it "hands a product that has sections of its own to Rails", parity: true do
        section = create(:seller_profile_products_section, seller:, product:, header: "On this product", shown_products: [product.id])
        product.update!(sections: [section.id])

        catalogue_page

        expect(response).to be_successful
      end
    end

    it "answers an Inertia visit with the page as JSON", parity: true do
      product = create(:product, user: seller, name: "Inertia")

      inertia_visit "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(response.parsed_body["component"]).to eq("Products/Show")
    end

    it "answers the public JSON API", parity: true do
      product = create(:product, user: seller, name: "Json")

      get "/l/#{product.unique_permalink}.json"

      expect(response).to be_successful
    end
  end

  describe "on a product's custom domain" do
    it "renders the product at the root", parity: true do
      product = create(:product, user: seller, name: "Own domain")
      create(:custom_domain, domain: "product.example.com", user: nil, product:)
      host! "product.example.com"

      get "/"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["name"]).to eq("Own domain")
    end

    it "renders the product by its permalink", parity: true do
      product = create(:product, user: seller, name: "Own domain")
      create(:custom_domain, domain: "product.example.com", user: nil, product:)
      host! "product.example.com"

      get "/#{product.unique_permalink}"

      expect(response).to be_successful
    end
  end

  describe "signed in" do
    before { create(:product, user: seller, name: "Warm") }

    it "shows a buyer the product they own", parity: true do
      product = create(:product, user: seller, name: "Owned", price_cents: 0)
      create(:free_purchase, link: product, purchaser: buyer, email: buyer.email)
      host! DOMAIN
      log_in(buyer, token_path: "/help")
      seller_host!

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["purchase"]).to be_present
    end

    it "shows the seller their own product with the edit controls", parity: true do
      product = create(:product, user: seller, name: "Mine")
      host! DOMAIN
      log_in(seller, token_path: "/help")
      seller_host!

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["can_edit"]).to eq(true)
    end

    it "lists the viewer's wishlists with what each holds of the product", parity: true do
      product = create(:product, user: seller, name: "Wished")
      holding = create(:wishlist, user: buyer, name: "Holding")
      create(:wishlist_product, wishlist: holding, product:)
      create(:wishlist, user: buyer, name: "Empty")
      create(:wishlist, user: buyer, name: "Gone", deleted_at: 1.day.ago)
      host! DOMAIN
      log_in(buyer, token_path: "/help")
      seller_host!

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["wishlists"].map { _1["name"] }).to eq(%w[Holding Empty])
    end

    it "shows a buyer whose purchase was refunded the product without a purchase", parity: true do
      product = create(:product, user: seller, name: "Refunded", price_cents: 0)
      create(:free_purchase, link: product, purchaser: buyer, email: buyer.email, stripe_refunded: true)
      host! DOMAIN
      log_in(buyer, token_path: "/help")
      seller_host!

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["purchase"]).to be_nil
    end

    it "counts the waitlist of an unpublished product for the seller", parity: true do
      product = create(:product, user: seller, name: "Coming soon", draft: true, waitlist_enabled: true)
      WaitlistEntry.create!(product:, follower: create(:active_follower, user: seller))
      WaitlistEntry.create!(product:, follower: create(:follower, user: seller, confirmed_at: nil))
      host! DOMAIN
      log_in(seller, token_path: "/help")
      seller_host!

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["product"]["waitlist"]).to include("count" => 1)
    end

    it "lists the posts a profile section could show in the seller's edit controls", parity: true do
      product = create(:product, user: seller, name: "Mine")
      create(:audience_post, :published, seller:, shown_on_profile: true, name: "Newer post", published_at: 1.day.ago)
      create(:audience_post, :published, seller:, shown_on_profile: true, name: "Older post", published_at: 3.days.ago)
      create(:audience_post, :published, seller:, shown_on_profile: false, name: "Hidden post")
      host! DOMAIN
      log_in(seller, token_path: "/help")
      seller_host!

      get "/l/#{product.unique_permalink}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["posts"].map { _1["name"] }).to eq(["Newer post", "Older post"])
    end
  end
end
