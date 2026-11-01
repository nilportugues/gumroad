# frozen_string_literal: true

# Writes the country data nextjs/src/server/models/compliance-countries.ts reads, from the real
# `countries` gem with config/initializers/countries.rb applied and lib/utilities/compliance/countries.rb
# loaded, and the Ruby answers its tests replay:
#
#   src/server/models/countries.generated.json         per country: alpha2, alpha3, common name, currency and
#                                                      every name `find_country_by_any_name` searches, in the
#                                                      gem's order; Unaccent's table; the Stripe Connect list
#                                                      and a digest of every file the data came from
#   src/server/models/__fixtures__/countries.golden.json  Ruby's normalized-name index, `find_by_name` answers
#                                                      for the probes below, `mapping`, `historical_names`
#
# No database or Rails: ActiveSupport (for `blank?`), the gems in the Gemfile and the two Ruby files.
#
#   BUNDLE_GEMFILE=Gemfile bundle exec ruby nextjs/scripts/golden/countries.rb
#
# models/countries.test.ts fails when a source digest no longer matches the repository, so a change to
# the gem version, the initializer, the module or the Stripe Connect list cannot go unnoticed.
require "active_support/all"
require "countries"
require "concurrent"
require "digest"
require "json"
require "set"

ROOT = File.expand_path("../../..", __dir__)
DATA_OUT = File.join(ROOT, "nextjs/src/server/models/countries.generated.json")
GOLDEN_OUT = File.join(ROOT, "nextjs/src/server/models/__fixtures__/countries.golden.json")
SOURCES = %w[
  config/initializers/countries.rb
  lib/utilities/compliance/countries.rb
  app/business/payments/merchant_registration/implementations/stripe/stripe_merchant_account_manager.rb
].freeze

load File.join(ROOT, "config/initializers/countries.rb")
load File.join(ROOT, "lib/utilities/compliance/countries.rb")

countries = ISO3166::Country.all
parse_value = ->(name) { ISO3166::Country.send(:parse_value, name) }
names_of = lambda do |country|
  [country.iso_long_name, country.iso_short_name, *country.unofficial_names, *country.translated_names].compact
end

# COUNTRIES_SUPPORTED_BY_STRIPE_CONNECT is a literal list of names resolved through find_by_name; the
# manager module itself needs the whole app, so the literal is read out of its source.
manager_source = File.read(File.join(ROOT, SOURCES.last))
literal = manager_source[/COUNTRIES_SUPPORTED_BY_STRIPE_CONNECT = (\[.*?\])\.map \{ \|country_name\|/m, 1] or abort "COUNTRIES_SUPPORTED_BY_STRIPE_CONNECT not found"
stripe_connect = eval(literal).map { |name| Compliance::Countries.find_by_name(name).alpha2 } # rubocop:disable Security/Eval

gemfile_lock = File.read(File.join(ROOT, "Gemfile.lock"))
gem_versions = %w[countries unaccent].to_h { |gem| [gem, gemfile_lock[/^    #{gem} \(([^)]+)\)$/, 1] || abort("#{gem} not in Gemfile.lock")] }

data = {
  "generated_by" => "nextjs/scripts/golden/countries.rb",
  "gems" => gem_versions,
  # The manager module is digested by the list alone: the rest of the file changes for unrelated reasons.
  "source_digests" => SOURCES.to_h { |path| [path, Digest::SHA256.hexdigest(path == SOURCES.last ? literal : File.read(File.join(ROOT, path)))] },
  "countries" => countries.map do |country|
    { "alpha2" => country.alpha2, "alpha3" => country.alpha3, "common_name" => country.common_name, "currency_code" => country.currency_code,
      "historical_names" => country.data["gumroad_historical_names"], "names" => names_of.(country) }
  end,
  "accent_map" => Unaccent::ACCENTMAP.to_h { |char, plain| [char, plain] },
  "stripe_connect_countries" => stripe_connect,
  "blocked_country_codes" => Compliance::Countries.const_get(:BLOCKED_COUNTRY_CODES),
  "risk_physical_blocked_country_codes" => Compliance::Countries.const_get(:RISK_PHYSICAL_BLOCKED_COUNTRY_CODES),
}
File.write(DATA_OUT, "#{JSON.pretty_generate(data)}\n")

# The index `find_country_by_any_name` effectively searches: the last country (in the gem's order) whose
# parsed name equals the parsed query wins.
index = {}
countries.each { |country| names_of.(country).each { |name| index[parse_value.(name)] = country.alpha2 } }

# Probes: every name as stored, with the case, accent and punctuation changes a stored value may carry,
# plus values that must not match.
raw_names = countries.flat_map(&names_of).uniq
probes = raw_names.dup
raw_names.each do |name|
  probes << name.upcase << name.downcase << " #{name} " << "#{name}," << "(#{name})" << Unaccent.unaccent(name)
  probes << name.unicode_normalize(:nfd) if name.unicode_normalize(:nfd) != name
end
probes.concat(countries.flat_map { |c| [c.alpha2, c.alpha3, c.alpha2.downcase, c.common_name] })
probes.concat(countries.flat_map { |c| (c.data["gumroad_historical_names"] || []) })
probes.concat([nil, "", " ", "\t\n", " ", "　", "Elsewhere", "Unknown", "XX", "Narnia", "United States of America", "USA", "U.S.", "Korea", "Congo", "Republic of Korea",
               "Türkiye", "Turkiye", "TURKEY", "Côte d'Ivoire", "Côte d’Ivoire", "Cote d'Ivoire", "Ivory Coast", "Curaçao", "Curacao", "Åland Islands", "Aland Islands",
               "Åland", "São Tomé and Príncipe", "Sao Tome and Principe", "Saint Barthélemy", "Réunion", "Reunion", "Slovak Republic", "Czech Republic", "Czechia",
               "Hong Kong", "Hong Kong SAR China", "Macao", "Macau", "Taiwan", "Kosovo", "Palestine", "State of Palestine", "Russia", "Russian Federation",
               "İstanbul", "ǅ", "ΣΊΣΥΦΟΣ", "ΕΛΛΆΔΑ", "Ελλάδα", "ελλάδα", "[]", "a[]b", "United Kingdom (UK)", "Bonaire, Sint Eustatius, and Saba", "Congo Republic",
               "St Vincent and Grenadines", "U.S. Outlying Islands", "Federated States of Micronesia", "ﬁ", "ß", "Æ", "ÅÄÖ", "日本", "Japan", "Japón"])
probes = probes.uniq

# String#downcase and Unaccent on strings the countries gem never holds, for the TypeScript port of both.
normalize_probes = probes.compact + ["İ", "ΑΣ", "ΑΣ ", "ΑΣΑ", "ǈ", "ẞ", "ŉ", "ǰ", "Ⅷ", "ⓐ", "ﬃ", "Ǆ", "İİ", "İ", "Straße", "STRASSE", "é", "é", "Ǻ", "Ɓ", "ʼn"]

golden = {
  "generated_with" => { "ruby" => RUBY_VERSION, "countries" => gem_versions["countries"], "unaccent" => gem_versions["unaccent"] },
  "index" => index.sort.to_h,
  "mapping" => Compliance::Countries.mapping.to_a,
  "historical_names" => countries.to_h { |country| [country.alpha2, Compliance::Countries.historical_names(country.common_name)] },
  "find_by_name" => probes.map do |probe|
    country = Compliance::Countries.find_by_name(probe)
    { "name" => probe, "alpha2" => country&.alpha2, "common_name" => country&.common_name }
  end,
  "normalized" => normalize_probes.uniq.map { |string| [string, parse_value.(string)] },
  "blocked" => countries.map { |c| [c.alpha2, Compliance::Countries.blocked?(c.alpha2), Compliance::Countries.risk_physical_blocked?(c.alpha2)] },
}
# One entry per line: the lists run to thousands of entries.
File.write(GOLDEN_OUT, "{\n#{golden.map { |key, value| value.is_a?(Array) ? "#{key.to_json}: [\n#{value.map(&:to_json).join(",\n")}\n]" : "#{key.to_json}: #{value.to_json}" }.join(",\n")}\n}\n")
puts "wrote #{DATA_OUT} and #{GOLDEN_OUT} (#{probes.size} probes, #{index.size} indexed names)"
