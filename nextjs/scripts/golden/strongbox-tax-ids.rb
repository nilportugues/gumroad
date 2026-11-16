# frozen_string_literal: true

# Writes src/server/models/__fixtures__/strongbox-tax-ids.golden.json: tax ids as Strongbox stores them
# (RSA, PKCS#1 v1.5, with the test key from .env.test) next to what SettingsPresenter#tax_id_last_four
# and #tax_id_is_last_four_only? answer for them, so models/strongbox.ts and models/user-compliance-info.ts
# can be checked against Ruby.
#
#   RAILS_ENV=test bin/rails runner nextjs/scripts/golden/strongbox-tax-ids.rb
require "base64"
require "json"

PLAINTEXTS = {
  "nine zeros" => "000000000",
  "ssn with dashes" => "123-45-6789",
  "padded with spaces" => " 1234 ",
  "three characters" => "abc",
  "four digits" => "1234",
  "four digits split by a space" => "12 34",
  "narrow no-break spaces" => " 9876 ",
  "letters and digits" => "AB-12-CD-34",
  "arabic indic digits" => "٠١٢٣٤٥٦٧",
  "multibyte prefix" => "日本語1234",
  "invalid utf-8 byte" => "\xFF12345678".b,
  "blank" => "",
}.freeze

presenter = SettingsPresenter.new(pundit_user: SellerContext.logged_out)
cases = PLAINTEXTS.map do |name, plaintext|
  info = UserComplianceInfo.new
  info.individual_tax_id = plaintext
  ciphertext = info[:individual_tax_id]
  {
    "name" => name,
    "ciphertext" => ciphertext.nil? ? nil : Base64.strict_encode64(ciphertext),
    "plaintext_base64" => Base64.strict_encode64(plaintext),
    "present" => info.individual_tax_id.present?,
    "last_four" => presenter.send(:tax_id_last_four, info.individual_tax_id),
    "is_last_four_only" => presenter.send(:tax_id_is_last_four_only?, info.individual_tax_id),
  }
end
File.write(Rails.root.join("nextjs/src/server/models/__fixtures__/strongbox-tax-ids.golden.json"), "#{JSON.pretty_generate(cases)}\n")
