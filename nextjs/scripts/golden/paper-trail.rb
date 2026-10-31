# frozen_string_literal: true

# Golden vectors for nextjs/src/server/models/concerns/paper-trail.ts: runs paper_trail 17 itself
# (JSON serializer, as config/initializers/paper_trail.rb sets) on an in-memory SQLite table whose
# columns cover every attribute type the 31 versioned models have, and records each `versions`
# row it writes. The JSON encoding settings mirror config/application.rb and
# config/initializers/json_time_precision.rb.
#
#   bundle exec ruby nextjs/scripts/golden/paper-trail.rb   (needs the sqlite3 gem)
gem "json", "2.13.2"
gem "activerecord", "8.1.3.1"
gem "paper_trail", "17.0.0"
require "json"
require "active_record"
require "active_support/testing/time_helpers"
require "paper_trail"
require "paper_trail/frameworks/active_record"

ROOT = File.expand_path("../../..", __dir__)
OUT = File.join(ROOT, "nextjs/src/server/models/concerns/__fixtures__/paper-trail.golden.json")

ActiveSupport::JSON::Encoding.time_precision = 0
ActiveSupport.escape_html_entities_in_json = true
ActiveSupport.escape_js_separators_in_json = true
ActiveRecord.default_timezone = :utc
Time.zone = "UTC"
PaperTrail.serializer = PaperTrail::Serializers::JSON

ActiveRecord::Base.establish_connection(adapter: "sqlite3", database: ":memory:")
ActiveRecord::Schema.verbose = false
ActiveRecord::Schema.define do
  create_table :versions do |t|
    t.string :item_type, null: false
    t.bigint :item_id, null: false
    t.string :event, null: false
    t.string :whodunnit
    t.text :object
    t.datetime :created_at
    t.string :remote_ip
    t.text :request_path
    t.string :request_uuid
    t.text :object_changes
  end
  create_table :widgets do |t|
    t.string :name
    t.integer :price_cents
    t.decimal :amount, precision: 10, scale: 2
    t.float :rate
    t.bigint :flags, default: 0, null: false
    t.boolean :active, default: false
    t.text :notes
    t.json :data
    t.text :settings
    t.date :born_on
    t.string :secret
    t.datetime :touched_at
    t.datetime :deleted_at
    t.string :type
    t.timestamps
  end
end

class Widget < ActiveRecord::Base
  has_paper_trail skip: %i[secret], ignore: %i[touched_at]
  serialize :settings, type: Hash, coder: YAML
end

class SpecialWidget < Widget; end

include ActiveSupport::Testing::TimeHelpers

def tag(value)
  case value
  when nil, true, false, String then value
  when Integer then { "$int" => value.to_s }
  when Float then { "$float" => value.to_s }
  when BigDecimal then { "$decimal" => value.to_s("F") }
  when ActiveSupport::TimeWithZone, Time then { "$time" => value.utc.iso8601(6) }
  when Date then { "$date" => value.iso8601 }
  when Array then value.map { tag(_1) }
  when Hash then { "$hash" => value.map { |k, v| [k.to_s, tag(v)] } }
  else raise "untaggable #{value.class}"
  end
end

def version_rows(since_id)
  PaperTrail::Version.where("id > ?", since_id).order(:id).map do |v|
    v.attributes.except("id").transform_values { _1.is_a?(Time) ? _1.utc.iso8601(6) : _1 }
  end
end

PaperTrail.request.whodunnit = "42"
PaperTrail.request.controller_info = { remote_ip: "203.0.113.7", request_path: "/widgets/1", request_uuid: "req-uuid-1" }

steps = []
record = nil
step = lambda do |name, at, &block|
  travel_to(at) do
    last = PaperTrail::Version.maximum(:id) || 0
    before = record ? Widget.columns.to_h { |c| [c.name, record.attribute_in_database(c.name)] } : nil
    block.call
    after = record.destroyed? ? nil : Widget.columns.to_h { |c| [c.name, record.read_attribute(c.name)] }
    steps << {
      "name" => name,
      "now" => Time.current.utc.iso8601(6),
      "before" => before&.transform_values { tag(_1) },
      "after" => after&.transform_values { tag(_1) },
      "versions" => version_rows(last),
    }
  end
end

t0 = Time.utc(2024, 2, 29, 12, 34, 56, 789_123)
step.("create", t0) do
  record = SpecialWidget.create!(
    name: "<b>Café & co</b> x", price_cents: 100, amount: "12.50", rate: 1.0, flags: 2**40, active: true,
    notes: "line1\nline2 \"quoted\" \\ end", data: { "a" => 1, "b" => [1.5, nil, 1e20], "html" => "<x>&</x>" },
    settings: { "k" => "v", "n" => 1 }, born_on: Date.new(2020, 2, 29), secret: "s3cret", touched_at: t0 - 60
  )
end
step.("update", t0 + 61) { record.update!(name: "Plain name", amount: "0.10", data: { "c" => true }, rate: 0.1) }
step.("update skipped column only", t0 + 62) { record.update!(secret: "other") }
step.("update ignored column only", t0 + 63) { record.update!(touched_at: t0 + 63) }
step.("update ignored and tracked columns", t0 + 64) { record.update!(touched_at: t0 + 64, price_cents: 250) }
step.("save without changes", t0 + 65) { record.save! }
step.("update to nil and false", t0 + 66) { record.update!(name: nil, active: false, data: nil, born_on: nil, settings: {}) }
step.("soft delete", t0 + 67) { record.update!(deleted_at: t0 + 67) }
step.("destroy", t0 + 68) { record.destroy! }

columns = Widget.columns.map { |c| { "name" => c.name, "type" => c.type.to_s } }
File.write(OUT, JSON.pretty_generate({ "columns" => columns, "options" => { "skip" => ["secret"], "ignore" => ["touched_at"] }, "steps" => steps }) + "\n")
warn "Wrote #{steps.size} steps with #{steps.sum { _1["versions"].size }} versions"
