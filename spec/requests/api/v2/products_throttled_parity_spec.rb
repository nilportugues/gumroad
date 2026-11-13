# frozen_string_literal: true

require "spec_helper"

# The v2 routes Rack::Attack throttles that Node now counts through its single counter (nextjs/src/server/controllers/rack-attack.ts):
# Api::V2::LinksController#create, #update (PUT and PATCH), #comps and #preview_custom_html, and Api::V2::MediaController#create.
# Node answers the parameter refusals that precede every write (api-v2/product-writes.ts, api-v2/product-comps.ts) and hands the write,
# the search and the sanitizer back to Rails, which counts the request itself; an example named "hands a ..." records that. Recorded for
# the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/api-v2-throttled.replay.test.ts. "counts ..." reads the keys
# Rack::Attack wrote, "answers 429 ..." puts the first throttle at its limit and expects the refusal.
describe "API v2 throttled routes", type: :request do
  include Parity::ApiV2Requests

  let(:seller) { create(:user, username: "throttled", name: "Throttled", email: "throttled@example.com") }
  let(:token) { api_token(seller, scopes: "edit_products") }
  let(:product) { create(:product, user: seller, name: "Pencil", unique_permalink: "pencil") }
  let(:ip) { "203.0.113.55" }
  let(:ip_headers) { { "CF-Connecting-IP" => ip } }
  let(:redis) { Rack::Attack.cache.store }

  before do
    redis.flushdb
    Rack::Attack.reset!
  end

  after { redis.flushdb }

  def counters = redis.keys("rack::attack:*").sort.to_h { |key| [key.sub(/\Arack::attack:\d+:/, ""), redis.get(key).to_i] }

  def call(verb, path, params: {}, scopes: nil, tok: nil, headers: {}, **options)
    api_call(verb, path, token: tok || (scopes ? api_token(seller, scopes:) : token), params:, as: verb == :get ? nil : :json, headers: ip_headers.merge(headers), **options)
  end

  def message = response.parsed_body["message"]

  # Puts the first throttle of a request on its limit, as a client that has sent that many requests would.
  def fill(path, method:, limit:, host: API_DOMAIN)
    limit.times do
      env = Rack::MockRequest.env_for("http://#{host}#{path}", method:, "HTTP_CF_CONNECTING_IP" => ip)
      Rack::Attack.configuration.throttled?(Rack::Attack::Request.new(env))
    end
  end

  def expect_too_many_requests(max: 64)
    expect(response).to have_http_status(:too_many_requests)
    expect(response.body).to eq("Retry later\n")
    expect(response.headers["Retry-After"].to_i).to be_between(1, max)
  end

  describe "POST /v2/products" do
    it "refuses a type that cannot be created", parity: true do
      call(:post, "/products", params: { name: "Phone", native_type: "physical" })

      expect(message).to eq("The product type 'physical' is not supported for creation.")
    end

    it "refuses a legacy type", parity: true do
      call(:post, "/products", params: { name: "Cast", native_type: "podcast" })

      expect(message).to eq("The product type 'podcast' is not supported for creation.")
    end

    it "refuses an unknown subscription duration", parity: true do
      call(:post, "/products", params: { name: "Club", native_type: "membership", subscription_duration: "weekly" })

      expect(message).to eq("Invalid subscription duration 'weekly'. Valid values: monthly, yearly, quarterly, biannually, every_two_years.")
    end

    it "refuses a subscription duration on a product that is not a membership", parity: true do
      call(:post, "/products", params: { name: "Book", subscription_duration: "yearly" })

      expect(message).to eq("subscription_duration is only valid for membership products.")
    end

    it "refuses a currency Gumroad does not support, echoing what was sent", parity: true do
      call(:post, "/products", params: { name: "Book", price_currency_type: " ZZZ " })

      expect(message).to eq("' ZZZ ' is not a supported currency.")
    end

    it "refuses a blank currency that was supplied", parity: true do
      call(:post, "/products", params: { name: "Book", price_currency_type: "" })

      expect(message).to eq("'' is not a supported currency.")
    end

    it "refuses tags that are not a list of strings", parity: true do
      call(:post, "/products", params: { name: "Book", tags: "a,b" })

      expect(message).to eq("tags must be an array of strings.")
    end

    it "refuses a tag that is not a string", parity: true do
      call(:post, "/products", params: { name: "Book", tags: ["a", 2] })

      expect(message).to eq("tags must be an array of strings.")
    end

    it "refuses an upload field and says how to attach the file", parity: true do
      call(:post, "/products", params: { name: "Book", file: "data" })

      expect(message).to start_with("'file' is not an accepted parameter on POST /v2/products. Upload files with the presign flow")
    end

    it "refuses a cover on creation", parity: true do
      call(:post, "/products", params: { name: "Book", preview: { url: "https://example.com/a.png" } })

      expect(message).to eq("'preview' is not an accepted parameter on POST /v2/products. Covers can only be added after the product is created. Create the product first, then POST to /v2/products/:id/covers with a url or signed_blob_id.")
    end

    it "refuses a thumbnail on creation", parity: true do
      call(:post, "/products", params: { name: "Book", thumbnail: ["x"] })

      expect(message).to eq("'thumbnail' is not an accepted parameter on POST /v2/products. Thumbnails can only be set after the product is created. Create the product first, then POST to /v2/products/:id/thumbnail with a signed_blob_id.")
    end

    it "refuses a taxonomy that does not exist", parity: true do
      call(:post, "/products", params: { name: "Book", taxonomy_id: "999999" })

      expect(message).to eq("Invalid taxonomy_id.")
    end

    it "refuses a taxonomy given as a list", parity: true do
      call(:post, "/products", params: { name: "Book", taxonomy_id: [1] })

      expect(message).to eq("taxonomy_id must be a scalar value.")
    end

    it "refuses a category given as a hash", parity: true do
      call(:post, "/products", params: { name: "Book", category: { a: 1 } })

      expect(message).to eq("category must be a scalar value.")
    end

    it "refuses a category together with a taxonomy", parity: true do
      call(:post, "/products", params: { name: "Book", category: "design", taxonomy_id: "1" })

      expect(message).to eq("Specify either category or taxonomy_id, not both.")
    end

    it "refuses a product-level refund policy on an account with the account-level policy", parity: true do
      seller.update!(refund_policy_enabled: true)

      call(:post, "/products", params: { name: "Book", refund_period: "30" })

      expect(message).to eq("Product-level refund policies are not available for this account; the account-level refund policy applies to all products. Use PUT /v2/refund_policy instead.")
    end

    it "refuses a refund period outside the allowed values", parity: true do
      seller.update!(refund_policy_enabled: false)

      call(:post, "/products", params: { name: "Book", refund_period: "45" })

      expect(message).to eq("refund_period must be one of: inherit, none, 7, 14, 30, 183.")
    end

    it "refuses fine print on a product that has no refund period", parity: true do
      seller.update!(refund_policy_enabled: false)

      call(:post, "/products", params: { name: "Book", refund_fine_print: "Terms" })

      expect(message).to eq("refund_fine_print requires refund_period, or an existing product-level refund policy.")
    end

    it "refuses rich content that is not a list of pages", parity: true do
      call(:post, "/products", params: { name: "Book", rich_content: "text" })

      expect(message).to eq("rich_content must be an array of content page objects.")
    end

    it "refuses a rich content page whose description is a string", parity: true do
      call(:post, "/products", params: { name: "Book", rich_content: [{ title: "One", description: "text" }] })

      expect(message).to eq("Each rich_content page description must be a JSON object or array.")
    end

    it "refuses rich content nodes that are not objects", parity: true do
      call(:post, "/products", params: { name: "Book", rich_content: [{ title: "One", description: { content: ["text"] } }] })

      expect(message).to eq("Each rich_content content node must be a JSON object.")
    end

    it "refuses a rich content description whose content is not a list", parity: true do
      call(:post, "/products", params: { name: "Book", rich_content: [{ title: "One", description: { content: "text" } }] })

      expect(message).to eq("rich_content description content must be an array.")
    end

    it "refuses files that are not a list of objects", parity: true do
      call(:post, "/products", params: { name: "Book", files: "a.zip" })

      expect(message).to eq("files must be an array of file objects.")
    end

    it "refuses a file without a url", parity: true do
      call(:post, "/products", params: { name: "Book", files: [{ display_name: "a" }] })

      expect(message).to eq("Each file must include a url string.")
    end

    it "refuses a file that is not under the seller's uploads", parity: true do
      call(:post, "/products", params: { name: "Book", files: [{ url: "https://example.com/a.zip" }] })

      expect(message).to eq("File URLs must reference your own uploaded files. Use the presigned upload endpoint to upload files first.")
    end

    it "refuses a token without the edit_products scope", parity: true do
      call(:post, "/products", params: { name: "Book" }, scopes: "view_public")

      expect(response).to have_http_status(:forbidden)
    end

    describe "the Rack::Attack throttle" do
      it "counts a refusal in the tiers of the address", parity: true do
        call(:post, "/products", params: { name: "Book", tags: "a" })

        expect(counters.keys).to all(end_with(":#{ip}"))
        expect(counters.size).to eq(5)
        expect(counters.values.uniq).to eq([1])
      end

      it "answers 429 to the eleventh creation of an address in a minute", parity: true do
        travel_to(Time.current.change(usec: 0)) do
          fill("/v2/products", method: "POST", limit: 10)

          call(:post, "/products", params: { name: "Book" })
        end

        expect_too_many_requests
      end
    end
  end

  describe "PUT and PATCH /v2/products/:id" do
    let(:path) { "/products/#{product.external_id}" }

    it "says the product was not found", parity: true do
      call(:put, "/products/missing", params: { name: "x" })

      expect(message).to eq("The product was not found.")
    end

    it "refuses a price on a tiered membership", parity: true do
      tiered = create(:membership_product, user: seller, name: "Club")

      call(:put, "/products/#{tiered.external_id}", params: { price: 5 })

      expect(message).to eq("Price cannot be updated for tiered membership products. Use the variant endpoints to manage tier pricing.")
    end

    it "refuses a currency Gumroad does not support", parity: true do
      call(:put, path, params: { price_currency_type: "zzz" })

      expect(message).to eq("'zzz' is not a supported currency.")
    end

    it "refuses to change the currency of a tiered membership", parity: true do
      tiered = create(:membership_product, user: seller, name: "Club")

      call(:patch, "/products/#{tiered.external_id}", params: { price_currency_type: "eur" })

      expect(message).to eq("Currency cannot be updated for tiered membership products. Use the variant endpoints to manage tier pricing.")
    end

    it "refuses custom HTML on an account without the feature", parity: true do
      Feature.deactivate_user(:custom_html_pages, seller)

      call(:put, path, params: { custom_html: "<p>Hi</p>" })

      expect(message).to eq("You do not have access to custom HTML pages.")
    end

    it "refuses custom HTML that is not a string", parity: true do
      Feature.activate_user(:custom_html_pages, seller)

      call(:put, path, params: { custom_html: ["<p>Hi</p>"] })

      expect(message).to eq("custom_html must be a string.")
    end

    it "refuses custom HTML past the length limit", parity: true do
      Feature.activate_user(:custom_html_pages, seller)

      call(:put, path, params: { custom_html: "a" * (Page::MAX_CUSTOM_HTML_LENGTH + 1) })

      expect(message).to start_with("custom_html is too long (maximum is")
    end

    it "refuses tags that are not a list of strings", parity: true do
      call(:patch, path, params: { tags: { a: 1 } })

      expect(message).to eq("tags must be an array of strings.")
    end

    it "refuses an upload field and says files are a full replacement", parity: true do
      call(:put, path, params: { file: "data" })

      expect(message).to include("'file' is not an accepted parameter on PUT /v2/products/:id.")
      expect(message).to end_with("files is a full replacement — to keep an existing file, include an entry with its id; files missing from the array are removed.")
    end

    it "refuses a cover on the update", parity: true do
      call(:put, path, params: { preview: "x" })

      expect(message).to eq("'preview' is not an accepted parameter on PUT /v2/products/:id. Use POST /v2/products/:id/covers with a url or signed_blob_id to add a cover.")
    end

    it "refuses a taxonomy that does not exist before it looks the product up", parity: true do
      call(:put, "/products/missing", params: { taxonomy_id: "999999" })

      expect(message).to eq("Invalid taxonomy_id.")
    end

    it "refuses rich content that is not a list of pages", parity: true do
      call(:put, path, params: { rich_content: { a: 1 } })

      expect(message).to eq("rich_content must be an array of content page objects.")
    end

    it "refuses files that are not objects", parity: true do
      call(:put, path, params: { files: ["a"] })

      expect(message).to eq("files must be an array of file objects.")
    end

    it "refuses a file entry that carries the internal modified flag", parity: true do
      call(:put, path, params: { files: [{ url: "https://example.com/a", modified: "true" }] })

      expect(message).to eq("'modified' is not an accepted parameter on files[]; it is an internal save-path flag.")
    end

    it "refuses cover ids that are not a list of strings", parity: true do
      call(:put, path, params: { cover_ids: "a" })

      expect(message).to eq("cover_ids must be an array of strings.")
    end

    it "refuses a token without the edit_products scope", parity: true do
      call(:put, path, params: { name: "x" }, scopes: "view_public")

      expect(response).to have_http_status(:forbidden)
    end

    it "hands a name change of a published product with PUT back to Rails", parity: true do
      call(:put, path, params: { name: "Pen" })

      expect(response.parsed_body.dig("product", "name")).to eq("Pen")
    end

    describe "the attributes Node writes" do
      let(:draft) { create(:product, user: seller, name: "Pencil", unique_permalink: "draft", draft: true) }
      let(:draft_path) { "/products/#{draft.external_id}" }

      it "renames a draft with PUT", parity: true do
        call(:put, draft_path, params: { name: "Pen" })

        expect(response.parsed_body.dig("product", "name")).to eq("Pen")
        expect(draft.reload.name).to eq("Pen")
      end

      it "renames an unpublished product with PATCH", parity: true do
        draft.update!(draft: false, purchase_disabled_at: Time.current)

        call(:patch, draft_path, params: { name: "Quill" })

        expect(response.parsed_body.dig("product", "name")).to eq("Quill")
      end

      it "renames a draft in a JSON body with the flags", parity: true do
        call(:put, draft_path, params: { name: "Pen", is_adult: true, display_product_reviews: false, should_show_sales_count: true })

        expect(response.parsed_body["success"]).to be true
        expect(draft.reload.is_adult).to be true
      end

      it "turns the flags of a published product on and off", parity: true do
        call(:put, path, params: { is_adult: true, should_show_sales_count: true, display_product_reviews: false })

        expect(response.parsed_body["success"]).to be true
        expect(product.reload.display_product_reviews).to be false
      end

      it "saves nothing new when the name is the one it has", parity: true do
        call(:put, path, params: { name: "Pencil" })

        expect(response.parsed_body.dig("product", "name")).to eq("Pencil")
      end

      it "saves a request with no attributes", parity: true do
        call(:put, path, params: {})

        expect(response.parsed_body["success"]).to be true
      end

      it "refuses a blank name", parity: true do
        call(:put, draft_path, params: { name: "" })

        expect(message).to eq("Name can't be blank")
        expect(draft.reload.name).to eq("Pencil")
      end

      it "refuses a name with an adult keyword", parity: true do
        call(:put, draft_path, params: { name: "Nude drawing" })

        expect(message).to eq("Adult keywords are not allowed")
      end

      it "refuses a name past 255 characters", parity: true do
        call(:put, draft_path, params: { name: "a" * 256 })

        expect(message).to eq("Name is too long (maximum is 255 characters)")
      end

      it "hands a rename of a draft whose seller has an offer code back to Rails", parity: true do
        create(:offer_code, user: seller, products: [draft], code: "tenoff")

        call(:put, draft_path, params: { name: "Pen" })

        expect(response.parsed_body.dig("product", "name")).to eq("Pen")
      end

      it "hands a flag given as text back to Rails", parity: true do
        call(:put, draft_path, params: { is_adult: "true" })

        expect(response.parsed_body["success"]).to be true
      end

      it "hands a name with a currency back to Rails", parity: true do
        call(:put, draft_path, params: { name: "Pen", price_currency_type: "eur" })

        expect(response.parsed_body["success"]).to be true
      end

      # The price, description and tags saves; `parity_timeline` records the order of the statements and jobs inside each.
      describe "the price" do
        let(:price_row) { draft.prices.alive.is_buy.last }

        it "changes the price of a published product with PATCH", parity: true, parity_timeline: true do
          call(:patch, path, params: { price: 250 })

          expect(response.parsed_body.dig("product", "price")).to eq(250)
          expect(product.reload.price_cents).to eq(250)
        end

        it "changes the price of a draft with a name and the flags", parity: true, parity_timeline: true do
          call(:put, draft_path, params: { name: "Pen", price: 300, is_adult: true })

          expect(response.parsed_body.dig("product", "price")).to eq(300)
        end

        it "sets the price a text of digits gives", parity: true, parity_timeline: true do
          call(:put, draft_path, params: { price: "450" })

          expect(price_row.price_cents).to eq(450)
        end

        it "saves the price the product already has", parity: true, parity_timeline: true do
          call(:put, draft_path, params: { price: draft.price_cents })

          expect(response.parsed_body["success"]).to be true
        end

        it "makes the product free and pay-what-you-want", parity: true, parity_timeline: true do
          call(:put, draft_path, params: { price: 0 })

          expect(response.parsed_body.dig("product", "price")).to eq(0)
          expect(draft.reload.customizable_price).to be true
        end

        it "refuses a price under the minimum", parity: true, parity_timeline: true do
          call(:put, draft_path, params: { price: 50 })

          expect(message).to eq("Sorry, a product must be at least $0.99.")
          expect(price_row.price_cents).to eq(draft.price_cents)
        end

        it "refuses a price past the limit of an unverified seller", parity: true, parity_timeline: true do
          call(:put, draft_path, params: { price: 600_000 })

          expect(message).to eq("Sorry, we don't support pricing products above $5,000.")
        end

        it "refuses a price past the column", parity: true, parity_timeline: true do
          call(:put, draft_path, params: { price: 2_147_483_648 })

          expect(message).to eq("Sorry, the price entered is too large.")
        end

        it "refuses a price past the column with nothing else saved", parity: true, parity_timeline: true do
          call(:put, draft_path, params: { name: "Pen", price: 99_999_999_999 })

          expect(message).to eq("Sorry, the price entered is too large.")
          expect(draft.reload.name).to eq("Pencil")
        end

        it "hands a price given with cents back to Rails", parity: true do
          call(:put, draft_path, params: { price: "3.50" })

          expect(response.parsed_body).to include("success")
        end

        it "hands a blank price back to Rails", parity: true do
          call(:put, draft_path, params: { price: "" })

          expect(response.parsed_body["success"]).to be false
        end

        it "hands the price of a rentable product back to Rails", parity: true do
          draft.update!(purchase_type: :buy_and_rent, rental_price_cents: 150)

          call(:put, draft_path, params: { price: 300 })

          expect(response.parsed_body["success"]).to be true
        end

        it "hands the price of a product with two buy prices back to Rails", parity: true do
          draft.prices.create!(price_cents: 500, currency: "usd", recurrence: "monthly")

          call(:put, draft_path, params: { price: 300 })

          expect(response.parsed_body["success"]).to be true
        end

        it "hands the price of a coffee product back to Rails", parity: true do
          seller.update_column(:created_at, 3.months.ago)
          coffee = create(:coffee_product, user: seller)

          call(:put, "/products/#{coffee.external_id}", params: { price: 300 })

          expect(response.parsed_body).to include("success" => true)
        end
      end

      describe "the description" do
        it "saves a description of a draft", parity: true, parity_timeline: true do
          call(:put, draft_path, params: { description: "<p>Hello <strong>world</strong></p>" })

          expect(response.parsed_body.dig("product", "description")).to eq("<p>Hello <strong>world</strong></p>")
        end

        it "saves a description with a name, the flags and a price", parity: true, parity_timeline: true do
          call(:put, draft_path, params: { name: "Pen", description: "<p>Writes</p>", price: 700, display_product_reviews: false })

          expect(draft.reload.description).to eq("<p>Writes</p>")
        end

        it "clears the description", parity: true, parity_timeline: true do
          draft.update!(description: "<p>Old</p>")

          call(:put, draft_path, params: { description: "" })

          expect(draft.reload.description).to eq("")
        end

        it "saves the description the product already has", parity: true, parity_timeline: true do
          draft.update!(description: "<p>Same</p>")

          call(:put, draft_path, params: { description: "<p>Same</p>" })

          expect(response.parsed_body["success"]).to be true
        end

        it "refuses a description with an adult keyword", parity: true, parity_timeline: true do
          call(:put, draft_path, params: { description: "<p>Nude</p>" })

          expect(message).to eq("Adult keywords are not allowed")
        end

        it "hands a description of a published product back to Rails", parity: true do
          call(:put, path, params: { description: "<p>New</p>" })

          expect(response.parsed_body["success"]).to be true
        end

        it "hands a description with a tag Nokogiri rewrites back to Rails", parity: true do
          call(:put, draft_path, params: { description: "<ul><li>One</li></ul><p>a &nbsp; b" })

          expect(response.parsed_body["success"]).to be true
        end

        it "hands a description with an upsell card back to Rails", parity: true do
          call(:put, draft_path, params: { description: '<upsell-card productid="missing"></upsell-card>' })

          expect(response.parsed_body["success"]).to be false
        end

        it "hands a description over one that holds an upsell card back to Rails", parity: true do
          draft.update_column(:description, '<upsell-card id="abc"></upsell-card>')

          call(:put, draft_path, params: { description: "<p>New</p>" })

          expect(response.parsed_body["success"]).to be true
        end
      end

      describe "the tags" do
        it "adds new tags to a draft", parity: true, parity_timeline: true do
          call(:put, draft_path, params: { tags: %w[paper pens] })

          expect(response.parsed_body.dig("product", "tags")).to match_array(%w[paper pens])
          expect(Tag.where(name: %w[paper pens]).pluck(:taggings_count)).to eq([1, 1])
        end

        it "adds a tag another product already has", parity: true, parity_timeline: true do
          other = create(:product, user: seller, name: "Other", unique_permalink: "other")
          other.tag!("paper")

          call(:put, draft_path, params: { tags: %w[paper] })

          expect(Tag.find_by(name: "paper").taggings_count).to eq(2)
        end

        it "takes the counter rows in tag id order, removals first", parity: true, parity_timeline: true do
          Tag.create!(name: "mango")
          Tag.create!(name: "apple")
          Tag.create!(name: "zebra")
          draft.tag!("zebra")
          draft.tag!("apple")

          call(:put, draft_path, params: { tags: %w[zebra mango pear] })

          expect(draft.reload.tags.pluck(:name)).to match_array(%w[zebra mango pear])
          expect(Tag.find_by(name: "apple").taggings_count).to eq(0)
        end

        it "keeps the tags the list names", parity: true, parity_timeline: true do
          draft.tag!("paper")

          call(:put, draft_path, params: { tags: %w[paper] })

          expect(response.parsed_body["success"]).to be true
          expect(Tag.find_by(name: "paper").taggings_count).to eq(1)
        end

        it "removes every tag with an empty list", parity: true, parity_timeline: true do
          draft.tag!("paper")
          draft.tag!("pens")

          call(:put, draft_path, params: { tags: [] })

          expect(draft.reload.tags).to be_empty
        end

        it "saves tags with a name and a price", parity: true, parity_timeline: true do
          call(:put, draft_path, params: { name: "Pen", price: 800, tags: %w[ink] })

          expect(draft.reload.tags.pluck(:name)).to eq(%w[ink])
        end

        it "tags a published product", parity: true, parity_timeline: true do
          call(:patch, path, params: { tags: %w[paper] })

          expect(product.reload.tags.pluck(:name)).to eq(%w[paper])
        end

        it "hands a tag with capitals back to Rails", parity: true do
          call(:put, draft_path, params: { tags: %w[Paper] })

          expect(response.parsed_body["success"]).to be true
        end

        it "hands a tag that is too short back to Rails", parity: true do
          call(:put, draft_path, params: { tags: %w[a] })

          expect(response.parsed_body["success"]).to be false
        end

        it "hands a tag that repeats back to Rails", parity: true do
          call(:put, draft_path, params: { tags: %w[paper paper] })

          expect(response.parsed_body).to include("success")
        end

        it "hands a tag with a comma back to Rails", parity: true do
          call(:put, draft_path, params: { tags: ["a,b"] })

          expect(response.parsed_body["success"]).to be false
        end
      end

      # The columns and the summary an update assigns beside the price: each saved with the product, in the action's transaction.
      describe "the pay-what-you-want price" do
        it "turns pay-what-you-want on with a suggested price", parity: true, parity_timeline: true do
          call(:put, draft_path, params: { customizable_price: true, suggested_price_cents: 800 })

          expect(response.parsed_body.dig("product", "customizable_price")).to be true
          expect(draft.reload.suggested_price_cents).to eq(800)
        end

        it "turns pay-what-you-want off", parity: true, parity_timeline: true do
          draft.update!(customizable_price: true)

          call(:patch, draft_path, params: { customizable_price: false })

          expect(draft.reload.customizable_price).to be false
        end

        it "clears the suggested price", parity: true do
          draft.update!(customizable_price: true, suggested_price_cents: 800)

          call(:put, draft_path, params: { suggested_price_cents: nil })

          expect(draft.reload.suggested_price_cents).to be_nil
        end

        it "reads the suggested price from text", parity: true do
          call(:put, draft_path, params: { customizable_price: true, suggested_price_cents: "900" })

          expect(draft.reload.suggested_price_cents).to eq(900)
        end

        it "refuses a suggested price under the price", parity: true, parity_timeline: true do
          call(:put, draft_path, params: { customizable_price: true, suggested_price_cents: 50 })

          expect(message).to eq("The suggested price you entered was too low.")
        end

        it "changes the price and the suggested price together", parity: true, parity_timeline: true do
          call(:put, draft_path, params: { price: 300, customizable_price: true, suggested_price_cents: 600 })

          expect(response.parsed_body.dig("product", "price")).to eq(300)
          expect(draft.reload.suggested_price_cents).to eq(600)
        end

        it "changes the pay-what-you-want setting of a published product", parity: true do
          call(:put, path, params: { customizable_price: true })

          expect(product.reload.customizable_price).to be true
        end

        it "hands a flag given as text back to Rails", parity: true do
          call(:put, draft_path, params: { customizable_price: "true" })

          expect(response.parsed_body["success"]).to be true
        end

        it "truncates a suggested price given with cents", parity: true do
          call(:put, draft_path, params: { customizable_price: true, suggested_price_cents: "850.5" })

          expect(draft.reload.suggested_price_cents).to eq(850)
        end

        it "truncates a suggested price given as a float", parity: true do
          call(:put, draft_path, params: { customizable_price: true, suggested_price_cents: 999.9 })

          expect(draft.reload.suggested_price_cents).to eq(999)
        end

        it "reads a suggested price of text without digits as zero and refuses it", parity: true do
          call(:put, draft_path, params: { customizable_price: true, suggested_price_cents: "abc" })

          expect(message).to eq("The suggested price you entered was too low.")
        end

        it "reads the digits at the start of a suggested price with underscores", parity: true do
          call(:put, draft_path, params: { customizable_price: true, suggested_price_cents: " 1_000__5x" })

          expect(draft.reload.suggested_price_cents).to eq(1000)
        end

        it "clears a suggested price given as blank text", parity: true do
          draft.update!(customizable_price: true, suggested_price_cents: 5000)

          call(:put, draft_path, params: { customizable_price: true, suggested_price_cents: "  " })

          expect(draft.reload.suggested_price_cents).to be_nil
        end

        it "hands a suggested price past the integer range back to Rails", parity: true do
          call(:put, draft_path, params: { customizable_price: true, suggested_price_cents: 3_000_000_000 })

          expect(response).to have_http_status(:ok)
        end
      end

      describe "the purchase limit" do
        it "limits the purchases of a draft", parity: true, parity_timeline: true do
          call(:put, draft_path, params: { max_purchase_count: 10 })

          expect(response.parsed_body.dig("product", "max_purchase_count")).to eq(10)
          expect(draft.reload.max_purchase_count).to eq(10)
        end

        it "limits the purchases of a published product", parity: true do
          call(:put, path, params: { max_purchase_count: 25 })

          expect(product.reload.max_purchase_count).to eq(25)
        end

        it "removes the limit", parity: true do
          draft.update!(max_purchase_count: 10)

          call(:put, draft_path, params: { max_purchase_count: nil })

          expect(draft.reload.max_purchase_count).to be_nil
        end

        it "removes the limit with an empty string", parity: true do
          draft.update!(max_purchase_count: 10)

          call(:put, draft_path, params: { max_purchase_count: "" })

          expect(draft.reload.max_purchase_count).to be_nil
        end

        it "reads the limit from text", parity: true do
          call(:put, draft_path, params: { max_purchase_count: "7" })

          expect(draft.reload.max_purchase_count).to eq(7)
        end

        it "brings a limit past the range down to the maximum", parity: true do
          call(:put, draft_path, params: { max_purchase_count: 20_000_000 })

          expect(draft.reload.max_purchase_count).to eq(10_000_000)
        end

        it "brings a negative limit up to zero", parity: true do
          call(:put, draft_path, params: { max_purchase_count: -4 })

          expect(draft.reload.max_purchase_count).to eq(0)
        end

        it "accepts a limit equal to the number sold", parity: true do
          draft.update_columns(sales_count_for_inventory_cache: 3)

          call(:put, draft_path, params: { max_purchase_count: 3 })

          expect(draft.reload.max_purchase_count).to eq(3)
        end

        it "refuses a limit under the number sold", parity: true do
          draft.update_columns(sales_count_for_inventory_cache: 3)

          call(:put, draft_path, params: { max_purchase_count: 2 })

          expect(message).to eq("Sorry, you cannot limit the number of purchases to that amount.")
          expect(draft.reload.max_purchase_count).to be_nil
        end

        it "truncates a limit given with a fraction", parity: true do
          call(:put, draft_path, params: { max_purchase_count: "2.5" })

          expect(draft.reload.max_purchase_count).to eq(2)
        end

        it "truncates a limit given as a float", parity: true do
          call(:put, draft_path, params: { max_purchase_count: 7.9 })

          expect(draft.reload.max_purchase_count).to eq(7)
        end

        it "reads a limit of text without digits as zero", parity: true do
          call(:put, draft_path, params: { max_purchase_count: "abc" })

          expect(draft.reload.max_purchase_count).to eq(0)
        end

        it "hands a limit given as a boolean back to Rails", parity: true do
          call(:put, draft_path, params: { max_purchase_count: true })

          expect(response).to have_http_status(:ok)
        end
      end

      describe "the quantity" do
        it "lets buyers choose a quantity", parity: true, parity_timeline: true do
          call(:put, draft_path, params: { quantity_enabled: true })

          expect(draft.reload.quantity_enabled).to be true
        end

        it "stops buyers choosing a quantity", parity: true do
          draft.update!(quantity_enabled: true)

          call(:put, draft_path, params: { quantity_enabled: false })

          expect(draft.reload.quantity_enabled).to be false
        end

        it "hands a quantity flag given as text back to Rails", parity: true do
          call(:put, draft_path, params: { quantity_enabled: "1" })

          expect(response.parsed_body["success"]).to be true
        end
      end

      describe "the taxonomy" do
        let(:taxonomy) { create(:taxonomy, parent: create(:taxonomy)) }

        it "files a draft under a taxonomy", parity: true, parity_timeline: true do
          call(:put, draft_path, params: { taxonomy_id: taxonomy.id })

          expect(response.parsed_body.dig("product", "taxonomy_id")).to eq(taxonomy.id)
          expect(response.parsed_body.dig("product", "category")).to be_present
          expect(draft.reload.taxonomy_id).to eq(taxonomy.id)
        end

        it "reads the taxonomy from text", parity: true do
          call(:put, path, params: { taxonomy_id: taxonomy.id.to_s })

          expect(product.reload.taxonomy_id).to eq(taxonomy.id)
        end

        it "moves a product from one taxonomy to another", parity: true do
          draft.update!(taxonomy: create(:taxonomy))

          call(:put, draft_path, params: { taxonomy_id: taxonomy.id })

          expect(draft.reload.taxonomy_id).to eq(taxonomy.id)
        end

        it "takes a draft out of its taxonomy with a blank id", parity: true do
          draft.update!(taxonomy:)

          call(:put, draft_path, params: { taxonomy_id: "" })

          expect(draft.reload.taxonomy_id).to be_nil
        end

        it "takes a draft out of its taxonomy with a null id", parity: true do
          draft.update!(taxonomy:)

          call(:put, draft_path, params: { taxonomy_id: nil })

          expect(draft.reload.taxonomy_id).to be_nil
        end

        it "saves the taxonomy it already has", parity: true do
          draft.update!(taxonomy:)

          call(:put, draft_path, params: { taxonomy_id: taxonomy.id })

          expect(response.parsed_body["success"]).to be true
        end
      end

      describe "the receipt text and the summary" do
        it "saves the custom receipt", parity: true, parity_timeline: true do
          call(:put, draft_path, params: { custom_receipt: "Thanks for the pencil" })

          expect(response.parsed_body.dig("product", "custom_receipt")).to eq("Thanks for the pencil")
          expect(draft.reload.custom_receipt).to eq("Thanks for the pencil")
        end

        it "clears the custom receipt", parity: true do
          draft.update!(custom_receipt: "Old")

          call(:put, draft_path, params: { custom_receipt: nil })

          expect(draft.reload.custom_receipt).to be_nil
        end

        it "saves the summary of a draft", parity: true, parity_timeline: true do
          call(:put, draft_path, params: { custom_summary: "Sixty pages" })

          expect(response.parsed_body.dig("product", "custom_summary")).to eq("Sixty pages")
          expect(draft.reload.custom_summary).to eq("Sixty pages")
        end

        it "saves the summary of a published product", parity: true do
          call(:put, path, params: { custom_summary: "Soft lead" })

          expect(product.reload.custom_summary).to eq("Soft lead")
        end

        it "clears the summary", parity: true do
          draft.update!(json_data: { "custom_summary" => "Old" })

          call(:put, draft_path, params: { custom_summary: nil })

          expect(draft.reload.custom_summary).to be_nil
        end

        it "saves the summary it already has", parity: true do
          draft.update!(json_data: { "custom_summary" => "Same" })

          call(:put, draft_path, params: { custom_summary: "Same" })

          expect(response.parsed_body["success"]).to be true
        end

        it "saves the summary with a name and a price", parity: true, parity_timeline: true do
          call(:put, draft_path, params: { name: "Pen", price: 400, custom_summary: "Blue ink", custom_receipt: "Enjoy" })

          expect(response.parsed_body.dig("product", "name")).to eq("Pen")
          expect(draft.reload.custom_summary).to eq("Blue ink")
        end

        it "hands a summary that is not text back to Rails", parity: true do
          call(:put, draft_path, params: { custom_summary: ["a"] })

          expect(response).to have_http_status(:ok)
        end

        it "hands a receipt that is not text back to Rails", parity: true do
          call(:put, draft_path, params: { custom_receipt: { a: 1 } })

          expect(response).to have_http_status(:ok)
        end
      end

      describe "the custom permalink" do
        it "hands a custom permalink back to Rails", parity: true do
          call(:put, draft_path, params: { custom_permalink: "pencil-case" })

          expect(draft.reload.custom_permalink).to eq("pencil-case")
        end
      end
    end

    describe "the Rack::Attack throttle" do
      it "counts a refusal in the tiers of the address and of the token", parity: true do
        call(:put, path, params: { tags: "a" })

        expect(counters.keys).to all(include("):put"))
        expect(counters.size).to eq(11)
        expect(counters.values.uniq).to eq([1])
      end

      it "answers 429 to the thirty-first update of an address in a minute", parity: true do
        travel_to(Time.current.change(usec: 0)) do
          fill("/v2#{path}", method: "PUT", limit: 30)

          call(:put, path, params: { name: "x" })
        end

        expect_too_many_requests
      end

      it "answers 429 to the thirty-first PATCH of an address in a minute", parity: true do
        travel_to(Time.current.change(usec: 0)) do
          fill("/v2#{path}", method: "PATCH", limit: 30)

          call(:patch, path, params: { name: "x" })
        end

        expect_too_many_requests
      end

      it "gives a creator with five thousand dollars paid out the larger ceiling", parity: true do
        create(:payment_completed, user: seller)
        allow_any_instance_of(User).to receive(:vip_creator?).and_return(true)
        travel_to(Time.current.change(usec: 0)) do
          fill("/v2#{path}", method: "PUT", limit: 30)

          call(:put, path, params: { tags: "a" })
        end

        expect(message).to eq("tags must be an array of strings.")
      end
    end
  end

  describe "GET /v2/products/comps" do
    it "asks for a taxonomy or a query", parity: true do
      call(:get, "/products/comps", scopes: "view_public")

      expect(message).to eq("A taxonomy or query parameter is required.")
    end

    it "refuses a query that is not a string", parity: true do
      call(:get, "/products/comps", params: { query: ["a"] }, scopes: "view_public")

      expect(message).to eq("query must be a string.")
    end

    it "refuses a currency Gumroad does not support", parity: true do
      call(:get, "/products/comps", params: { query: "pencil", price_currency_type: "zzz" }, scopes: "view_public")

      expect(message).to eq("'zzz' is not a supported currency.")
    end

    it "says the taxonomy was not found", parity: true do
      call(:get, "/products/comps", params: { taxonomy: "999999" }, scopes: "view_public")

      expect(message).to eq("The taxonomy was not found.")
    end

    it "says a taxonomy path was not found", parity: true do
      call(:get, "/products/comps", params: { taxonomy: "no/such/path" }, scopes: "view_public")

      expect(message).to eq("The taxonomy was not found.")
    end

    it "refuses a token that cannot read products", parity: true do
      call(:get, "/products/comps", params: { query: "pencil" }, scopes: "edit_profile")

      expect(response).to have_http_status(:forbidden)
    end

    it "hands the search back to Rails", parity: true do
      call(:get, "/products/comps", params: { query: "pencil" }, scopes: "view_public")

      expect(response.parsed_body).to include("success" => true)
      expect(response.parsed_body.dig("comps", "currency")).to eq("usd")
    end

    describe "the Rack::Attack throttle" do
      it "counts a refusal in the tiers of the address and of the token", parity: true do
        call(:get, "/products/comps", scopes: "view_public")

        expect(counters.keys).to all(include("):get"))
        expect(counters.values.uniq).to eq([1])
        expect(counters.size).to eq(11)
      end

      it "answers 429 to the thirty-first search of an address in a minute", parity: true do
        travel_to(Time.current.change(usec: 0)) do
          fill("/v2/products/comps", method: "GET", limit: 30)

          call(:get, "/products/comps", params: { query: "pencil" }, scopes: "view_public")
        end

        expect_too_many_requests
      end
    end
  end

  describe "POST /v2/products/:id/preview_custom_html" do
    let(:path) { "/products/#{product.external_id}/preview_custom_html" }

    it "refuses an account without the feature", parity: true do
      Feature.deactivate_user(:custom_html_pages, seller)

      call(:post, path, params: { custom_html: "<p>Hi</p>" })

      expect(message).to eq("You do not have access to custom HTML pages.")
    end

    it "asks for custom_html", parity: true do
      Feature.activate_user(:custom_html_pages, seller)

      call(:post, path)

      expect(message).to eq("custom_html is required.")
    end

    it "refuses custom HTML that is not a string", parity: true do
      Feature.activate_user(:custom_html_pages, seller)

      call(:post, path, params: { custom_html: 5 })

      expect(message).to eq("custom_html must be a string.")
    end

    it "refuses custom HTML past the length limit", parity: true do
      Feature.activate_user(:custom_html_pages, seller)

      call(:post, path, params: { custom_html: "a" * (Page::MAX_CUSTOM_HTML_LENGTH + 1) })

      expect(message).to start_with("custom_html is too long (maximum is")
    end

    it "says the product was not found", parity: true do
      call(:post, "/products/missing/preview_custom_html", params: { custom_html: "<p>Hi</p>" })

      expect(message).to eq("The product was not found.")
    end

    it "hands the sanitizer back to Rails", parity: true do
      Feature.activate_user(:custom_html_pages, seller)

      call(:post, path, params: { custom_html: "<p>Hi</p><script>alert(1)</script>" })

      expect(response.parsed_body).to include("success" => true)
      expect(response.parsed_body).to include("custom_html", "sanitization_report")
    end

    describe "the Rack::Attack throttle" do
      it "counts a refusal in the tiers of the address and of the token", parity: true do
        Feature.activate_user(:custom_html_pages, seller)

        call(:post, path)

        expect(counters.keys).to all(include("):post"))
        expect(counters.values.uniq).to eq([1])
        expect(counters.size).to eq(11)
      end

      it "answers 429 to the sixty-first preview of an address in a minute", parity: true do
        Feature.activate_user(:custom_html_pages, seller)
        travel_to(Time.current.change(usec: 0)) do
          fill("/v2#{path}", method: "POST", limit: 60)

          call(:post, path, params: { custom_html: "<p>Hi</p>" })
        end

        expect_too_many_requests
      end
    end
  end

  describe "POST /v2/media" do
    let(:media_token) { api_token(seller, scopes: "edit_profile") }

    def create_media(params = {}) = call(:post, "/media", params:, tok: media_token)

    it "asks for a url or a signed blob id", parity: true do
      create_media

      expect(message).to eq("Please provide a url or signed_blob_id.")
    end

    it "treats blank values as missing", parity: true do
      create_media(url: " ", signed_blob_id: "")

      expect(message).to eq("Please provide a url or signed_blob_id.")
    end

    it "refuses a token without the edit_profile scope", parity: true do
      call(:post, "/media", params: { url: "https://example.com/a.png" }, tok: api_token(seller, scopes: "view_profile"))

      expect(response).to have_http_status(:forbidden)
    end

    it "refuses a suspended account", parity: true do
      seller.update_columns(user_risk_state: "suspended_for_tos_violation")

      create_media(url: "https://example.com/a.png")

      expect(response).to have_http_status(:forbidden)
      expect(message).to eq("Your account is not active.")
    end

    it "answers 401 to the token of a deleted account", parity: true do
      media_token
      seller.update_columns(deleted_at: Time.current)

      create_media(url: "https://example.com/a.png")

      expect(response).to have_http_status(:unauthorized)
    end

    it "hands a download back to Rails", parity: true do
      create_media(url: "http://localhost/a.png")

      expect(message).to eq("We couldn't download that file, please check the URL and try again.")
    end

    describe "the Rack::Attack throttle" do
      it "counts a refusal in the buckets of the address and of the token", parity: true do
        create_media

        expect(counters.size).to eq(2)
        expect(counters.values.uniq).to eq([1])
      end

      it "answers 429 to the twenty-first upload of an address in ten minutes", parity: true do
        travel_to(Time.current.change(usec: 0)) do
          fill("/v2/media", method: "POST", limit: 20)

          create_media(url: "https://example.com/a.png")
        end

        expect_too_many_requests(max: 600)
      end
    end
  end
end
