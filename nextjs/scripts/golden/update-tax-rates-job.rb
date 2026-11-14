# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/update-tax-rates-job.golden.json: UpdateTaxRatesJob run by the real app against a
# scratch database as a Sidekiq job (support/sidekiq_executor.rb), with TaxJar's /v2/summary_rates answered by WebMock (capture_http!).
# Each case records the request the taxjar-ruby gem sent, the statements, the InternalNotificationWorker pushes and the rows left.
# Run it like subtitle-file-size-worker.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases
capture_http!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/update-tax-rates-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[zip_tax_rates].freeze
SELLER_RESPONSIBLE = ZipTaxRate.flag_mapping["flags"][:is_seller_responsible]
EPUBLICATION = ZipTaxRate.flag_mapping["flags"][:is_epublication_rate]

Rails.logger = ActiveSupport::Logger.new(nil)
ActiveJob::Base.logger = Logger.new(nil)

def zip_row(id, country, rate, state: nil, **overrides)
  { id:, country:, state:, zip_code: nil, combined_rate: rate, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def summary(country_code, rate, region_code: nil, average: nil)
  { country_code:, country: country_code, region_code:, region: region_code, minimum_rate: { label: "Tax", rate: 0 }, average_rate: average || { label: "Tax", rate: } }
end

def answer(*rates) = { status: 200, body: { summary_rates: rates }.to_json }

def run(name, seed, response)
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "UpdateTaxRatesJob", args: [], http_responses: [response]) do
    UpdateTaxRatesJob.new.perform
  end
  result.delete("seed")
  # The gem's user agent names the machine (uname, Ruby and OpenSSL builds); the fixture must not depend on where it was recorded.
  result["http"].each { |request| request["headers"]["User-Agent"] = request["headers"]["User-Agent"].sub(/\(.*\)/, "(<platform>)") }
  result
end

cases = []
# Nothing to do
cases << run("no summary rates", {}, answer)
cases << run("an answer without the summary_rates key", {}, { status: 200, body: "{}" })
cases << run("an answer whose summary_rates is null", {}, { status: 200, body: '{"summary_rates":null}' })

# EU and other VAT countries
cases << run("a country with no rate yet", {}, answer(summary("FR", 0.2)))
cases << run("a country whose rate is unchanged", { zip_tax_rates: [zip_row(1, "FR", "0.2")] }, answer(summary("FR", 0.2)))
cases << run("a country whose rate changed", { zip_tax_rates: [zip_row(1, "FR", "0.19")] }, answer(summary("FR", 0.2)))
cases << run("a country whose rate was deleted", { zip_tax_rates: [zip_row(1, "FR", "0.19", deleted_at: SEEDED_AT)] }, answer(summary("FR", 0.2)))
cases << run("a deleted rate with the current value", { zip_tax_rates: [zip_row(1, "FR", "0.2", deleted_at: SEEDED_AT)] }, answer(summary("FR", 0.2)))
cases << run("a country with only an epublication rate", { zip_tax_rates: [zip_row(1, "FR", "0.055", flags: EPUBLICATION)] }, answer(summary("FR", 0.2)))
cases << run("a country with an epublication and a regular rate", { zip_tax_rates: [zip_row(1, "FR", "0.055", flags: EPUBLICATION), zip_row(2, "FR", "0.19")] }, answer(summary("FR", 0.2)))
cases << run("a country with two live rates", { zip_tax_rates: [zip_row(1, "FR", "0.2"), zip_row(2, "FR", "0.19")] }, answer(summary("FR", 0.2)))
cases << run("a country rate that also has a state", { zip_tax_rates: [zip_row(1, "DE", "0.19", state: "BE")] }, answer(summary("DE", 0.2)))
cases << run("a seller responsible country rate", { zip_tax_rates: [zip_row(1, "FR", "0.19", flags: SELLER_RESPONSIBLE)] }, answer(summary("FR", 0.2)))
cases << run("a rate of zero", { zip_tax_rates: [zip_row(1, "FR", "0.19")] }, answer(summary("FR", 0)))
cases << run("a rate of zero as a float", {}, answer(summary("FR", 0.0)))
cases << run("a negative rate", {}, answer(summary("FR", -0.2)))
cases << run("a country outside the VAT list", {}, answer(summary("JP", 0.1), summary("BR", 0.17)))
cases << run("TaxJar's code for Greece", {}, answer(summary("EL", 0.24)))
cases << run("TaxJar's code for the United Kingdom", { zip_tax_rates: [zip_row(1, "GB", "0.2")] }, answer(summary("UK", 0.21)))
cases << run("Greece under its ISO code", {}, answer(summary("GR", 0.24)))
cases << run("the United Kingdom under its ISO code", {}, answer(summary("GB", 0.2)))
cases << run("the same country twice", {}, answer(summary("FR", 0.2), summary("FR", 0.21)))
cases << run("every EU country", {}, answer(*Compliance::Countries::EU_VAT_APPLICABLE_COUNTRY_CODES.map { |code| summary(code, 0.2) }))
cases << run("an integer rate", {}, answer(summary("FR", 1)))
cases << run("a rate given as a string", {}, answer(summary("FR", "0.2")))
cases << run("a rate with more digits than the column keeps", { zip_tax_rates: [zip_row(1, "FR", "0.0825")] }, answer(summary("FR", 0.08250001)))
cases << run("a rate that differs only past the seventh digit", { zip_tax_rates: [zip_row(1, "FR", "0.0825")] }, answer(summary("FR", 0.08250004)))
cases << run("a rate rounded to seven digits", {}, answer(summary("FR", 0.123456789)))
cases << run("a rate equal to the stored decimal", { zip_tax_rates: [zip_row(1, "FR", "0.0825")] }, answer(summary("FR", 0.0825)))
cases << run("a tiny rate", {}, answer(summary("FR", 0.0000001)))
cases << run("a rate that rounds to zero", {}, answer(summary("FR", 0.00000001)))
cases << run("a lower-case country code", {}, answer(summary("fr", 0.2)))
cases << run("a nil country code", {}, answer(summary(nil, 0.2)))
cases << run("a rate without an average rate", {}, answer({ country_code: "FR" }))
cases << run("an average rate of null", {}, answer(summary("FR", nil)))

# United States
cases << run("a taxable state with no rate yet", {}, answer(summary("US", 0.0652, region_code: "WA")))
cases << run("a taxable state whose rate is unchanged", { zip_tax_rates: [zip_row(1, "US", "0.0652", state: "WA")] }, answer(summary("US", 0.0652, region_code: "WA")))
cases << run("a taxable state whose rate changed", { zip_tax_rates: [zip_row(1, "US", "0.065", state: "WA")] }, answer(summary("US", 0.0652, region_code: "WA")))
cases << run("a taxable state flagged seller responsible", { zip_tax_rates: [zip_row(1, "US", "0.0652", state: "WA", flags: SELLER_RESPONSIBLE)] }, answer(summary("US", 0.0652, region_code: "WA")))
cases << run("a taxable state flagged seller responsible and a new rate", { zip_tax_rates: [zip_row(1, "US", "0.06", state: "WA", flags: SELLER_RESPONSIBLE)] }, answer(summary("US", 0.0652, region_code: "WA")))
cases << run("a taxable state that was deleted", { zip_tax_rates: [zip_row(1, "US", "0.0652", state: "WA", deleted_at: SEEDED_AT)] }, answer(summary("US", 0.0652, region_code: "WA")))
cases << run("a taxable state with only a zip code rate", { zip_tax_rates: [zip_row(1, "US", "0.0652", state: "WA", zip_code: "98101")] }, answer(summary("US", 0.0652, region_code: "WA")))
cases << run("a taxable state with only an epublication rate", { zip_tax_rates: [zip_row(1, "US", "0.0652", state: "WA", flags: EPUBLICATION)] }, answer(summary("US", 0.0652, region_code: "WA")))
cases << run("a taxable state with two live rates", { zip_tax_rates: [zip_row(1, "US", "0.06", state: "WA"), zip_row(2, "US", "0.0652", state: "WA")] }, answer(summary("US", 0.0652, region_code: "WA")))
cases << run("a state outside the taxable list", {}, answer(summary("US", 0.0725, region_code: "CA")))
cases << run("a taxable state with a rate of zero", {}, answer(summary("US", 0, region_code: "WA")))
cases << run("a taxable state in lower case", {}, answer(summary("US", 0.0652, region_code: "wa")))
cases << run("a United States rate without a state", {}, answer(summary("US", 0.0652)))
cases << run("a taxable state in another country", {}, answer(summary("MX", 0.0652, region_code: "WA")))
cases << run("every taxable state", {}, answer(*Compliance::Countries::TAXABLE_US_STATE_CODES.map { |code| summary("US", 0.05, region_code: code) }))
cases << run("a taxable state twice", {}, answer(summary("US", 0.0652, region_code: "WA"), summary("US", 0.07, region_code: "WA")))
cases << run("the same state as a country-level rate", { zip_tax_rates: [zip_row(1, "US", "0.0652", state: "WA")] }, answer(summary("US", 0.0652, region_code: "WA"), summary("US", 0.0652)))
cases << run("a state whose rate was a province's", { zip_tax_rates: [zip_row(1, "CA", "0.05", state: "WA")] }, answer(summary("US", 0.0652, region_code: "WA")))

# Canada
cases << run("a province with no rate yet", {}, answer(summary("CA", 0.13, region_code: "ON")))
cases << run("a province whose rate is unchanged", { zip_tax_rates: [zip_row(1, "CA", "0.13", state: "ON")] }, answer(summary("CA", 0.13, region_code: "ON")))
cases << run("a province whose rate changed", { zip_tax_rates: [zip_row(1, "CA", "0.12", state: "ON")] }, answer(summary("CA", 0.13, region_code: "ON")))
cases << run("a province that was deleted", { zip_tax_rates: [zip_row(1, "CA", "0.13", state: "ON", deleted_at: SEEDED_AT)] }, answer(summary("CA", 0.13, region_code: "ON")))
cases << run("a province with a zip code rate", { zip_tax_rates: [zip_row(1, "CA", "0.12", state: "ON", zip_code: "M5V")] }, answer(summary("CA", 0.13, region_code: "ON")))
cases << run("a province with only an epublication rate", { zip_tax_rates: [zip_row(1, "CA", "0.12", state: "ON", flags: EPUBLICATION)] }, answer(summary("CA", 0.13, region_code: "ON")))
cases << run("a province flagged seller responsible", { zip_tax_rates: [zip_row(1, "CA", "0.12", state: "ON", flags: SELLER_RESPONSIBLE)] }, answer(summary("CA", 0.13, region_code: "ON")))
cases << run("a province that is not in Canada's list", {}, answer(summary("CA", 0.13, region_code: "XX")))
cases << run("a Canadian rate without a province", {}, answer(summary("CA", 0.05)))
cases << run("a province with a rate of zero", {}, answer(summary("CA", 0, region_code: "ON")))
cases << run("a province in lower case", {}, answer(summary("CA", 0.13, region_code: "on")))
cases << run("every province", {}, answer(*Compliance::Countries.subdivisions_for_select("CA").map { |code, _| summary("CA", 0.09, region_code: code) }))
cases << run("a province twice", {}, answer(summary("CA", 0.13, region_code: "ON"), summary("CA", 0.14, region_code: "ON")))

# One answer with all three kinds
cases << run(
  "rates for countries, states and provinces together",
  { zip_tax_rates: [zip_row(1, "DE", "0.19"), zip_row(2, "US", "0.06", state: "TX"), zip_row(3, "CA", "0.12", state: "BC")] },
  answer(summary("DE", 0.2), summary("US", 0.0625, region_code: "TX"), summary("US", 0.04, region_code: "NY"), summary("CA", 0.12, region_code: "BC"), summary("CA", 0.15, region_code: "NS"), summary("ES", 0.21), summary("JP", 0.1))
)

# TaxJar errors
cases << run("a bad request", {}, { status: 400, body: { error: "Bad Request", detail: "Invalid request", status: "400" }.to_json })
cases << run("an unauthorized request", {}, { status: 401, body: { error: "Unauthorized", detail: "Not authorized for route", status: "401" }.to_json })
cases << run("a forbidden request", {}, { status: 403, body: { error: "Forbidden", detail: "Forbidden", status: "403" }.to_json })
cases << run("a route that was not found", {}, { status: 404, body: { error: "Not Found", detail: "Route not found", status: "404" }.to_json })
cases << run("too many requests", {}, { status: 429, body: { error: "Too Many Requests", detail: "Slow down", status: "429" }.to_json })
cases << run("a TaxJar server error", {}, { status: 500, body: { error: "Internal Server Error", detail: "Something went wrong", status: "500" }.to_json })
cases << run("TaxJar unavailable", {}, { status: 503, body: { error: "Service Unavailable", detail: "Down for maintenance", status: "503" }.to_json })
cases << run("a gateway timeout", {}, { status: 504, body: { error: "Gateway Timeout", detail: "Timed out", status: "504" }.to_json })
cases << run("an error status the gem does not name", {}, { status: 418, body: "{}" })
cases << run("an error with no detail", {}, { status: 400, body: "{}" })
cases << run("an error answer that is not JSON", {}, { status: 502, body: "<html>Bad gateway</html>" })
cases << run("a successful answer that is not JSON", {}, { status: 200, body: "<html>ok</html>" })
cases << run("a successful answer of null", {}, { status: 200, body: "null" })
cases << run("a successful answer that is an empty body", {}, { status: 200, body: "" })
cases << run("an answer with a redirect status", {}, { status: 302, body: "{}" })

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
