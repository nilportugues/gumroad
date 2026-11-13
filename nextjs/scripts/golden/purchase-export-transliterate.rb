# frozen_string_literal: true

# Produces nextjs/src/server/exports/__fixtures__/purchase-export-transliterate.golden.json: what
# ActiveSupport::Inflector.transliterate (Exports::PurchaseExportService#pseudo_transliterate) answers for every code point
# from U+0080 to U+10FFFF, kept when it is not the replacement "?", plus whole strings. No rows are needed.
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_test_29 TEST_DATABASE_NAME=gumroad_test_29 DISABLE_TEST_REDIS_ISOLATION=1 \
#     bundle exec ruby bin/rails runner nextjs/scripts/golden/purchase-export-transliterate.rb
OUT = Rails.root.join("nextjs/src/server/exports/__fixtures__/purchase-export-transliterate.golden.json")
SAMPLES = ["Marktstraße", "München", "São Paulo", "é", "Ångström", "東京", "Zürich?", "Ünï?", "a b", "ǅ", "ﬃ", "😀", "Å", "Å", "Ａ"].freeze

table = {}
(0x80..0x10FFFF).each do |code_point|
  next if (0xD800..0xDFFF).cover?(code_point)
  char = [code_point].pack("U")
  transliterated = ActiveSupport::Inflector.transliterate(char)
  table[char] = transliterated unless transliterated == "?"
end

File.write(OUT, "#{JSON.pretty_generate(
  ruby: RUBY_VERSION, rails: Rails.version, i18n: I18n::VERSION, locale: I18n.locale.to_s,
  table:,
  samples: SAMPLES.index_with { |string| ActiveSupport::Inflector.transliterate(string) },
)}\n")
