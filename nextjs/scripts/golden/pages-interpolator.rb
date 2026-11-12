# frozen_string_literal: true

# Produces nextjs/src/server/services/__fixtures__/pages-interpolator-product.golden.json: Pages::Interpolator.interpolate (the product
# half) and Pages::ProductPrices.referenced_in? run by the real classes on fixed products. The cases with `hands_back` are the markers the
# Node port leaves to Rails (the formatted price, option prices, buy buttons, sanitized markup written into a marker): Ruby answers them
# here and the port must refuse. It needs no database, so it runs under plain ruby in the app's bundle:
#   docker exec gr-ruby-c25m bash -c 'source /tmp/env25.sh; cd /app && bundle exec ruby nextjs/scripts/golden/pages-interpolator.rb'
require "json"
require "active_support/all"
require "action_controller"
require "action_view"
require "rails-html-sanitizer"
require "loofah"
require "erb"
require "rack"

# config/application.rb pins the HTML4 sanitizer vendor.
abort "config/application.rb no longer pins Rails::HTML4::Sanitizer" unless File.read(File.expand_path("../../../config/application.rb", __dir__)).include?("config.action_view.sanitizer_vendor = Rails::HTML4::Sanitizer")
ActionView::Helpers::SanitizeHelper.sanitizer_vendor = Rails::HTML4::Sanitizer

module Pages; end
require_relative "../../../app/services/pages/interpolator"
require_relative "../../../app/services/pages/buy_button_params"
require_relative "../../../app/services/pages/product_prices" if false # needs the app: referenced_in? is copied below and checked against the source

OUT = File.expand_path("../../src/server/services/__fixtures__/pages-interpolator-product.golden.json", __dir__)

# The only class method of Pages::ProductPrices the port needs; the source file loads CurrencyHelper, so the golden reads its regex.
PRICES_SOURCE = File.read(File.expand_path("../../../app/services/pages/product_prices.rb", __dir__))
REFERENCE_PATTERN = Regexp.new(PRICES_SOURCE[%r{html\.to_s\.match\?\(/(.+)/\)}, 1])

Product = Struct.new(:name, :description, :reviews, :unique_permalink, keyword_init: true) do
  def price_formatted_verbose(**) = "$1"
  def display_product_reviews? = !reviews.nil?
  def rating_stats = reviews || { count: 0, average: 0.0, percentages: [] }
  def option_prices = [{ name: "Pro", price: "$30" }]
  def options = []
  def quantity_enabled = false
  def customizable_price = false
  def is_recurring_billing = false
  def recurrences = { enabled: [] }
  def max_purchase_count = nil
end

PRODUCT = Product.new(name: "Ebook & <More>", description: "<p>First paragraph &amp; more</p><h2>Heading</h2><ul><li>One</li><li>Two</li></ul><script>alert(1)</script>", reviews: { count: 12, average: 4.5, percentages: [] }, unique_permalink: "ebook")
PLAIN = Product.new(name: "Plain", description: "Just text & <b>bold</b> with a \"quote\" and 'single' and café", reviews: nil, unique_permalink: "plain")
STAR4 = Product.new(name: "Four", description: "", reviews: { count: 3, average: 4.0, percentages: [] }, unique_permalink: "four")
STAR3 = Product.new(name: "Three", description: nil, reviews: { count: 1, average: 3.3, percentages: [] }, unique_permalink: "three")
EMPTY = Product.new(name: nil, description: nil, reviews: nil, unique_permalink: "empty")
TEXTLESS = Product.new(name: "", description: "<br>", reviews: { count: 0, average: 0.0, percentages: [] }, unique_permalink: "textless")
LINKS = Product.new(name: "Links", description: "<p>See <a href=\"https://example.com/a?b=1&amp;c=2\" onclick=\"x()\">this</a> and <a href=\"javascript:alert(1)\">that</a></p>", reviews: nil, unique_permalink: "links")

CASES = [
  { name: "writes the product name escaped", html: '<h1 data-gumroad-field="name">x</h1>', product: PRODUCT },
  { name: "writes the name into nested markup", html: '<div class="a"><span>by <b data-gumroad-field="name">n</b></span></div>', product: PRODUCT },
  { name: "clears a name that is nil", html: '<h1 data-gumroad-field="name">placeholder</h1>', product: EMPTY },
  { name: "writes the rating without a trailing .0", html: '<span data-gumroad-field="rating">0</span>', product: STAR4 },
  { name: "writes a fractional rating", html: '<span data-gumroad-field="rating">0</span>', product: STAR3 },
  { name: "writes the review count", html: '<span data-gumroad-field="review-count">0</span>', product: PRODUCT },
  { name: "keeps the author's text when reviews are hidden", html: '<span data-gumroad-field="rating">4.9</span><span data-gumroad-field="review-count">100</span>', product: PLAIN },
  { name: "writes a zero count when the product has reviews enabled but none", html: '<span data-gumroad-field="review-count">100</span>', product: TEXTLESS },
  { name: "writes plain text for a description", html: '<div data-gumroad-field="description">x</div>', product: Product.new(name: "n", description: "Just text, no markup", reviews: nil, unique_permalink: "a") },
  { name: "writes a description with entities", html: '<div data-gumroad-field="description">x</div>', product: Product.new(name: "n", description: "Tom & Jerry < 3", reviews: nil, unique_permalink: "a") },
  { name: "clears the text for a blank description", html: '<div data-gumroad-field="description">placeholder</div>', product: STAR4 },
  { name: "clears the text for a nil description", html: '<div data-gumroad-field="description">placeholder</div>', product: STAR3 },
  { name: "ignores an unknown field", html: '<p data-gumroad-field="mystery">keep</p><p data-gumroad-field>keep too</p>', product: PRODUCT },
  { name: "ignores a field spelled in capitals", html: '<p data-gumroad-field="NAME">keep</p>', product: PRODUCT },
  { name: "returns blank input untouched", html: "  \n", product: PRODUCT },
  { name: "returns an empty string untouched", html: "", product: PRODUCT },
  { name: "normalizes the surrounding document", html: '<P DATA-GUMROAD-FIELD="name">x</P><br><img src="a.png" alt=\'q"q\'>&nbsp;&amp;&copy;<!-- c -->tail', product: PRODUCT },
  { name: "leaves a page with no markers normalized", html: "<section><h1>Title</h1><p>Text<p>More</section>", product: PRODUCT },
  { name: "a product-scoped marker is not a profile one", html: '<span data-gumroad-product="x" data-gumroad-field="name">stay?</span>', product: PRODUCT },
  { name: "the review marker runs once for several elements", html: '<i data-gumroad-field="rating">a</i><b data-gumroad-field="rating">b</b><u data-gumroad-field="review-count">c</u>', product: PRODUCT },
  { name: "hands back a description with markup in a div", html: '<div data-gumroad-field="description">x</div>', product: PRODUCT, hands_back: true },
  { name: "hands back a description with links", html: '<section data-gumroad-field="description">x</section>', product: LINKS, hands_back: true },
  { name: "hands back a description with a break", html: '<div data-gumroad-field="description">x</div>', product: TEXTLESS, hands_back: true },
  { name: "unwraps a phrasing marker around block markup", html: '<p class="intro" id="d" data-gumroad-field="description">x</p><footer>after</footer>', product: PRODUCT, hands_back: false },
  { name: "unwraps a span marker around a list", html: '<div><span data-gumroad-field="description">x</span></div>', product: PRODUCT, hands_back: false },
  { name: "writes a phrasing marker whose description has no block tag", html: %q(<p data-gumroad-field="description">x</p>), product: PLAIN },
  { name: "hands back the formatted price", html: '<span data-gumroad-field="price">$0</span>', product: PRODUCT, hands_back: true },
  { name: "hands back an option price", html: '<span data-gumroad-field="price" data-gumroad-option="Pro">$0</span>', product: PRODUCT, hands_back: true },
  { name: "hands back a buy button", html: '<a data-gumroad-action="buy">Buy</a>', product: PRODUCT, hands_back: true },
  { name: "hands back a buy button next to a name", html: '<h1 data-gumroad-field="name">n</h1><button data-gumroad-action="buy" data-gumroad-option="Pro">Buy</button>', product: PRODUCT, hands_back: true },
  { name: "hands back a marker on a void element", html: '<br data-gumroad-field="name">', product: PRODUCT, hands_back: true },
  { name: "hands back a marker on a script", html: '<script data-gumroad-field="name">1</script>', product: PRODUCT, hands_back: true },
  { name: "hands back whitespace-only text", html: '<p data-gumroad-field="name">x</p>', product: Product.new(name: "  ", description: nil, reviews: nil, unique_permalink: "ws"), hands_back: true },
].freeze

REFERENCE_CASES = [
  "", "<p>plain</p>", '<span data-gumroad-product="x" data-gumroad-field="price">0</span>', '<script id="gumroad-prices"></script>',
  "gumroad-prices", "data-gumroad-product", "DATA-GUMROAD-PRODUCT", "data-gumroad-products", "gumroad-price", "x gumroad-prices y",
  "data-gumroad-\nproduct", "<!-- data-gumroad-product -->",
].freeze

cases = CASES.map do |entry|
  output = Pages::Interpolator.interpolate(entry[:html], product: entry[:product])
  product = entry[:product]
  {
    name: entry[:name],
    html: entry[:html],
    product: { name: product.name, description: product.description, reviews: product.reviews&.slice(:average, :count) },
    hands_back: entry[:hands_back] || false,
    output:,
  }
end

references = REFERENCE_CASES.map { |html| { html:, referenced: html.to_s.match?(REFERENCE_PATTERN) } }

File.write(OUT, JSON.pretty_generate(interpolate: cases, referenced_in: references) + "\n")
puts "wrote #{cases.size} interpolate cases and #{references.size} referenced_in? cases to #{OUT}"
