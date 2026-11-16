# frozen_string_literal: true

# Golden vectors for nextjs/src/server/controllers/number-with-delimiter.ts: ActionView's number_with_delimiter on the strings
# Redis can hold for HomePageNumbersController ("$#{number_with_delimiter(value)}"). Writes
# nextjs/src/server/controllers/__fixtures__/number-with-delimiter.golden.json.
#
#   ruby nextjs/scripts/golden/number-with-delimiter.rb      (needs actionview from Gemfile.lock on GEM_PATH)
gem "actionview", "8.1.3.1"
require "json"
require "active_support"
require "active_support/core_ext"
require "action_view"

include ActionView::Helpers::NumberHelper

OUT = File.expand_path("../../src/server/controllers/__fixtures__/number-with-delimiter.golden.json", __dir__)

VALUES = [nil, "", "0", "7", "123", "1234", "1234567", "1234.5", "1234567.891", "-1234", "+1234", "-1234567.5", "007", "n/a", "abc", "12abc", "$1234",
          "1,234", "1_000", "1e3", "1.5e3", " 12 ", " ", "1234 ", ".5", "5.", "1234.", "0x1A", "Infinity", "NaN", "９９９９", "12345678901234567890"].freeze

cases = VALUES.map do |value|
  { "input" => value, "output" => "$#{number_with_delimiter(value)}" }
rescue StandardError => error
  { "input" => value, "raises" => error.class.name }
end

File.write(OUT, "#{JSON.pretty_generate(cases)}\n")
puts "wrote #{cases.size} cases to #{OUT}"
