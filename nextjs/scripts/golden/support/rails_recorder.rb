# frozen_string_literal: true

# Shared by the golden generators that boot the real Rails app (`rails runner` in the test
# environment) against a scratch MySQL database: records every statement the mysql2 driver sends
# and what MySQL answered, in the shape src/worker/jobs/__fixtures__/sql-replay.ts replays, and
# snapshots the scratch Redis the way golden.ts#snapshotRedis does.
#
# Only connection setup and schema reflection are left out of the log, as fake_mysql.rb does.
require "json"
require "bigdecimal"

module RailsRecorder
  SCHEMA_STATEMENT = /\A(SET |SHOW |SELECT @@|SELECT database\(\))|information_schema/

  class << self
    attr_accessor :log

    def recording
      @log = []
      yield
      @log
    ensure
      log = @log
      @log = nil
      log
    end

    def record(client, sql, result)
      return if @log.nil? || sql.match?(SCHEMA_STATEMENT)

      entry = { "sql" => sql }
      entry["result"] =
        if result.respond_to?(:fields) && result.fields
          { "fields" => result.fields, "rows" => result.to_a.map { |row| Array(row).map { |v| encode_value(v) } } }
        elsif sql.match?(/\A(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/)
          { "affected" => 0 }
        elsif sql.start_with?("INSERT")
          { "affected" => client.affected_rows, "last_id" => client.last_id }
        else
          { "affected" => client.affected_rows }
        end
      @log << entry
    end

    def record_error(sql, error)
      return if @log.nil? || sql.match?(SCHEMA_STATEMENT)

      @log << { "sql" => sql, "result" => { "error" => { "number" => error.error_number, "message" => error.message } } }
    end

    def encode_value(value)
      case value
      when Time then { "$time" => value.utc.strftime("%Y-%m-%dT%H:%M:%S.%6NZ") }
      when BigDecimal then { "$decimal" => value.to_s("F") }
      when Date then value.iso8601
      else value
      end
    end
  end

  module Client
    def query(sql, *rest, **options)
      result = super
      RailsRecorder.record(self, sql, result)
      result
    rescue Mysql2::Error => e
      RailsRecorder.record_error(sql, e)
      raise
    end
  end
end

Mysql2::Client.prepend(RailsRecorder::Client)

# The Redis keyspace as golden.ts#snapshotRedis reads it.
def snapshot_redis(redis)
  redis.keys("*").sort.to_h do |key|
    type = redis.type(key)
    expires = redis.pttl(key) > 0
    next [key, { "type" => type, "count" => redis.zcard(key), "expires" => expires }] if key == "uniquejobs:changelog"

    value =
      case type
      when "string" then redis.get(key)
      when "list" then redis.lrange(key, 0, -1)
      when "set" then redis.smembers(key).sort
      when "hash" then redis.hgetall(key)
      else redis.zrange(key, 0, -1, withscores: true).map { |member, score| [member, score] }
      end
    [key, { "type" => type, "value" => value, "expires" => expires }]
  end
end
