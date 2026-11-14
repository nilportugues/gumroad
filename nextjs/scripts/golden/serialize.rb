# frozen_string_literal: true

# Golden vectors for nextjs/src/server/models/concerns/serialized-columns.ts: runs ActiveRecord's
# own column coders (`serialize ..., coder: YAML` and `coder: JSON`) over values shaped like the
# ones the eight serialized columns store, and records the exact text written to MySQL.
#
#   bundle exec ruby nextjs/scripts/golden/serialize.rb
# Pinned to Gemfile.lock so a standalone run matches production.
gem "json", "2.13.2"
gem "psych", "5.2.6"
gem "activerecord", "8.1.3.1"
require "json"
require "active_record"

ROOT = File.expand_path("../../..", __dir__)
OUT = File.join(ROOT, "nextjs/src/server/models/concerns/__fixtures__/serialize.golden.json")
ActiveRecord.yaml_column_permitted_classes = [Symbol] # Rails 8.1 default

# Values cross into TypeScript tagged, because JSON cannot tell 1 from 1.0 or a Symbol from a String.
def tag(value)
  case value
  when nil, true, false then value
  when String then value
  when Symbol then { "$sym" => value.to_s }
  when Integer then { "$int" => value.to_s }
  when Float then { "$float" => value.nan? ? "NaN" : value.infinite? ? (value.positive? ? "Infinity" : "-Infinity") : value.to_s }
  when Array then value.map { tag(_1) }
  when Hash then { "$hash" => value.map { |k, v| [tag(k), tag(v)] } }
  else raise "untaggable #{value.class}"
  end
end

long_words = (1..30).map { "word#{_1}" }.join(" ")
STRINGS = [
  "", " ", "  ", "a", "abc", "hello world", " leading", "trailing ", " both ", "a  b", "a   b",
  "y", "Y", "n", "N", "yes", "Yes", "YES", "no", "No", "true", "True", "TRUE", "false", "on", "On", "off", "OFF",
  "null", "Null", "NULL", "nULL", "~", "nil",
  "0", "1", "123", "-1", "+1", "0123", "089", "0_8", "1_000", "1,000", "1__0", "_1", "0x1F", "0b101", "0o17",
  "1.5", ".5", "1.", "-.", ".", "..", "0.", "+.5", "1e3", "1.0e+3", "1.0e-3", ".inf", "-.inf", "+.inf", ".nan", ".NaN", ".Inf",
  "12:30", "1:2:3", "190:20:30", "1:20.5", "2024-01-01", "2024-1-1", "2024-13-45", "2024-02-30", "2024-01-01 10:00:00",
  "2024-01-01T10:00:00Z", "2024-01-01 10:00:00.123 +02:00",
  ":sym", ":", "::", ":a b", ":\"quoted\"",
  "<<", "-", "--", "---", "--- a", "...", "... x", "-a", "- a", "?", "?x", "? x", "x?", ": x", "a: b", "a:b", "a:", "foo: ",
  "a #b", "a#b", "#x", "@x", "`x", "%x", "!x", "&x", "*x", "|x", ">x", "'x", "\"x", "x'y", "x\"y", "x\\y", "[x", "{x", "x,y", "x]", "x}",
  ",x", "]x", "x[y]", "a, b", "a , b",
  "\t", "a\tb", "\ta", "a\t",
  "a\n", "a\nb", "a\n\n", "\na", "\n", "\n\n", "a\n b", " a\nb", "a \nb", "a\n\nb", "a\nb\n", "a\nb\n\n", "a\r\nb", "a\rb", "a\r",
  "é", "naïve café", "日本語", "😀", "a😀b", "\u0085", "a\u0085b", " ", "a b", "﻿", "a﻿b", " ", "a b",
  "\u0000", "\u0007", "\u001B", "\u007F", "a\u0001b", "­",
  long_words, "#{long_words} ", " #{long_words}", "#{long_words}  #{long_words}", "@#{long_words}", "'#{long_words}'",
  "#{long_words}: x", "x" * 100, "#{"x" * 85} y", "#{"y" * 79} z #{"w" * 79} q", "#{long_words}\n#{long_words}",
  "#{long_words}\tend", "#{long_words} 😀", "a #{"b " * 50}c", "#{"word " * 20}", "#{"0" * 81} 1",
  "https://www.youtube.com/watch?v=abc&feature=oembed",
  "<iframe width=\"480\" height=\"270\" src=\"https://www.youtube.com/embed/x?feature=oembed\" frameborder=\"0\" allowfullscreen></iframe>",
]

VALUES = [
  nil, true, false, 0, 1, -1, 42, 2**31, 2**53 + 1, 2**62, -(2**62), 12345678901234567890,
  0.0, -0.0, 1.0, 1.5, 0.1, 100.0, 1e15, 1e16, 1.5e16, 1e-4, 1e-5, 0.0001, 1.23456789012345e+15, 123456789.123456789,
  12.34, 9.99, 1e14, 9999999999999998.0, 1234567890123456.7, 123456789012345.6, 5e-324, 1.7976931348623157e308, 0.00012, 12345678.9, 1e100, 2.5e-300, Float::INFINITY, -Float::INFINITY, Float::NAN,
  :foo, :"foo bar", :"1", :"", :"a: b",
  [], {}, [[]], [{}], { "a" => [] }, { "a" => {} },
  STRINGS,
  *STRINGS.map { |s| { "v" => s } },
  *STRINGS.map { |s| { s => 1 } },
  *STRINGS.map { |s| [s, [s]] },

  { "nested" => { "deeper" => { "list" => [1, "two", 3.0, nil, true, [4, [5]], { "x" => "y" }] } } },
  [[1, 2], [3, [4, [5]]], { "a" => [{ "b" => 1 }] }],
  [{ "a" => 1, "b" => 2 }, { "c" => { "d" => [] } }],
  { "#{"k" * 130}" => 1, "multi\nline" => 2, "y" => 3, "1" => 4, "" => 5, " " => 6 },
  { 1 => "int key", :sym_key => "symbol key", nil => "nil key", true => "bool key", 1.5 => "float key" },
  # app/models/asset_preview.rb: oembed (an Embedly-style response, stringified keys)
  { "html" => "<iframe width=\"480\" height=\"270\" src=\"https://www.youtube.com/embed/abc?feature=oembed\" frameborder=\"0\" allow=\"accelerometer; autoplay\" allowfullscreen title=\"Video: a title, with \\\"quotes\\\" & stuff\"></iframe>",
    "info" => { "width" => 480, "height" => 270, "thumbnail_url" => "https://i.ytimg.com/vi/abc/hqdefault.jpg", "provider_name" => "YouTube", "title" => "Café — the 😀 video", "version" => "1.0", "type" => "video", "author_url" => "https://www.youtube.com/@someone" } },
  # app/models/user_compliance_info.rb: verticals
  ["Retail", "Software", "Food & Beverage", "Other: specify"],
  # app/models/sales_export.rb: query (an Elasticsearch query, deep_stringify_keys)
  { "bool" => { "filter" => [{ "term" => { "seller_id" => 123 } }, { "terms" => { "product_id" => [1, 2, 3] } }, { "range" => { "created_at" => { "gte" => "2024-01-01T00:00:00Z", "lt" => "2024-02-01T00:00:00+05:30" } } }], "must_not" => [{ "term" => { "stripe_refunded" => true } }], "minimum_should_match" => 1 } },
  # app/models/sales_export_chunk.rb: purchase_ids, custom_fields, purchases_data
  [1, 2, 3, 2**40],
  ["Size", "Do you agree? (yes/no)", "Address: line 1", "- note"],
  [[{ "Purchase ID" => "abc123==", "Item Name" => "Course: Part 1", "Buyer Name" => nil, "Purchase Date" => "2024-01-01", "Purchase Time (UTC timezone)" => "2024-01-01 10:00:00 UTC", "Subtotal ($)" => 9.99, "Taxes ($)" => 0.0, "Tip ($)" => 0.5, "Do not contact?" => 0, "Zip Code" => "02134", "Variants" => "(Large)", "Referrer" => "direct" }, { "Size" => "L", "Note" => "a\nmultiline note" }]],
]

# The attribute type `serialize` installs: it also maps the coder default (nil, or [] for
# `type: Array`) to NULL, which is why an empty verticals list is stored as NULL.
def serialized_type(coder) = ActiveRecord::Type::Serialized.new(ActiveRecord::Type::Text.new, coder)
def yaml_type(klass) = serialized_type(ActiveRecord::Coders::YAMLColumn.new(:attr, klass))
def type_name(value) = case value when Array then "Array" when Hash then "Hash" else "Object" end

yaml_vectors = VALUES.map do |value|
  type = yaml_type(Object.const_get(type_name(value)))
  dumped = type.serialize(value)
  loaded = begin
    type.deserialize(dumped)
  rescue Psych::DisallowedClass => e
    next({ "type" => type_name(value), "input" => tag(value), "yaml" => dumped, "loads_back" => { "$error" => e.class.name } })
  end
  same = value.is_a?(Float) && value.nan? ? loaded.nan? : loaded == value
  { "type" => type_name(value), "input" => tag(value), "yaml" => dumped, "loads_back" => same ? true : tag(loaded) }
end

# Loads of payloads Psych would never write, but that a coder must still read.
LOAD_ONLY = ["", "--- \n...\n", "--- []\n", "--- {}\n", "---\n- 1\n- 2\n", "--- 2024-02-30\n", "---\n- 'a'\n- \"b\\tc\"\n- |\n  lit\n- >\n  folded\n  text\n", "--- !binary |-\n  aGVsbG8=\n", "[1, 2]", "{a: 1}"]
load_vectors = LOAD_ONLY.map do |payload|
  loaded = begin
    tag(yaml_type(Object).deserialize(payload))
  rescue => e
    { "$error" => e.class.name }
  end
  { "yaml" => payload, "loaded" => loaded }
end

json_vectors = VALUES.reject { _1.is_a?(Float) && !_1.finite? }.reject { _1.is_a?(Hash) && _1.keys.any? { |k| !k.is_a?(String) } }.map do |value|
  type = serialized_type(ActiveRecord::Coders::ColumnSerializer.new(:attr, ::JSON))
  dumped = type.serialize(value)
  { "input" => tag(value), "json" => dumped, "loaded" => tag(type.deserialize(dumped)) }
end

File.write(OUT, JSON.pretty_generate({ "psych" => Psych::VERSION, "libyaml" => Psych::LIBYAML_VERSION, "json_version" => JSON::VERSION, "yaml" => yaml_vectors, "yaml_load" => load_vectors, "json" => json_vectors }) + "\n")
warn "Wrote #{yaml_vectors.size} YAML, #{load_vectors.size} YAML load and #{json_vectors.size} JSON vectors"
