# frozen_string_literal: true

# Case runner for the golden generators that boot the real app (see rails_recorder.rb). Each case
# starts from empty tables plus its own seed rows, a flushed scratch Redis and an empty cache, runs
# the real Ruby code with the clock frozen, and records:
#
#   statements  every statement sent to MySQL and its answer (sql-replay.ts replays them)
#   redis       the scratch Redis afterwards (Sidekiq pushes and unique-jobs locks)
#   cache       Rails.cache deletes and writes
#   rows        the touched tables afterwards, for the Node run against a real database
#   seed        the INSERTs that set the case up, so Node can start from the same rows
#
# Sidekiq-unique-jobs is switched on (the test environment turns it off) and SecureRandom.hex(12)
# is sequential, so jids and lock digests are reproducible.
require_relative "rails_recorder"
require_relative "sidekiq_executor"

module RailsCases
  include ActiveSupport::Testing::TimeHelpers

  REDIS_URL = ENV.fetch("SIDEKIQ_REDIS_HOST").then { "redis://#{_1}" }
  abort "Refusing to run against Redis db 0" if REDIS_URL.end_with?("/0") || !REDIS_URL.match?(%r{/\d+\z})
  abort "Refusing to run against #{ActiveRecord::Base.connection_db_config.database}" unless ActiveRecord::Base.connection_db_config.database.match?(/_ws\d+\z/)

  def self.included(_)
    Sidekiq::Testing.disable! if defined?(Sidekiq::Testing)
    SidekiqUniqueJobs.config.enabled = true
    $jid_seq = 0
    SecureRandom.singleton_class.prepend(Module.new do
      def hex(n = nil)
        return super unless n == 12

        $jid_seq += 1
        format("%024x", $jid_seq)
      end
    end)
  end

  def redis = (@redis ||= Redis.new(url: REDIS_URL))

  def quoted_insert(table, row)
    c = ActiveRecord::Base.connection
    "INSERT INTO #{c.quote_table_name(table)} (#{row.keys.map { c.quote_column_name(_1) }.join(", ")}) VALUES (#{row.values.map { c.quote(_1) }.join(", ")})"
  end

  def reset(tables, seed)
    c = ActiveRecord::Base.connection
    tables.each { c.execute("TRUNCATE TABLE #{c.quote_table_name(_1)}") }
    sql = seed.flat_map { |table, rows| rows.map { quoted_insert(table, _1) } }
    sql.each { c.execute(_1) }
    sql
  end

  def dump(table)
    result = ActiveRecord::Base.connection.select_all("SELECT * FROM #{ActiveRecord::Base.connection.quote_table_name(table)} ORDER BY id")
    { "fields" => result.columns, "rows" => result.rows.map { |row| row.map { RailsRecorder.encode_value(_1) } } }
  end

  # Runs `block` as one case. `tables` are truncated first and dumped afterwards.
  #
  # `sidekiq: true` runs it as production Sidekiq runs a job (sidekiq_executor.rb), query cache on; the
  # generator must then run with USE_DB_WORKER_REPLICAS=true. Otherwise it runs with the cache off,
  # as a model method called outside any executor does.
  def capture(name, now:, tables:, seed: {}, sidekiq: false, **extra)
    seed_sql = reset(tables, seed)
    redis.flushdb
    Rails.cache.clear
    $jid_seq = 0
    error = nil
    cache = []
    subscriber = ActiveSupport::Notifications.subscribe(/\Acache_(delete|write)\.active_support\z/) do |event, *, payload|
      # mysql2_proxy routes through its own NullStore, not Rails.cache.
      cache << [event.split(".").first, payload[:key]] unless payload[:store] == "ActiveSupport::Cache::NullStore"
    end
    statements = travel_to(now, with_usec: true) do
      RailsRecorder.recording do
        if sidekiq
          SidekiqExecutor.perform { yield }
        else
          # rails runner wraps the whole script in the executor; a model case runs without it.
          ActiveRecord::Base.uncached { yield }
        end
      rescue StandardError => e
        error = { "class" => e.class.name, "message" => e.message }
      end
    end
    ActiveSupport::Notifications.unsubscribe(subscriber)
    {
      "name" => name, "seed" => seed_sql, "error" => error, "statements" => statements,
      "redis" => snapshot_redis(redis), "cache" => cache, "rows" => tables.to_h { [_1, dump(_1)] }.reject { |_, dumped| dumped["rows"].empty? }
    }.merge(extra.transform_keys(&:to_s))
  end
end
