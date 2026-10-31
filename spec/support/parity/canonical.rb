# frozen_string_literal: true

require "base64"
require "date"
require "json"
require "time"

module Parity
  # JSON-safe canonical forms for recorded values. nextjs/parity/src/canonical.ts is the other
  # half: both must produce the same output, and nextjs/parity/__tests__/canonical-vectors.json
  # is run against each (canonical_test.rb, canonical.test.ts). Change all four together.
  #
  # Stdlib only, so the vector test runs without the Rails bundle.
  module Canonical
    # Wall-clock values are stored relative to the exchange's start ("now"), so a fixture
    # recorded today replays the same tomorrow. Rounding is coarse on purpose: a factory's
    # `2.days.ago` lands a few hundred milliseconds before the request, and that jitter must
    # not reach the fixture.
    NOW_TOLERANCE_SECONDS = 5
    MAX_SAFE_INTEGER = (2**53) - 1

    INTEGER_TYPES = %w[tinyint smallint mediumint int bigint bit].freeze
    TIME_TYPES = %w[datetime timestamp].freeze
    BINARY_TYPES = %w[binary varbinary tinyblob blob mediumblob longblob].freeze

    ISO_TIME = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/

    module_function

    def quote_identifier(name)
      "`#{name.gsub("`", "``")}`"
    end

    # Every value is read back as a string so Ruby and Node see the same bytes regardless of
    # their drivers' type casting.
    def select_expression(column, data_type)
      quoted = quote_identifier(column)
      case data_type
      when *BINARY_TYPES then "TO_BASE64(#{quoted})"
      when "bit" then "CAST(CAST(#{quoted} AS UNSIGNED) AS CHAR)"
      else "CAST(#{quoted} AS CHAR)"
      end
    end

    def db_value(raw, data_type, now)
      return nil if raw.nil?

      raw = raw.to_s
      case data_type
      when *INTEGER_TYPES then integer(Integer(raw, 10))
      when *TIME_TYPES then (time = parse_db_time(raw)) ? time_token(time, now) : raw
      when "date" then (date = parse_date(raw)) ? date_token(date, now) : raw
      when *BINARY_TYPES then { "$base64" => raw.delete("\n") }
      else raw
      end
    end

    def integer(value)
      value.abs > MAX_SAFE_INTEGER ? { "$big" => value.to_s } : value
    end

    def time_token(time, now)
      delta = time.to_r - now.to_r
      return "<now>" if delta.abs <= NOW_TOLERANCE_SECONDS

      "<now#{offset(delta)}>"
    end

    def date_token(date, now)
      days = (date - now.getutc.to_date).to_i
      days.zero? ? "<today>" : "<today#{days.negative? ? "-" : "+"}#{days.abs}d>"
    end

    def offset(seconds)
      sign = seconds.negative? ? "-" : "+"
      abs = seconds.abs.to_f
      if abs < 60 then "#{sign}#{round_half_up(abs / 5) * 5}s"
      elsif abs < 86_400 then "#{sign}#{round_half_up(abs / 60)}m"
      else "#{sign}#{round_half_up(abs / 3600)}h"
      end
    end

    # Matches JavaScript's Math.round for the non-negative values offset passes in.
    def round_half_up(value)
      (value + 0.5).floor
    end

    # Rails writes UTC into DATETIME columns; "0000-00-00 ..." and other junk stay raw.
    def parse_db_time(raw)
      Time.iso8601("#{raw.sub(" ", "T")}Z")
    rescue ArgumentError
      nil
    end

    def parse_date(raw)
      Date.iso8601(raw)
    rescue Date::Error
      nil
    end

    # Deep-normalises a JSON-like value: unsafe integers become { "$big" } and ISO 8601
    # timestamps inside strings become tokens.
    def json(value, now)
      case value
      when Hash then value.to_h { |k, v| [k.to_s, json(v, now)] }
      when Array then value.map { json(_1, now) }
      when Integer then integer(value)
      when String then string(value, now)
      when Symbol then value.to_s
      when Float, true, false, nil then value
      when Time, DateTime then time_token(value.to_time, now)
      when Date then date_token(value, now)
      else json(value.respond_to?(:as_json) ? value.as_json : value.to_s, now)
      end
    end

    def string(value, now)
      return value unless value.match?(ISO_TIME)

      value.gsub(ISO_TIME) do |match|
        time_token(Time.iso8601(match), now)
      rescue ArgumentError
        match
      end
    end

    # A table dump is { "columns" => [[name, type], ...], "primaryKey" => [names], "rows" => [[raw, ...]] }
    # with raw values as select_expression returns them, in primary-key order.
    def row(dump, raw_row, now)
      dump.fetch("columns").each_with_index.to_h do |(name, type), index|
        [name, db_value(raw_row[index], type, now)]
      end
    end

    # Changes are detected on raw values, so an updated_at that moved within the "<now>"
    # tolerance still shows up as changed even though both sides print the same token.
    def diff(before, after, now)
      (before.keys | after.keys).sort.each_with_object({}) do |table, out|
        dump = after[table] || before[table]
        old_rows = index_rows(dump, before.dig(table, "rows") || [])
        new_rows = index_rows(dump, after.dig(table, "rows") || [])

        inserted = new_rows.except(*old_rows.keys).values.map { row(dump, _1, now) }
        deleted = old_rows.except(*new_rows.keys).values.map { row(dump, _1, now) }
        updated = old_rows.filter_map do |key, old_row|
          new_row = new_rows[key]
          next if new_row.nil? || new_row == old_row

          changes = dump.fetch("columns").each_with_index.filter_map do |(name, type), index|
            next if old_row[index] == new_row[index]

            [name, [db_value(old_row[index], type, now), db_value(new_row[index], type, now)]]
          end
          { "key" => key_of(dump, old_row, now), "changes" => changes.to_h }
        end

        changes = { "inserted" => inserted, "updated" => updated, "deleted" => deleted }.reject { |_, v| v.empty? }
        out[table] = changes unless changes.empty?
      end
    end

    def index_rows(dump, rows)
      positions = primary_key_positions(dump)
      rows.to_h { |raw_row| [JSON.generate(positions ? raw_row.values_at(*positions) : raw_row), raw_row] }
    end

    def key_of(dump, raw_row, now)
      full = row(dump, raw_row, now)
      positions = primary_key_positions(dump)
      positions ? full.slice(*dump.fetch("primaryKey")) : full
    end

    def primary_key_positions(dump)
      names = dump.fetch("columns").map(&:first)
      keys = dump.fetch("primaryKey")
      keys.empty? ? nil : keys.map { names.index(_1) }
    end
  end
end
