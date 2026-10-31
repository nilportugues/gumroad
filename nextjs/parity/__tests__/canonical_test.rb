# frozen_string_literal: true

# Pins the Ruby recorder's canonical forms to the same vectors canonical.test.ts runs, so the
# two halves cannot drift. Needs no bundle:
#
#   ruby nextjs/parity/__tests__/canonical_test.rb

require "minitest/autorun"
require_relative "../../../spec/support/parity/canonical"

class ParityCanonicalTest < Minitest::Test
  VECTORS = JSON.parse(File.read(File.expand_path("canonical-vectors.json", __dir__)))
  NOW = Time.iso8601(VECTORS.fetch("now"))

  VECTORS.fetch("dbValues").each_with_index do |vector, index|
    define_method("test_db_value_#{index}_#{vector["type"]}") do
      actual = Parity::Canonical.db_value(vector["raw"], vector["type"], NOW)
      vector["expected"].nil? ? assert_nil(actual) : assert_equal(vector["expected"], actual, vector.inspect)
    end
  end

  def test_json_normalises_times_in_strings_and_unsafe_integers
    VECTORS.fetch("json").each do |vector|
      assert_equal vector["expected"], Parity::Canonical.json(vector["input"], NOW)
    end
  end

  def test_diff_reports_inserted_updated_and_deleted_rows_per_table
    vector = VECTORS.fetch("diff")
    assert_equal vector["expected"], Parity::Canonical.diff(vector["before"], vector["after"], NOW)
  end

  def test_time_values_inside_now_tolerance_collapse_to_now
    assert_equal "<now>", Parity::Canonical.json(NOW + 0.4, NOW)
    assert_equal "<now-48h>", Parity::Canonical.json(NOW - (2 * 86_400) - 0.4, NOW)
  end
end
