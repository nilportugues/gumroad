# frozen_string_literal: true

# A stand-in for the mysql2 driver, so the real ActiveRecord Mysql2Adapter runs without a server:
# it builds every statement exactly as it would in production, the fake client records the SQL and
# answers from a script. Table metadata comes from db/schema.rb, as `SHOW FULL FIELDS` would.
#
# Only the driver is fake. Quoting, Arel, batching, callbacks and transactions are ActiveRecord's.
require "bigdecimal"
require "tmpdir"

module Mysql2
  class Error < StandardError
    def error_number = nil
  end
  class Error::TimeoutError < Error; end
  class Error::ConnectionError < Error; end

  class Result
    attr_reader :fields
    def initialize(fields, rows) = (@fields, @rows = fields, rows)
    def to_a = @rows
    def size = @rows.size
    def free = nil
  end

  class Client
    FOUND_ROWS = 2
    MULTI_STATEMENTS = 65_536
    OPTION_MULTI_STATEMENTS_ON = 0
    OPTION_MULTI_STATEMENTS_OFF = 1
    attr_reader :query_options
    attr_accessor :automatic_close

    def initialize(_config) = @query_options = {}
    def query(sql) = FakeMysql.query(sql)
    def affected_rows = FakeMysql.affected_rows
    def last_id = FakeMysql.last_id
    def ping = true
    def closed? = false
    def close = nil
    def abandon_results! = nil
    def set_server_option(_) = nil
    def server_info = { version: "8.0.36" }

    # Mysql2::Client#escape (mysql_real_escape_string with an ASCII-compatible charset).
    def escape(string)
      string.gsub(/[\0\n\r\\'"\x1a]/) { |c| { "\0" => "\\0", "\n" => "\\n", "\r" => "\\r", "\\" => "\\\\", "'" => "\\'", '"' => '\\"', "\x1a" => "\\Z" }[c] }
    end
  end
end

# `require "mysql2"` and `gem "mysql2"` in mysql2_adapter.rb must find the stub.
STUB_DIR = Dir.mktmpdir("fake-mysql2")
File.write(File.join(STUB_DIR, "mysql2.rb"), "")
$LOAD_PATH.unshift(STUB_DIR)
at_exit { FileUtils.rm_rf(STUB_DIR) }
module Kernel
  alias_method :__fake_mysql_gem, :gem
  private def gem(name, *requirements) = name == "mysql2" ? true : __fake_mysql_gem(name, *requirements)
end

module FakeMysql
  # A script entry: rows for a SELECT, or affected rows (and insert id) for a write.
  Rows = Struct.new(:fields, :rows)
  Write = Struct.new(:affected, :last_id)

  class Unexpected < StandardError; end

  class << self
    attr_reader :log, :affected_rows, :last_id
    attr_accessor :schema, :indexes

    # `responder` receives each statement and returns Rows, Write or nil (empty rows for a
    # SELECT, one affected row for a write).
    def run(responder)
      @log = []
      @responder = responder
      @next_insert_id = 1000
      yield
      @log
    end

    def query(sql)
      @affected_rows = 0
      return schema_query(sql) if schema_statement?(sql)

      response = @responder.call(sql)
      response = Write.new(0) if response.nil? && sql.match?(/\A(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/)
      response ||= sql.start_with?("SELECT") ? Rows.new([], []) : Write.new(1)
      if response.is_a?(Write) && sql.start_with?("INSERT") && response.last_id.nil?
        response = Write.new(response.affected, @next_insert_id += 1)
      end
      @log << { "sql" => sql, "result" => encode(response) }
      case response
      when Rows then Mysql2::Result.new(response.fields, response.rows)
      when Write
        @affected_rows = response.affected
        @last_id = response.last_id
        nil
      end
    end

    def encode(response)
      case response
      when Rows then { "fields" => response.fields, "rows" => response.rows.map { |row| row.map { |v| encode_value(v) } } }
      when Write then { "affected" => response.affected, "last_id" => response.last_id }.compact
      end
    end

    def encode_value(value)
      case value
      when Time then { "$time" => value.utc.strftime("%Y-%m-%dT%H:%M:%S.%6NZ") }
      when BigDecimal then { "$decimal" => value.to_s("F") }
      else value
      end
    end

    private
      def schema_statement?(sql)
        sql.start_with?("SET ", "SHOW ", "SELECT @@", "SELECT database()") || sql.include?("information_schema")
      end

      def schema_query(sql)
        if (table = sql[/\ASHOW KEYS FROM `([^`]+)`/, 1])
          Mysql2::Result.new(%w[Table Non_unique Key_name Seq_in_index Column_name Collation Sub_part Index_type Index_comment Visible Expression], indexes.fetch(table, []))
        elsif (table = sql[/\ASHOW FULL FIELDS FROM `([^`]+)`/, 1])
          columns = schema.fetch(table) { raise Unexpected, "no table #{table} in db/schema.rb" }
          Mysql2::Result.new(%w[Field Type Collation Null Key Default Extra Privileges Comment], columns)
        elsif sql.include?("information_schema.statistics")
          table = sql[/table_name = '([^']+)'/, 1]
          Mysql2::Result.new(["column_name"], schema.fetch(table).select { |c| c[4] == "PRI" }.map { |c| [c[0]] })
        elsif sql.include?("information_schema.tables")
          table = sql[/table_name = '([^']+)'/, 1]
          names = table ? [table] & schema.keys : schema.keys
          Mysql2::Result.new(["table_name"], names.map { [_1] })
        elsif sql.start_with?("SELECT @@")
          Mysql2::Result.new(["v"], [["STRICT_ALL_TABLES"]])
        else
          Mysql2::Result.new([], [])
        end
      end
  end

  # db/schema.rb's create_table blocks as `SHOW FULL FIELDS` rows.
  class SchemaCapture
    attr_reader :tables, :indexes

    def initialize = (@tables, @indexes = {}, {})
    def define(**) = yield
    def add_foreign_key(*, **) = nil

    def create_table(name, id: :bigint, **)
      columns = []
      columns << ["id", id == :integer ? "int" : "bigint", nil, "NO", "PRI", nil, "auto_increment", "", ""] unless id == false
      indexes = []
      yield TableCapture.new(columns, name, indexes)
      @tables[name] = columns
      @indexes[name] = indexes
    end

    def self.load(path)
      capture = new
      source = File.read(path).sub(/ActiveRecord::Schema\[[\d.]+\]\.define/, "define")
      capture.instance_eval(source, path)
      capture
    end
  end

  class TableCapture
    def initialize(columns, table, indexes) = (@columns, @table, @indexes = columns, table, indexes)

    # `SHOW KEYS` rows, which ActiveRecord reads to skip uniqueness queries a unique index covers.
    def index(columns, name:, unique: false, **)
      Array(columns).each_with_index do |column, i|
        @indexes << [@table, unique ? 0 : 1, name, i + 1, column, "A", nil, "BTREE", "", "YES", nil]
      end
    end

    def method_missing(type, name, **options)
      sql_type = sql_type_for(type, options)
      text = sql_type.match?(/char|text/)
      default = options[:default]
      default = default ? "1" : "0" if default == true || default == false
      default = default&.to_s
      extra = type == :virtual ? (options[:stored] ? "STORED GENERATED" : "VIRTUAL GENERATED") : ""
      @columns << [name, sql_type, text ? "utf8mb4_unicode_ci" : nil, options[:null] == false ? "NO" : "YES", "", default, extra, "", options[:comment].to_s]
    end

    def respond_to_missing?(*) = true

    private
      def sql_type_for(type, options)
        base =
          case type
          when :integer then { 1 => "tinyint", 2 => "smallint", 3 => "mediumint", 8 => "bigint" }.fetch(options[:limit], "int")
          when :bigint then "bigint"
          when :string then "varchar(#{options[:limit] || 255})"
          when :text then { medium: "mediumtext", long: "longtext", tiny: "tinytext" }.fetch(options[:size], options[:limit] ? "#{options[:limit] > 65_535 ? (options[:limit] > 16_777_215 ? "long" : "medium") : ""}text" : "text")
          when :binary then options[:limit] ? "varbinary(#{options[:limit]})" : "blob"
          when :boolean then "tinyint(1)"
          when :datetime then options.key?(:precision) && options[:precision].nil? ? "datetime" : "datetime(#{options[:precision] || 6})"
          when :timestamp then options.key?(:precision) && options[:precision].nil? ? "timestamp" : "timestamp(#{options[:precision] || 6})"
          when :date then "date"
          when :time then "time"
          when :decimal then "decimal(#{options[:precision]},#{options[:scale] || 0})"
          when :float then options[:limit] && options[:limit] > 24 ? "double" : "float"
          when :json then "json"
          when :virtual then sql_type_for(options[:type], options.except(:type))
          else raise ArgumentError, "unknown column type #{type}"
          end
        options[:unsigned] ? "#{base} unsigned" : base
      end
  end
end
