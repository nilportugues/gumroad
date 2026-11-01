# frozen_string_literal: true

# Writes what nextjs/src/server/models/concerns/money-formatter.ts reads and is checked against, from
# the real `money` gem with config/initializers/money.rb applied and app/modules/money_formatter.rb
# loaded:
#
#   src/server/models/money-currencies.generated.json   per currency the gem knows: symbol, symbol_first,
#                                                      subunit_to_unit, decimal_places, format and the
#                                                      I18n `number.currency.symbol.<ISO>` override, plus
#                                                      the I18n delimiter/separator Money looks up and
#                                                      CURRENCY_CHOICES' symbols
#   src/server/models/__fixtures__/money-format.golden.json  MoneyFormatter.format, formatted_amount_in_currency
#                                                      and StripeChargeProcessor.format_charge_presentment_amount
#                                                      for every currency and a grid of amounts
#
# No database or Rails application: ActiveSupport, I18n, the gems in the Gemfile and the two Ruby files.
#
#   BUNDLE_GEMFILE=Gemfile bundle exec ruby nextjs/scripts/golden/money-format.rb
require "active_support/all"
require "active_support/i18n"
require "bigdecimal"
require "bigdecimal/util"
require "json"
require "logger"
require "money"

ROOT = File.expand_path("../../..", __dir__)
DATA_OUT = File.join(ROOT, "nextjs/src/server/models/money-currencies.generated.json")
GOLDEN_OUT = File.join(ROOT, "nextjs/src/server/models/__fixtures__/money-format.golden.json")

module Rails
  def self.logger = @logger ||= Logger.new(nil)
end
CURRENCY_CHOICES = HashWithIndifferentAccess.new(JSON.load_file(File.join(ROOT, "config/currencies.json"))["currencies"])
load File.join(ROOT, "config/initializers/money.rb")
load File.join(ROOT, "app/modules/money_formatter.rb")

# The slice of StripeChargeProcessor the receipt's buyer-currency amounts go through.
module StripeChargeProcessor
  ZERO_DECIMAL_CURRENCIES = %w[bif clp djf gnf jpy kmf krw mga pyg rwf ugx vnd vuv xaf xof xpf].freeze

  # CurrencyHelper#subunit_to_unit, which the class extends.
  def self.subunit_to_unit(currency_type) = Money::Currency.new(currency_type.to_s.downcase).subunit_to_unit
end
source = File.read(File.join(ROOT, "app/business/payments/charging/implementations/stripe/stripe_charge_processor.rb"))
%w[charge_subunit_to_unit money_subunits_from_charge_amount format_charge_presentment_amount].each do |name|
  match = source.match(/^  def self\.#{name}\b.*?^  end\n/m) or abort "#{name} not found"
  StripeChargeProcessor.module_eval(match[0])
end
abort "ZERO_DECIMAL_CURRENCIES drifted" unless source.include?("ZERO_DECIMAL_CURRENCIES = %w[#{StripeChargeProcessor::ZERO_DECIMAL_CURRENCIES.join(" ")}].freeze")

codes = Money::Currency.table.keys.map(&:to_s).sort
currency_data = codes.to_h do |code|
  currency = Money::Currency.new(code)
  [code, {
    "iso_code" => currency.iso_code,
    "symbol" => currency.symbol,
    "symbol_first" => currency.symbol_first?,
    "subunit_to_unit" => currency.subunit_to_unit,
    "decimal_places" => currency.decimal_places,
    "format" => currency.format,
    "i18n_symbol" => I18n.t(currency.iso_code, scope: "number.currency.symbol", default: nil),
  }]
end

data = {
  "generated_by" => "nextjs/scripts/golden/money-format.rb",
  "money_version" => Gem.loaded_specs["money"].version.to_s,
  "i18n" => {
    "delimiter" => Money.locale_backend.lookup(:thousands_separator, nil),
    "separator" => Money.locale_backend.lookup(:decimal_mark, nil),
  },
  "choices_symbols" => CURRENCY_CHOICES.to_h { |code, choice| [code, choice["symbol"]] },
  "zero_decimal_charge_currencies" => StripeChargeProcessor::ZERO_DECIMAL_CURRENCIES,
  "currencies" => currency_data,
}
File.write(DATA_OUT, JSON.pretty_generate(data) + "\n")

AMOUNTS = [0, 1, 5, 9, 10, 99, 100, 101, 150, 999, 1000, 1005, 12_345, 100_000, 100_001, 123_456_789, 99_999_999_999, -1, -100, -12_345].freeze
FRACTIONAL_AMOUNTS = [0.5, 1.5, 2.5, 99.5, 100.4999, 12_345.678, 1234.5, 0.25, 33.333333333333336, 1e20].freeze
def run
  yield
rescue => e
  { "error" => { "class" => e.class.name, "message" => e.message } }
end

include CurrencyHelperStub = Module.new { def formatted_amount_in_currency(amount_cents, currency, no_cents_if_whole: true) = Money.new(amount_cents, currency).format(symbol: false, no_cents_if_whole:, with_currency: true) }

# Rows are [mode, code, amount, result]; a result is the string or {"error" => {...}}.
SECONDARY_AMOUNTS = [0, 1, 99, 12_345, 123_456_789, -12_345, 2.5, nil].freeze
vectors = []
known = codes + %w[xxx zzz abc] # codes the gem does not know soft-fail to the ISO code
encode = ->(amount) { amount.is_a?(Float) ? { "$float" => amount.to_s } : amount }
[*AMOUNTS, *FRACTIONAL_AMOUNTS, nil].each do |amount|
  known.each do |code|
    vectors << ["format", code, encode.(amount), run { MoneyFormatter.format(amount, code.to_sym, no_cents_if_whole: true, symbol: true) }]
    next unless SECONDARY_AMOUNTS.include?(amount)

    vectors << ["format_no_symbol", code, encode.(amount), run { MoneyFormatter.format(amount, code.to_sym, no_cents_if_whole: false, symbol: false) }]
    vectors << ["in_currency", code, encode.(amount), run { formatted_amount_in_currency(amount, code) }]
    vectors << ["charge_presentment", code, encode.(amount), run { StripeChargeProcessor.format_charge_presentment_amount(amount, code) }] unless amount.is_a?(Float)
  end
end
# Mixed-case currency types, as `currency_type.to_s.downcase.to_sym` receives them.
%w[USD Eur GBP jpy].each { |code| vectors << ["format", code, 12_345, MoneyFormatter.format(12_345, code.downcase.to_sym, no_cents_if_whole: true, symbol: true)] }
symbols = codes.to_h { |code| [code, MoneyFormatter.symbol_for(code.to_sym)] }

File.write(GOLDEN_OUT, JSON.generate({ "money_version" => data["money_version"], "vectors" => vectors, "symbols" => symbols }) + "\n")
puts "wrote #{codes.size} currencies, #{vectors.size} vectors"
