# frozen_string_literal: true

require_relative "canonical"

module Parity
  # Reads whole tables through the spec's own connection, so it sees rows the example created
  # inside its transaction. nextjs/parity/src/db.ts issues the same SQL on the replay side.
  class DbSnapshot
    IGNORED_TABLES = %w[schema_migrations ar_internal_metadata].freeze

    class << self
      attr_accessor :schema_cache
    end

    def initialize(connection)
      @connection = connection
    end

    # { table => { "columns" => [[name, type]], "primaryKey" => [names] } }, read once per process.
    def schema
      self.class.schema_cache ||= begin
        rows = @connection.select_rows(<<~SQL)
          SELECT c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE, c.COLUMN_KEY
          FROM information_schema.COLUMNS c
          JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
          WHERE c.TABLE_SCHEMA = DATABASE() AND t.TABLE_TYPE = 'BASE TABLE'
          ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION
        SQL
        rows.reject { IGNORED_TABLES.include?(_1[0]) }.group_by(&:first).transform_values do |columns|
          {
            "columns" => columns.map { [_1[1], _1[2].downcase] },
            "primaryKey" => columns.select { _1[3] == "PRI" }.map { _1[1] },
          }
        end
      end
    end

    def non_empty_tables
      sql = schema.keys.map do |table|
        "SELECT #{@connection.quote(table)} FROM DUAL WHERE EXISTS (SELECT 1 FROM #{Canonical.quote_identifier(table)})"
      end.join(" UNION ALL ")
      @connection.select_values(sql).sort
    end

    def dump(tables)
      tables.sort.to_h do |table|
        meta = schema.fetch(table)
        [table, meta.merge("rows" => @connection.select_rows(select_sql(table, meta)))]
      end
    end

    # Live counters: information_schema caches them for a day unless told not to.
    def auto_increments
      @connection.execute("SET SESSION information_schema_stats_expiry = 0")
      @connection.select_rows(<<~SQL).to_h { |table, value| [table, value.to_i] }
        SELECT TABLE_NAME, AUTO_INCREMENT FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND AUTO_INCREMENT > 1 ORDER BY TABLE_NAME
      SQL
    end

    # Fresh counters make recorded ids (and the external ids derived from them) the same on
    # every run. ALTER TABLE commits implicitly, so this must run outside the example's
    # transaction; on tables that still hold rows MySQL clamps the value to MAX(id) + 1.
    def reset_auto_increments!
      auto_increments.each_key do |table|
        @connection.execute("ALTER TABLE #{Canonical.quote_identifier(table)} AUTO_INCREMENT = 1")
      end
    end

    private
      def select_sql(table, meta)
        columns = meta.fetch("columns").map { |name, type| Canonical.select_expression(name, type) }
        order = meta.fetch("primaryKey")
        order = meta.fetch("columns").map(&:first) if order.empty?
        "SELECT #{columns.join(", ")} FROM #{Canonical.quote_identifier(table)} " \
          "ORDER BY #{order.map { Canonical.quote_identifier(_1) }.join(", ")}"
      end
  end
end
