# frozen_string_literal: true

# Writes the data and the Ruby answers nextjs/src/server/models/stripe-account-payloads.ts is checked against:
#
#   src/server/models/stripe-account-payload-data.generated.json   the cross-border payout country list (Country) and the
#                                                                  Japanese prefecture kana table (Compliance::Countries)
#   src/server/models/__fixtures__/stripe-account-payloads.golden.json  per case the input rows (columns, JSON data and the
#                                                                  Strongbox ciphertexts as the database holds them) and what
#                                                                  StripeMerchantAccountManager's account_hash, person_hash,
#                                                                  company_hash and bank_account_hash answered, key order included
#
# Nothing is saved and no Stripe call exists: the models are built in memory, and `alive_user_compliance_info` of the seller is
# the only thing stubbed (it is a database lookup). Run it in the Ruby container:
#
#   RAILS_ENV=test bundle exec rails runner nextjs/scripts/golden/stripe-account-payloads.rb
require "base64"
require "json"

DATA_OUT = Rails.root.join("nextjs/src/server/models/stripe-account-payload-data.generated.json")
GOLDEN_OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/stripe-account-payloads.golden.json")
PASSPHRASE = GlobalConfig.get("STRONGBOX_GENERAL_PASSWORD")
MANAGER = StripeMerchantAccountManager

INFO_COLUMNS = %w[
  country state city street_address zip_code first_name last_name birthday is_business business_name business_street_address
  business_city business_state business_zip_code business_country business_type
].freeze

def info_input(columns, json: nil, individual: nil, business: nil)
  { "columns" => columns.transform_keys(&:to_s), "json" => json, "individual_tax_id" => individual, "business_tax_id" => business }
end

def build_info(input)
  info = UserComplianceInfo.new(id: 77)
  input["columns"].each { |name, value| info[name] = value }
  info.json_data = input["json"] if input["json"]
  info.individual_tax_id = input["individual_tax_id"] unless input["individual_tax_id"].nil?
  info.business_tax_id = input["business_tax_id"] unless input["business_tax_id"].nil?
  info
end

# What the database holds for the row: JSON text and the ciphertexts.
def stored_row(info, input)
  columns = INFO_COLUMNS.to_h { |name| [name, info[name].then { |value| value.is_a?(Date) ? value.to_s : value }] }
  columns["json_data"] = input["json"] && JSON.generate(input["json"])
  %w[individual_tax_id business_tax_id].each do |name|
    ciphertext = info[name]
    columns[name] = ciphertext.nil? ? nil : Base64.strict_encode64(ciphertext)
  end
  columns
end

def outcome
  { "result" => yield }
rescue StandardError => e
  { "error" => "#{e.class}: #{e.message.lines.first.strip}" }
end

US = { country: "United States", state: "CA", city: "San Francisco", street_address: "1 Market St", zip_code: "94103", first_name: "Ada", last_name: "Lovelace", birthday: "1990-02-03", is_business: false }.freeze
JP = { country: "Japan", state: "東京都", city: "渋谷区", street_address: "Shibuya 1-2-3", zip_code: "150-0002", first_name: "Taro", last_name: "Yamada", birthday: "1985-12-31", is_business: false }.freeze
JP_JSON = { "first_name_kanji" => "太郎", "last_name_kanji" => "山田", "first_name_kana" => "タロウ", "last_name_kana" => "ヤマダ", "building_number" => "1-2-3", "building_number_kana" => "1-2-3",
            "street_address_kanji" => "渋谷", "street_address_kana" => "シブヤ", "city_kana" => "シブヤク", "phone" => "+81312345678" }.freeze
BUSINESS = { **US, is_business: true, business_name: "Lovelace Ltd", business_street_address: "2 Market St", business_city: "Oakland", business_state: "CA", business_zip_code: "94607", business_country: "United States", business_type: "corporation" }.freeze

PERSON_CASES = [
  ["US individual with the last four digits of the SSN", info_input(US, json: { "phone" => "+14155550100" }, individual: "6789")],
  ["US individual with a nine-digit SSN", info_input(US, individual: "123456789")],
  ["US individual with a tax id of another length", info_input(US, individual: "12345678")],
  ["US individual with a five-character tax id", info_input(US, individual: "12345")],
  ["US individual without a tax id", info_input(US)],
  ["US individual with a blank tax id", info_input(US, individual: "   ")],
  ["US individual with a tax id that has spaces around it", info_input(US, individual: " 123456789 ")],
  ["foreign resident of a US company with a ten-digit national id", info_input({ **BUSINESS, country: "Bangladesh" }, individual: "1234567890")],
  ["foreign resident of a US company with a nine-digit id", info_input({ **BUSINESS, country: "Bangladesh" }, individual: "123456789")],
  ["US resident of a company in another country", info_input({ **BUSINESS, business_country: "Canada" }, individual: "6789")],
  ["UK individual with a national id", info_input({ **US, country: "United Kingdom", state: "London", zip_code: "SW1A 1AA" }, individual: "QQ123456C")],
  ["individual with a nationality", info_input(US, json: { "nationality" => "BD" })],
  ["individual with a blank nationality", info_input(US, json: { "nationality" => "  " })],
  ["individual without a birthday", info_input(US.merge(birthday: nil))],
  ["names and address with surrounding spaces and NUL bytes", info_input(US.merge(first_name: "  Ada\u0000", last_name: "\u0000Lovelace  ", street_address: "\t1 Market St\n", city: " Paris "))],
  ["Luxembourg postal code with a prefix", info_input({ **US, country: "Luxembourg", zip_code: "L-1234" })],
  ["Luxembourg postal code with a lowercase prefix and a space", info_input({ **US, country: "Luxembourg", zip_code: " l 1234 " })],
  ["Luxembourg postal code that does not match", info_input({ **US, country: "Luxembourg", zip_code: "12345" })],
  ["Netherlands postal code without a space", info_input({ **US, country: "Netherlands", zip_code: "1234ab" })],
  ["Netherlands postal code with a space", info_input({ **US, country: "Netherlands", zip_code: "1234 ab" })],
  ["Netherlands postal code that does not match", info_input({ **US, country: "Netherlands", zip_code: "1234 abc" })],
  ["blank postal code", info_input(US.merge(zip_code: " "))],
  ["missing postal code", info_input(US.merge(zip_code: nil))],
  ["Japanese individual with kanji and kana", info_input(JP, json: JP_JSON, individual: "123456789012")],
  ["Japanese individual without a city", info_input(JP.merge(city: nil), json: JP_JSON.except("city_kana"))],
  ["Japanese individual with a blank city", info_input(JP.merge(city: "  "), json: JP_JSON.merge("city_kana" => " "))],
  ["Japanese individual with a prefecture that has no kana", info_input(JP.merge(state: "Tokyo"), json: JP_JSON)],
  ["Hokkaido individual", info_input(JP.merge(state: "北海道"), json: JP_JSON)],
  ["country name Ruby does not know", info_input(US.merge(country: "Atlantis"))],
  ["blank country", info_input(US.merge(country: nil))],
].freeze

COMPANY_CASES = [
  ["US corporation", info_input(BUSINESS, json: { "business_phone" => "+14155550101" }, business: "12-3456789")],
  ["US single member LLC", info_input(BUSINESS.merge(business_type: "single_member_llc"), business: "12-3456789")],
  ["US multi member LLC", info_input(BUSINESS.merge(business_type: "multi_member_llc"))],
  ["US partnership", info_input(BUSINESS.merge(business_type: "partnership"))],
  ["US sole proprietorship", info_input(BUSINESS.merge(business_type: "sole_proprietorship"))],
  ["US legacy llc sends no structure", info_input(BUSINESS.merge(business_type: "llc"))],
  ["US profit sends no structure", info_input(BUSINESS.merge(business_type: "profit"))],
  ["US company without a business name", info_input(BUSINESS.merge(business_name: " "))],
  ["US company with a blank tax id", info_input(BUSINESS, business: "  ")],
  ["Canadian corporation", info_input(BUSINESS.merge(business_country: "Canada", business_type: "corporation"), business: "123456789")],
  ["Canadian non-profit sends an empty structure", info_input(BUSINESS.merge(business_country: "Canada", business_type: "non_profit"))],
  ["Canadian registered charity", info_input(BUSINESS.merge(business_country: "Canada", business_type: "registered_charity"))],
  ["Emirati company of an Emirati resident", info_input({ **BUSINESS, country: "United Arab Emirates", business_country: "United Arab Emirates", business_type: "llc" }, json: { "business_vat_id_number" => "100123456700003", "business_phone" => "+97145551234" })],
  ["Emirati company of a US resident sends no structure", info_input(BUSINESS.merge(business_country: "United Arab Emirates", business_type: "llc"), json: { "business_vat_id_number" => "100123456700003" })],
  ["Indian sole proprietorship sends no tax id", info_input(BUSINESS.merge(business_country: "India", business_type: "sole_proprietorship"), business: "ABCDE1234F")],
  ["Indian company keeps its tax id", info_input(BUSINESS.merge(business_country: "India", business_type: "corporation"), business: "ABCDE1234F")],
  ["Japanese company of a Japanese resident", info_input({ **JP, is_business: true, business_name: "Yamada KK", business_street_address: "Shibuya", business_city: "渋谷区", business_state: "大阪府", business_zip_code: "150-0002", business_country: "Japan", business_type: "corporation" },
                                                         json: JP_JSON.merge("business_name_kanji" => "山田株式会社", "business_name_kana" => "ヤマダカブシキガイシャ", "business_building_number" => "9-9", "business_building_number_kana" => "9-9",
                                                                             "business_street_address_kanji" => "道玄坂", "business_street_address_kana" => "ドウゲンザカ", "business_city_kana" => "シブヤク"), business: "1234567890123")],
  ["Japanese company without a city", info_input({ **JP, is_business: true, business_name: "Yamada KK", business_country: "Japan", business_state: "東京都", business_type: "corporation" }, json: JP_JSON.merge("business_name_kanji" => "山田"))],
  ["Japanese company of a US resident sends no kanji", info_input({ **JP, country: "United States", is_business: true, business_name: "Yamada KK", business_country: "Japan", business_state: "東京都", business_type: "corporation" }, json: JP_JSON)],
  ["Luxembourg company postal code", info_input({ **BUSINESS, business_country: "Luxembourg", business_zip_code: "L-1234", business_type: "llc" })],
].freeze

ACCOUNT_CASES = []

def account_case(name, input, tos: nil, user_external_id: "1001", profile_url: "https://seller.example.com")
  user = User.new(id: 1001, email: "seller@example.com")
  user.external_id = user_external_id
  user.define_singleton_method(:business_profile_url) { profile_url }
  tos_record = tos && TosAgreement.new(id: 55, ip: tos["ip"], created_at: Time.utc(*tos["created_at"]))
  info = input && build_info(input)
  info&.user = user
  expected = outcome { MANAGER.send(:account_hash, user, tos_record, info, passphrase: PASSPHRASE) }
  {
    "name" => name,
    "input" => {
      "user" => { "external_id" => user.external_id, "email" => user.email, "business_profile_url" => profile_url },
      "tos" => tos && { "created_at_epoch" => tos_record.created_at.to_time.to_i, "ip" => tos["ip"], "external_id" => tos_record.external_id },
      "info" => input && { "external_id" => info.external_id, "row" => stored_row(info, input) },
    },
    "account_hash" => expected,
  }
end

TOS = { "ip" => "203.0.113.9", "created_at" => [2026, 3, 4, 5, 6, 7] }.freeze
ACCOUNT_CASES.push(
  account_case("US individual with an agreement", info_input(US, individual: "123456789"), tos: TOS),
  account_case("US individual without an agreement", info_input(US, individual: "6789")),
  account_case("US corporation", info_input(BUSINESS, business: "12-3456789", json: { "business_phone" => "+14155550101" }), tos: TOS),
  account_case("Thai individual gets the recipient service agreement", info_input({ **US, country: "Thailand" }), tos: TOS),
  account_case("US company of a Thai resident", info_input({ **BUSINESS, country: "Thailand" }), tos: TOS),
  account_case("Thai company of a US resident", info_input(BUSINESS.merge(business_country: "Thailand")), tos: TOS),
  account_case("Canadian non-profit is a non_profit business", info_input(BUSINESS.merge(business_country: "Canada", business_type: "non_profit"), json: { "business_phone" => "+16135550123" }), tos: TOS),
  account_case("Canadian registered charity is a non_profit business", info_input(BUSINESS.merge(business_country: "Canada", business_type: "registered_charity")), tos: TOS),
  account_case("Canadian corporation is a company", info_input(BUSINESS.merge(business_country: "Canada")), tos: TOS),
  account_case("Canadian resident of a US company adds a support phone", info_input({ **BUSINESS, country: "Canada" }, json: { "business_phone" => "+16135550123" }), tos: TOS),
  account_case("Canadian individual adds a support phone", info_input({ **US, country: "Canada" }, json: { "phone" => "+16135550124" }), tos: TOS),
  account_case("Emirati resident adds a support phone", info_input({ **BUSINESS, country: "United Arab Emirates", business_country: "United Arab Emirates", business_type: "llc" }, json: { "business_phone" => "+97145551234" }), tos: TOS),
  account_case("Emirati individual has no business phone", info_input({ **US, country: "United Arab Emirates" }, json: { "phone" => "+971500000000" }), tos: TOS),
  account_case("Japanese individual", info_input(JP, json: JP_JSON), tos: TOS),
  account_case("values are stripped", info_input(US.merge(first_name: " Ada ", last_name: " Lovelace "), individual: "6789"), tos: TOS, profile_url: " https://seller.example.com "),
  account_case("a business with no name", info_input(BUSINESS.merge(business_name: nil)), tos: TOS),
  account_case("no compliance info and no agreement", nil),
  account_case("an agreement without compliance info", nil, tos: TOS),
  account_case("agreement time in the middle of a second", info_input(US), tos: { "ip" => "2001:db8::1", "created_at" => [2026, 12, 31, 23, 59, 59] }),
)

PERSON_RESULTS = PERSON_CASES.map do |name, input|
  info = build_info(input)
  info.user = User.new(id: 1001, email: "seller@example.com")
  {
    "name" => name,
    "input" => { "email" => "seller@example.com", "info" => { "external_id" => info.external_id, "row" => stored_row(info, input) } },
    "person_hash" => outcome { MANAGER.send(:person_hash, info, PASSPHRASE) },
  }
end

COMPANY_RESULTS = COMPANY_CASES.map do |name, input|
  info = build_info(input)
  {
    "name" => name,
    "input" => { "info" => { "external_id" => info.external_id, "row" => stored_row(info, input) } },
    "company_hash" => outcome { MANAGER.send(:company_hash, info, PASSPHRASE) },
  }
end

# Bank accounts: the legal entity decides the account holder name, the account type and the cross-border flag.
def bank_case(name, klass, attributes, legal_entity: info_input(US), account_number: "000123456789", stripe_account: {}, type_name: klass.name)
  info = build_info(legal_entity)
  user = User.new(id: 1001, email: "seller@example.com")
  user.define_singleton_method(:alive_user_compliance_info) { info }
  bank = klass.new(id: 9, **attributes)
  bank.user = user
  bank.account_number = account_number
  recorded_stripe_account = JSON.parse(JSON.generate(stripe_account))
  # `Hash#to_h` returns the receiver, so a Hash metadata would be written to; Stripe hands the real code a StripeObject.
  expected = outcome { MANAGER.send(:bank_account_hash, bank, stripe_account: JSON.parse(JSON.generate(stripe_account)), passphrase: PASSPHRASE) }
  {
    "name" => name,
    "input" => {
      "bank_account" => {
        "type" => type_name, "external_id" => bank.external_id, "account_number" => Base64.strict_encode64(bank[:account_number]),
        **attributes.transform_keys(&:to_s)
      },
      "info" => { "external_id" => info.external_id, "row" => stored_row(info, legal_entity) },
      "stripe_account" => recorded_stripe_account,
    },
    "bank_account_hash" => expected,
  }
end

ACH = { bank_number: "110000000", account_type: "checking", account_holder_full_name: "Ada Lovelace" }.freeze
BANK_RESULTS = [
  bank_case("ACH account of a US seller", AchAccount, ACH),
  bank_case("account number with spaces and dashes", AchAccount, ACH, account_number: "0001 2345-6789"),
  bank_case("ACH routing number with spaces and lowercase", AchAccount, ACH.merge(bank_number: " 11000000a ")),
  bank_case("ACH account with a blank routing number", AchAccount, ACH.merge(bank_number: "  ")),
  bank_case("ACH account of a Japanese seller carries the holder name", AchAccount, ACH, legal_entity: info_input(JP, json: JP_JSON)),
  bank_case("ACH account of a Vietnamese seller carries the holder name", AchAccount, ACH, legal_entity: info_input(US.merge(country: "Vietnam"))),
  bank_case("ACH account of an Indonesian seller carries the holder name", AchAccount, ACH, legal_entity: info_input(US.merge(country: "Indonesia"))),
  bank_case("ACH account of an Ecuadorian company carries the holder name", AchAccount, ACH, legal_entity: info_input(BUSINESS.merge(business_country: "Ecuador"))),
  bank_case("ACH account of an Ecuadorian individual does not", AchAccount, ACH, legal_entity: info_input(US.merge(country: "Ecuador"))),
  bank_case("ACH account of a Chilean seller carries the account type", AchAccount, ACH, legal_entity: info_input(US.merge(country: "Chile"))),
  bank_case("ACH account of a Colombian seller carries the account type", AchAccount, ACH, legal_entity: info_input(US.merge(country: "Colombia"))),
  bank_case("ACH account of a Chilean seller without an account type", AchAccount, ACH.merge(account_type: nil), legal_entity: info_input(US.merge(country: "Chile"))),
  bank_case("ACH account of a Chilean seller with a blank account type", AchAccount, ACH.merge(account_type: ""), legal_entity: info_input(US.merge(country: "Chile"))),
  bank_case("ACH account of a Gibraltar seller strips the routing number", AchAccount, ACH.merge(bank_number: "12 34-56"), legal_entity: info_input(US.merge(country: "Gibraltar"))),
  bank_case("ACH account of a Thai seller pays out cross-border", AchAccount, ACH, legal_entity: info_input(US.merge(country: "Thailand"))),
  bank_case("ACH account of a company in a cross-border country", AchAccount, ACH, legal_entity: info_input(BUSINESS.merge(business_country: "Mexico"))),
  bank_case("Canadian account", CanadianBankAccount, { bank_number: "004", branch_code: "12345", account_holder_full_name: "Ada Lovelace" }, legal_entity: info_input(US.merge(country: "Canada")), type_name: "CanadianBankAccount"),
  bank_case("UK account", UkBankAccount, { bank_number: "20-00-00", account_holder_full_name: "Ada Lovelace" }, legal_entity: info_input(US.merge(country: "United Kingdom")), account_number: "55779911", type_name: "UkBankAccount"),
  bank_case("Australian account", AustralianBankAccount, { bank_number: "110-000", account_holder_full_name: "Ada Lovelace" }, legal_entity: info_input(US.merge(country: "Australia")), account_number: "000123456", type_name: "AustralianBankAccount"),
  bank_case("existing metadata is kept and the bank account id appended", AchAccount, ACH, stripe_account: { "metadata" => { "user_id" => " 1001 ", "tos_agreement_id" => "tos" } }),
  bank_case("metadata of null", AchAccount, ACH, stripe_account: { "metadata" => nil }),
  bank_case("account number of only spaces", AchAccount, ACH, account_number: " - "),
  bank_case("no legal entity country", AchAccount, ACH, legal_entity: info_input(US.merge(country: nil))),
  bank_case("holder name with spaces", AchAccount, ACH.merge(account_holder_full_name: " Ada Lovelace "), legal_entity: info_input(JP, json: JP_JSON)),
].freeze

data = {
  "cross_border_payouts_alpha2" => Country.const_get(:CROSS_BORDER_PAYOUTS_COUNTRIES).map(&:alpha2),
  "japan_prefecture_kana" => Compliance::Countries.const_get(:JAPAN_PREFECTURE_KANA),
}
File.write(DATA_OUT, "#{JSON.pretty_generate(data)}\n")
File.write(GOLDEN_OUT, "#{JSON.pretty_generate({ "passphrase_configured" => PASSPHRASE.present?, "account" => ACCOUNT_CASES, "person" => PERSON_RESULTS, "company" => COMPANY_RESULTS, "bank" => BANK_RESULTS })}\n")
puts "wrote #{DATA_OUT.relative_path_from(Rails.root)} and #{GOLDEN_OUT.relative_path_from(Rails.root)} (#{ACCOUNT_CASES.size} account, #{PERSON_RESULTS.size} person, #{COMPANY_RESULTS.size} company, #{BANK_RESULTS.size} bank)"
