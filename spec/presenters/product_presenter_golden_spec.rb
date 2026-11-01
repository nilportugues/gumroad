# frozen_string_literal: true

require "spec_helper"
require Rails.root.join("spec/support/parity/db_snapshot")

# Writes nextjs/src/server/presenters/__fixtures__/product-presenter.golden.json (PARITY_GOLDEN=1): one
# database holding a matrix of product types, and the real output of ProductPresenter.card_for_web and
# ProductPresenter::ProductProps for each. nextjs/src/server/presenters/product.test.ts seeds the same
# rows and compares. Without PARITY_GOLDEN the examples only check that the presenters run.
describe "ProductPresenter golden", type: :model do
  # Fresh counters make the ids (and the external ids derived from them) the same on every run. ALTER TABLE
  # commits implicitly, so this runs outside the example's transaction.
  before(:all) { Parity::DbSnapshot.new(ActiveRecord::Base.connection).reset_auto_increments! }

  let(:output_path) { Rails.root.join("nextjs/src/server/presenters/__fixtures__/product-presenter.golden.json") }

  DESCRIPTIONS = [
    "Plain text",
    "  padded  text  ",
    "Fish &amp; Chips",
    "5 &lt; 6 &gt; 4 &quot;quoted&quot; &#39;single&#39;",
    "a &nbsp; b",
    "<p>One</p><p>Two</p>",
    "<p>One</p>\n<p>Two</p>",
    "<p>Hello <strong>world</strong> and <em>friends</em></p>",
    "<p>Line one<br>Line two</p>",
    "<p>Line one<br/>Line two<br />three</p>",
    "<h1>Title</h1><p>Body</p>",
    "<h2>What you get</h2><p>A 25-page guide</p>",
    "<ul><li>One</li><li>Two</li></ul>",
    "<ol><li>First</li><li>Second</li></ol>",
    "<ul>\n<li>One</li>\n<li>Two</li>\n</ul>",
    "<blockquote><p>Quoted</p></blockquote><p>After</p>",
    "<pre><code>let x = 1;\nlet y = 2;</code></pre>",
    "<p><b>bold</b> <i>italic</i> <u>under</u> <s>strike</s></p>",
    "<span>a</span> <span>b</span>",
    "<span>a</span><span>b</span>",
    "<div>Block one</div><div>Block two</div>",
    "<div><p>Nested</p><p>blocks</p></div>",
    "<p>Link: <a href=\"https://example.com/page\">example</a></p>",
    "<p>Visit https://example.com/page today</p>",
    "<p>Visit www.example.com today</p>",
    "<p>Mail me at someone@example.com</p>",
    "<p><a href=\"https://example.com\" onclick=\"evil()\">Click</a></p>",
    "<p>Image: <img src=\"https://example.com/a.png\" alt=\"a\"></p>",
    "<figure><img src=\"https://example.com/a.png\"><figcaption>Caption</figcaption></figure>",
    "<script>alert(1)</script><p>Safe</p>",
    "<p style=\"color: red\">Styled</p>",
    "<p>Text<!-- comment --> after</p>",
    "<hr><p>After rule</p>",
    "<p></p>",
    "<p>&nbsp;</p>",
    "<p>Unicode \u2014 dash and emoji \u{1F600}</p>",
    "<table><tr><td>Cell</td></tr></table>",
    "<h3>Heading</h3>text directly after",
    "text before<h3>Heading</h3>",
    "<p>Unclosed <strong>bold",
    "<p>One<p>Two",
    "<custom-tag>Custom</custom-tag>",
  ].freeze

  let(:seller) { create(:named_seller, name: "Golden Seller", bio: "Makes things.", created_at: User::MIN_AGE_FOR_SERVICE_PRODUCTS.ago - 1.day) }

  # The Rack request a seller-host page gets, without the stack.
  def request_for(host, params: {}, cookies: {}, ip: "127.0.0.1")
    env = Rack::MockRequest.env_for("http://#{host}/l/x", "REMOTE_ADDR" => ip, "HTTP_HOST" => host)
    request = ActionDispatch::Request.new(env)
    request.cookie_jar.tap { |jar| cookies.each { |k, v| jar[k] = v } }
    request.path_parameters = params.symbolize_keys
    request
  end

  def build_products
    products = {}
    products["digital"] = create(:product_with_pdf_file, user: seller, name: "Digital thing", price_cents: 500)
    products["plain"] = create(:product, user: seller, name: "Plain", price_cents: 100, description: "<p>Hello <strong>world</strong> &amp; friends</p><p>Second paragraph</p>")
    products["empty_description"] = create(:product, user: seller, name: "No description", description: nil)
    products["long_description"] = create(:product, user: seller, name: "Long description", description: "<p>#{"A sentence that goes on. " * 12}</p>")
    products["custom_permalink"] = create(:product, user: seller, name: "Custom", custom_permalink: "custom-one")
    products["pwyw"] = create(:product, user: seller, name: "PWYW", price_cents: 0, customizable_price: true, suggested_price_cents: 300)
    products["pwyw_paid"] = create(:product, user: seller, name: "PWYW paid", price_cents: 200, customizable_price: true)
    products["versions"] = create(:product_with_digital_versions_with_price_difference_cents, user: seller, name: "Versions")
    products["membership"] = create(:membership_product_with_preset_tiered_pricing, user: seller, name: "Membership")
    products["membership_trial"] = create(:membership_product, :with_free_trial_enabled, user: seller, name: "Trial membership")
    products["physical"] = create(:physical_product, user: seller, name: "Physical")
    products["bundle"] = create(:product, :bundle, user: seller)
    products["call"] = create(:call_product, :available_for_a_year, user: seller, name: "Call")
    products["coffee"] = create(:coffee_product, user: seller, name: "Coffee")
    products["commission"] = create(:commission_product, user: seller, name: "Commission")
    preorder = create(:product, user: seller, name: "Preorder")
    create(:preorder_link, link: preorder, release_at: 1.month.from_now)
    preorder.update!(is_in_preorder_state: true)
    products["preorder"] = preorder
    products["unpublished"] = create(:product, :unpublished, user: seller, name: "Draft")
    products["adult"] = create(:product, user: seller, name: "Adult", is_adult: true)
    rated = create(:product, user: seller, name: "Rated", price_cents: 0)
    create(:product_review, purchase: create(:free_purchase, link: rated), rating: 4)
    products["rated"] = rated.reload
    products["no_reviews_shown"] = create(:product, user: seller, name: "Reviews hidden", display_product_reviews: false)
    limited = create(:product, user: seller, name: "Limited", price_cents: 0, max_purchase_count: 10)
    create(:free_purchase, link: limited)
    products["limited"] = limited.reload
    products["sales_count"] = create(:product, user: seller, name: "Sales count", should_show_sales_count: true)
    refundable = create(:product, user: seller, name: "Refundable")
    refundable.update!(product_refund_policy_enabled: true)
    refundable.find_or_initialize_product_refund_policy.update!(max_refund_period_in_days: 14, fine_print: "No refunds on tuesdays")
    products["refund_policy"] = refundable
    products["eur"] = create(:product, user: seller, name: "Euro", price_currency_type: "eur", price_cents: 1000)
    products["duration"] = create(:product, user: seller, name: "Fixed length", duration_in_months: 3)
    products["with_summary"] = create(:product, user: seller, name: "Summary").tap do |product|
      product.save_custom_summary("Short pitch")
      product.save_custom_button_text_option("pay_prompt")
    end
    products["attributes"] = create(:product, user: seller, name: "Attributes").tap do |product|
      product.save_custom_attributes([{ "name" => "Format", "value" => "PDF" }, { "name" => "", "value" => "" }])
    end
    products["unsplash_thumbnail"] = create(:product, user: seller, name: "Thumbnail").tap do |product|
      product.update!(thumbnail: Thumbnail.create!(product:, unsplash_url: "https://images.example.com/photo.jpg")) if Thumbnail.column_names.include?("unsplash_url")
    end
    discounted = create(:product, user: seller, name: "Default discount", price_cents: 1000)
    discounted.update!(default_offer_code: create(:offer_code, user: seller, products: [discounted], code: "default10", amount_cents: nil, amount_percentage: 10))
    products["default_offer_code"] = discounted
    products["offer_codes"] = create(:product, user: seller, name: "With codes", price_cents: 1000).tap do |product|
      create(:offer_code, user: seller, products: [product], code: "five", amount_cents: 500)
      create(:offer_code, user: seller, products: [product], code: "half", amount_cents: nil, amount_percentage: 50)
      create(:offer_code, user: seller, products: [product], code: "bulk", amount_cents: nil, amount_percentage: 20, minimum_quantity: 3)
    end
    other_seller = create(:user, username: "otherseller", name: "Other Seller", verified: true)
    products["verified_seller"] = create(:product, user: other_seller, name: "Verified seller product")
    products["deleted"] = create(:product, user: seller, name: "Deleted").tap(&:mark_deleted!)
    products
  end

  def inputs_for(host)
    [
      ["no request", {}],
      ["seller host", { request: request_for(host) }],
      ["other host", { request: request_for("elsewhere.example.com") }],
      ["recommended", { request: request_for(host), recommended_by: "search", target: Product::Layout::DISCOVER, query: "thing", affiliate_id: "42", offer_code: "five" }],
      ["profile target", { request: request_for(host), target: Product::Layout::PROFILE, show_seller: false, compute_description: false, compute_inventory: false }],
      ["short description", { description_max_length: 20 }],
    ]
  end

  def props_for(product, host, discount_code: nil, quantity: 1, request: nil)
    ProductPresenter.new(product:, request: request || request_for(host), pundit_user: nil).product_props(
      seller_custom_domain_url: nil, discount_code:, quantity:
    )
  end

  it "records the matrix" do
    products = build_products
    host = seller.subdomain
    snapshot = Parity::DbSnapshot.new(ActiveRecord::Base.connection)
    now = Time.current
    seed = snapshot.dump(snapshot.non_empty_tables).transform_values do |dump|
      { "columns" => dump["columns"].to_h, "primaryKey" => dump["primaryKey"], "rows" => dump["rows"].map { Parity::Canonical.row(dump, _1, now) } }
    end

    cards = products.flat_map do |name, product|
      inputs_for(host).map do |label, kwargs|
        result = begin
          { "card" => JSON.parse(ProductPresenter.card_for_web(product: Link.find(product.id), **kwargs).to_json) }
        rescue => e
          { "error" => "#{e.class}: #{e.message}" }
        end
        { "product" => name, "productId" => product.id, "input" => label, "args" => kwargs.except(:request).merge("host" => kwargs[:request]&.host).compact }.merge(result)
      end
    end

    props = products.flat_map do |name, product|
      [["plain", {}], ["code five", { discount_code: "five" }], ["code half x2", { discount_code: "half", quantity: 2 }], ["code bulk x1", { discount_code: "bulk" }], ["code bulk x3", { discount_code: "bulk", quantity: 3 }], ["unknown code", { discount_code: "nope" }]].filter_map do |label, kwargs|
        next if label != "plain" && !%w[offer_codes plain].include?(name)

        result = begin
          { "props" => JSON.parse(props_for(Link.find(product.id), host, **kwargs).to_json) }
        rescue => e
          { "error" => "#{e.class}: #{e.message}" }
        end
        { "product" => name, "productId" => product.id, "input" => label, "args" => kwargs }.merge(result)
      end
    end

    descriptions = DESCRIPTIONS.map do |description|
      product = Link.new(description:, user: seller)
      { "description" => description, "plaintext" => product.plaintext_description, "html" => product.html_safe_description&.to_str }
    end

    document = {
      "seed" => { "tables" => seed, "autoIncrement" => snapshot.auto_increments },
      "now" => now.iso8601,
      "sellerHost" => host,
      "cards" => cards,
      "props" => props,
      "descriptions" => descriptions,
    }
    expect(cards.map { _1["error"] }.compact).to eq([])

    if ENV["PARITY_GOLDEN"].present?
      json = JSON.pretty_generate(document) + "\n"
      raise "golden would record a local path" if json.include?(Dir.home)

      FileUtils.mkdir_p(File.dirname(output_path))
      File.write(output_path, json)
    end
  end
end
