# frozen_string_literal: true

# Produces nextjs/src/server/tax/__fixtures__/taxjar-api.golden.json: TaxjarApi#calculate_tax_for_order through the real class and the
# taxjar-ruby gem, TaxJar answered by a WebMock stand-in (capture_http!). Each case runs the call twice and records what the gem sent
# (method, url, headers, body), the Redis memo it left (key, value, ttl in `taxjar_calculations`), and what the call returned or
# raised. The API key is fake (`TAXJAR_API_KEY=taxjar-key`) and nothing leaves the machine.
#
#   bundle exec rails runner nextjs/scripts/golden/taxjar-api.rb
require_relative "support/rails_cases"
include RailsCases
capture_http!

OUT = Rails.root.join("nextjs/src/server/tax/__fixtures__/taxjar-api.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45)
NOTIFIED = []
Rails.logger = ActiveSupport::Logger.new(nil)
ErrorNotifier.singleton_class.prepend(Module.new do
  def notify(*args, **) = (NOTIFIED << args.first.class.name)
end)

ORIGIN = { country: "US", state: "CA", zip: "94104" }.freeze

def tax_body(amount, extra = {})
  {
    tax: {
      order_total_amount: 10.0, shipping: 0.0, taxable_amount: 10.0, amount_to_collect: amount, rate: 0.065, has_nexus: true,
      freight_taxable: false, tax_source: "destination",
      jurisdictions: { country: "US", state: "WA", county: "KING", city: "SEATTLE" },
      breakdown: { taxable_amount: 10.0, tax_collectable: amount, combined_tax_rate: 0.065, state_tax_rate: 0.065 }
    }.merge(extra)
  }.to_json
end

def answer(status, body, type: "application/json") = { status:, body:, headers: type ? { "Content-Type" => type } : {} }

def snapshot
  $redis.scan_each(match: "taxjar_calculations:*").sort.map { |key| { "key" => key, "value" => $redis.get(key), "ttl" => $redis.ttl(key) } }
end

def run(name, order, *responses)
  $redis.flushdb
  NOTIFIED.clear
  results = []
  result = capture(name, now: NOW, tables: [], http_responses: responses, order:) do
    2.times do
      results << { "value" => TaxjarApi.new.calculate_tax_for_order(**order) }
    rescue StandardError => e
      results << { "raised" => e.class.name }
    end
  end
  %w[seed statements redis rows cache].each { result.delete(_1) }
  result["results"] = results
  result["memo"] = snapshot
  result["notified"] = NOTIFIED.dup
  result
end

def order(destination: { country: "US", state: "WA", zip: "98101" }, quantity: 1, product_tax_code: nil, unit_price_dollars: 10.0, shipping_dollars: 0.0, nexus_address: nil)
  { origin: ORIGIN, destination:, nexus_address: nexus_address || { country: destination[:country], state: destination[:state] },
    quantity:, product_tax_code:, unit_price_dollars:, shipping_dollars: }
end

cases = []
ok = answer(200, tax_body(0.65))

# What the gem sends and the memo key, over the order's shape
cases << run("a US taxable state", order, ok)
cases << run("a Canadian province without a zip", order(destination: { country: "CA", state: "BC", zip: nil }), ok)
cases << run("a Canadian province with a zip given", order(destination: { country: "CA", state: "QC", zip: "H2Y 1C6" }), ok)
cases << run("a nil state", order(destination: { country: "US", state: nil, zip: "98101" }), ok)
cases << run("a nexus address of another state", order(nexus_address: { country: "US", state: "NY" }), ok)
cases << run("a product tax code", order(product_tax_code: "31000"), ok)
cases << run("the SaaS tax code", order(product_tax_code: "30070"), ok)
cases << run("a tax code with letters", order(product_tax_code: "86132000A0002"), ok)
cases << run("a quantity of three", order(quantity: 3, unit_price_dollars: 1000 / 100.0 / 3), ok)
cases << run("a quantity of one hundred", order(quantity: 100, unit_price_dollars: 1 / 100.0 / 100), ok)
cases << run("shipping", order(shipping_dollars: 5.99), ok)
cases << run("shipping that is a whole number of dollars", order(shipping_dollars: 12 / 1.0), ok)

[0.01, 0.1, 0.1 + 0.2, 999_999_999_999_999.0, 999_999_999_999_999.9, 999_999_999_999_998.9, 1.5e15, 99_999_999_999_999.9, 0.00011, 0.0001000000001, 0.000099999, 1 / 3.0, 2 / 3.0, 9.99, 10.0, 19.99, 100.0, 1234.56, 123_456_789.123, 1e15, 0.5, 0.05, 0.001, 0.0001, 0.00001, 0.000123, 1e16, 1.5e16, 1e20, 1e-7, 123_456_789_012_345_680.0, 4.35, 8.2, 1.005, 2.675, 0.07, 1.1, 5.0e-324, 1.7976931348623157e+308, -0.0, -1.5, 0.0].each do |price|
  cases << run("a unit price of #{price}", order(unit_price_dollars: price), ok)
end
[0.0, 0.01, 0.1, 1.5, 9.99, 100.0, 1e16, 1e-5, 12.345, 0.30000000000000004, -0.0].each do |shipping|
  cases << run("shipping of #{shipping}", order(shipping_dollars: shipping), ok)
end

zips = ["98101", "98101-1234", "9810", " 98101", "98101 ", "98 101", "981\n01", "9\"8", "98\\1", "a\#{b", "a\#$b", "a\#@b", "a&b", "a<b", "a>b", "é", "日本", "a'b", "a%b", "a/b", "a b", "a\tb", "a\u0000b", "a\u007fb", "a b", "a\u{1f600}b", "", "0"]
zips.each { |zip| cases << run("a zip of #{zip.inspect}", order(destination: { country: "US", state: "WA", zip: }), ok) }
["WA", "wa", "W\"A", "W\\A", "É", "", " WA", "W&A", "W<A"].each { |state| cases << run("a state of #{state.inspect}", order(destination: { country: "US", state:, zip: "98101" }), ok) }
["US", "us", "CA", "É", ""].each { |country| cases << run("a country of #{country.inspect}", order(destination: { country:, state: "WA", zip: "98101" }), ok) }

# What the answers decide
cases << run("a tax with an amount of zero", order, answer(200, tax_body(0)))
cases << run("a tax with a float amount", order, answer(200, tax_body(1.025)))
cases << run("a tax with a string amount", order, answer(200, tax_body("1.5")))
cases << run("a tax with a null amount", order, answer(200, tax_body(nil)))
cases << run("a tax with extra keys", order, answer(200, tax_body(0.65, extra_key: { nested: [1, 2] }, has_nexus: false)))
cases << run("a tax with no breakdown", order, answer(200, { tax: { amount_to_collect: 1.0, rate: 0.1 } }.to_json))
cases << run("a tax with a null breakdown", order, answer(200, { tax: { amount_to_collect: 1.0, breakdown: nil, jurisdictions: nil } }.to_json))
cases << run("a tax with a state-level breakdown", order, answer(200, tax_body(0.65).sub('"state_tax_rate":0.065', '"state_tax_rate":0.065,"county_tax_rate":0.0,"city_tax_rate":0.0,"special_district_tax_rate":0.0')))
cases << run("an answer without a tax key", order, answer(200, "{}"))
cases << run("an answer whose tax is null", order, answer(200, '{"tax":null}'))
cases << run("an answer that is not JSON", order, answer(200, "not json"))
cases << run("an empty answer", order, answer(200, ""))
cases << run("an answer typed text/html", order, answer(200, tax_body(0.65), type: "text/html"))
cases << run("an answer with no content type", order, answer(200, tax_body(0.65), type: nil))
cases << run("an answer with a charset", order, answer(200, tax_body(0.65), type: "application/json; charset=utf-8"))
[201, 202, 204, 301, 400, 401, 403, 404, 405, 406, 408, 409, 410, 418, 422, 429, 500, 501, 502, 503, 504].each do |status|
  cases << run("a #{status} answer", order, answer(status, { error: "x", detail: "y", status: status.to_s }.to_json))
end
cases << run("a 400 answer with a body that is not JSON", order, answer(400, "bad"))
[404, 500, 503].each { |status| cases << run("a #{status} answer with a body that is not JSON", order, answer(status, "bad")) }
[400, 404, 500, 503].each do |status|
  { "an empty body" => "", "a JSON array" => "[]", "a JSON string" => '"x"', "a JSON null" => "null", "a JSON number" => "1", "a JSON true" => "true",
    "a JSON false" => "false", "an empty object" => "{}", "an object without a status" => '{"detail":"x"}' }.each do |label, body|
    cases << run("a #{status} answer with #{label}", order, answer(status, body))
  end
end
{ "a JSON array" => "[]", "a JSON string" => '"x"', "a JSON number" => "1", "a JSON true" => "true", "a JSON false" => "false",
  "a JSON null" => "null" }.each { |label, body| cases << run("a 200 answer with #{label}", order, answer(200, body)) }
cases << run("a 400 answer typed text/html with a JSON body", order, answer(400, { status: "400", detail: "x" }.to_json, type: "text/html"))
cases << run("a 400 answer with no content type", order, answer(400, { status: "400", detail: "x" }.to_json, type: nil))
cases << run("a 500 answer with an HTML body", order, answer(500, "<html></html>", type: "text/html"))
cases << run("a dropped connection", order, { dropped: true })
cases << run("a 503 then a 200", order, answer(503, "{}"), ok)
cases << run("a 200 then a 500", order, ok, answer(500, "{}"))

File.write(OUT, "#{JSON.pretty_generate(cases)}\n")
puts "wrote #{OUT} (#{cases.size} cases)"
