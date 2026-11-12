# frozen_string_literal: true

# Writes nextjs/parity/golden/ruby-to-i.json: what `String#to_i` and `Float#to_i` answer for the fee_percent values a JSON body can carry
# (AffiliatesController reads `affiliate_params[:fee_percent].to_i * 100`), so the port's `rubyToI` is pinned by Ruby itself.
#
#   docker exec <ruby container> ruby nextjs/parity/golden/ruby-to-i.rb
require "json"

STRINGS = [
  "", " ", "0", "7", "10", "75", "+5", "-5", "00012", " 12", "\t\n 12", "12 ", "12abc", "abc", "abc12", "1_000", "1__000", "1_", "_1",
  "10.9", "10.5e2", ".5", "1e3", "0x1f", "0b11", "-0", "٣", "１２", "99999999999999999999",
].freeze
NUMBERS = [0, 1, 10, 25, 75, -3, 12.9, 0.5, -0.5, 99.99, 1e20].freeze

golden = { "strings" => STRINGS.to_h { |value| [value, value.to_i] }, "numbers" => NUMBERS.to_h { |value| [value.to_s, value.to_i] } }
File.write(File.expand_path("ruby-to-i.json", __dir__), "#{JSON.pretty_generate(golden)}\n")
