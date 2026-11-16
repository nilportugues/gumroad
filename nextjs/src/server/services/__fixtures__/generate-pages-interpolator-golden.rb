# frozen_string_literal: true

# Generates pages-interpolator.golden.json: Pages::Interpolator.interpolate_profile on fixed inputs.
#   docker exec -i <ruby container> bash -lc 'cd /app && bundle exec ruby -' < generate-pages-interpolator-golden.rb > pages-interpolator.golden.json
require "json"
require "active_support/all"
require "loofah"
require "erb"
require "rack"

module Pages; end
require "/app/app/services/pages/interpolator"

Profile = Struct.new(:name_or_username, :bio)

PRICES = {
  "ebook" => {
    price: "$12", original_price: "$15", currency_code: "usd",
    options: [{ name: "Pro", price: "$30", original_price: nil, currency_code: "usd" }, { name: "Lite", price: "$8", original_price: "$10", currency_code: "usd" }]
  },
  "free" => { price: "$0", original_price: nil, currency_code: "eur" },
  "blank" => { price: "", original_price: "", currency_code: nil },
}.freeze

PLAIN = Profile.new("Ada & <Lovelace>", "I make \"things\" & 'stuff' — café ☕")
EMPTY = Profile.new("", "")

# `hands_back` marks the inputs the port leaves to Rails: Ruby answers them, the port refuses.
CASES = [
  { name: "writes the name and bio escaped", html: '<h1 data-gumroad-field="name">x</h1><p data-gumroad-field="bio">y</p>', profile: PLAIN },
  { name: "leaves an unknown field alone", html: '<p data-gumroad-field="mystery">keep</p>', profile: PLAIN },
  { name: "clears the text with an empty name", html: '<b data-gumroad-field="name">placeholder</b>', profile: EMPTY },
  { name: "returns blank input untouched", html: "  \n", profile: PLAIN },
  { name: "returns an empty string untouched", html: "", profile: PLAIN },
  { name: "keeps markup around the fields", html: '<div class="a"><span>Hi, I am <em data-gumroad-field="name">n</em>!</span></div><!-- note --><p>tail', profile: PLAIN },
  { name: "writes into nested markers", html: '<div data-gumroad-field="bio"><span data-gumroad-field="name">inner</span></div>', profile: PLAIN },
  { name: "writes a product price", html: '<span data-gumroad-product="ebook" data-gumroad-field="price">0</span>', profile: PLAIN, prices: PRICES },
  { name: "writes the original price while a sale runs", html: '<s data-gumroad-product="ebook" data-gumroad-field="original-price">x</s>', profile: PLAIN, prices: PRICES },
  { name: "uppercases the currency", html: '<i data-gumroad-product="ebook" data-gumroad-field="currency">x</i>', profile: PLAIN, prices: PRICES },
  { name: "keeps the text when the product has no original price", html: '<s data-gumroad-product="free" data-gumroad-field="original-price">stay</s>', profile: PLAIN, prices: PRICES },
  { name: "keeps the text for a blank price", html: '<s data-gumroad-product="blank" data-gumroad-field="price">stay</s>', profile: PLAIN, prices: PRICES },
  { name: "keeps the text for an unknown permalink", html: '<s data-gumroad-product="nope" data-gumroad-field="price">stay</s>', profile: PLAIN, prices: PRICES },
  { name: "keeps the text for a product field the surface does not know", html: '<s data-gumroad-product="ebook" data-gumroad-field="name">stay</s>', profile: PLAIN, prices: PRICES },
  { name: "does not answer a valueless product marker with the profile", html: '<s data-gumroad-product data-gumroad-field="name">stay</s>', profile: PLAIN, prices: PRICES },
  { name: "scopes a price to an option", html: '<s data-gumroad-product="ebook" data-gumroad-option="Pro" data-gumroad-field="price">x</s>', profile: PLAIN, prices: PRICES },
  { name: "keeps the text for an option the product lacks", html: '<s data-gumroad-product="ebook" data-gumroad-option="Max" data-gumroad-field="price">stay</s>', profile: PLAIN, prices: PRICES },
  { name: "reads an empty option as no option", html: '<s data-gumroad-product="ebook" data-gumroad-option="" data-gumroad-field="price">x</s>', profile: PLAIN, prices: PRICES },
  { name: "writes an option's original price", html: '<s data-gumroad-product="ebook" data-gumroad-option="Lite" data-gumroad-field="original-price">x</s>', profile: PLAIN, prices: PRICES },
  { name: "normalizes the surrounding document", html: '<P DATA-GUMROAD-FIELD="name">x</P><br><img src="a.png" alt=\'q"q\'>&nbsp;&amp;&copy;', profile: PLAIN },
  { name: "hands back a marker on a void element", html: '<br data-gumroad-field="name">', profile: PLAIN, hands_back: true },
  { name: "hands back a marker on a script", html: '<script data-gumroad-field="name">1</script>', profile: PLAIN, hands_back: true },
  { name: "hands back a marker on a textarea", html: '<textarea data-gumroad-field="bio">1</textarea>', profile: PLAIN, hands_back: true },
].freeze

cases = CASES.map do |entry|
  output = Pages::Interpolator.interpolate_profile(entry[:html], profile: entry[:profile], prices: entry[:prices] || {})
  {
    name: entry[:name],
    html: entry[:html],
    profile: { name_or_username: entry[:profile].name_or_username, bio: entry[:profile].bio },
    prices: entry[:prices]&.deep_stringify_keys,
    hands_back: entry[:hands_back] || false,
    output:,
  }
end

puts JSON.pretty_generate(interpolate_profile: cases)
