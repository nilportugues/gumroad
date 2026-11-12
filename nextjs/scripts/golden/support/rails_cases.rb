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
#   es          with capture_elasticsearch!, every Elasticsearch request (answered 200 {})
#   http        with capture_http!, every other outbound request (method, url, headers, body), answered
#               from the case's `http_responses:` in order ({status:, body:, headers:}), 200 {} after that
#   redis_before  with `setup:`, the scratch Redis the case started from
#
# Sidekiq-unique-jobs is switched on (the test environment turns it off) and SecureRandom.hex(12)
# is sequential, so jids and lock digests are reproducible.
require_relative "rails_recorder"
require_relative "sidekiq_executor"
require "socket"

# A local socket in place of Elasticsearch: records each request and answers 200 {}.
module EsCapture
  class << self
    def requests = (@requests ||= [])

    # The answer body; a case sets it with `es_body:` (any JSON), else `{}`.
    attr_writer :body

    def body = (@body || "{}")

    # One answer per request in order, `body` after they run out; a case sets it with `es_bodies:`.
    attr_writer :bodies

    def next_body = (@bodies&.shift || body)

    def start
      server = TCPServer.new("127.0.0.1", 0)
      Thread.new { loop { serve(server.accept) } }
      server.addr[1]
    end

    def serve(socket)
      method, target = socket.gets.split(" ")
      headers = {}
      while (line = socket.gets) && line != "\r\n"
        key, value = line.split(": ", 2)
        headers[key.downcase] = value.strip
      end
      body = headers["content-length"] ? socket.read(headers["content-length"].to_i) : nil
      path, query = target.split("?", 2)
      requests << { "method" => method, "path" => path, "query" => query, "body" => body }
      answer = next_body
      socket.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: #{answer.bytesize}\r\nConnection: close\r\n\r\n#{answer}")
    ensure
      socket.close
    end
  end
end

# Answers every outbound HTTP request (HTTParty, Net::HTTP, Faraday) from WebMock and records it; nothing leaves the machine.
module HttpCapture
  class << self
    def requests = (@requests ||= [])

    attr_writer :responses

    def next_response = (@responses&.shift || {})

    # WebMock hands the stub a normalized URI (`@` and `/` unescaped in a query); the request line Net::HTTP wrote is what a vendor sees.
    def wire_paths = (@wire_paths ||= [])

    def start
      require "webmock"
      WebMock.enable!
      WebMock::NetHTTPUtility.singleton_class.prepend(Module.new do
        def request_signature_from_request(net_http, request, body = nil)
          HttpCapture.wire_paths << request.path
          super
        end
      end)
      WebMock.disable_net_connect!(allow: [/127\.0\.0\.1/, /elasticsearch/, /dynamodb/, /minio/, /redis/])
      WebMock.stub_request(:any, /./).to_return do |request|
        requests << { "method" => request.method.to_s.upcase, "url" => request.uri.to_s, "wire_path" => wire_paths.shift, "headers" => request.headers.to_h.sort.to_h, "body" => request.body }
        answer = next_response
        { status: answer[:status] || 200, body: answer[:body] || "{}", headers: answer[:headers] || {} }
      end
    end
  end
end

module RailsCases
  include ActiveSupport::Testing::TimeHelpers

  REDIS_URL = ENV.fetch("SIDEKIQ_REDIS_HOST").then { "redis://#{_1}" }
  abort "Refusing to run against Redis db 0" if REDIS_URL.end_with?("/0") || !REDIS_URL.match?(%r{/\d+\z})
  abort "Refusing to run against #{ActiveRecord::Base.connection_db_config.database}" unless ActiveRecord::Base.connection_db_config.database.match?(/_(ws)?\d+[a-z]?\z/)

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

  # Points every searchable model at EsCapture; cases then record their requests under "es".
  def capture_elasticsearch!
    port = EsCapture.start
    client = Elasticsearch::Client.new(host: "http://127.0.0.1:#{port}", retry_on_failure: 5, transport_options: { request: { timeout: 15 } })
    Object.send(:remove_const, :EsClient)
    Object.const_set(:EsClient, client)
    Elasticsearch::Model.client = client
    [Link, Purchase, Installment, AudienceMember, ConfirmedFollowerEvent, ProductPageView].each { _1.__elasticsearch__.client = client }
    @capture_es = true
  end

  def capture_http!
    HttpCapture.start
    @capture_http = true
  end

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
    # A join table such as taxonomy_hierarchies has no id: order by the first column then.
    order = ActiveRecord::Base.connection.column_exists?(table, "id") ? "id" : "1"
    result = ActiveRecord::Base.connection.select_all("SELECT * FROM #{ActiveRecord::Base.connection.quote_table_name(table)} ORDER BY #{order}")
    { "fields" => result.columns, "rows" => result.rows.map { |row| row.map { RailsRecorder.encode_value(_1) } } }
  end

  # Runs `block` as one case. `tables` are truncated first and dumped afterwards; `setup` runs after
  # the Redis flush and before recording starts (Flipper gates live in that Redis).
  #
  # `sidekiq: true` runs it as production Sidekiq runs a job (sidekiq_executor.rb), query cache on; the
  # generator must then run with USE_DB_WORKER_REPLICAS=true. Otherwise it runs with the cache off,
  # as a model method called outside any executor does.
  def capture(name, now:, tables:, seed: {}, setup: nil, sidekiq: false, **extra)
    seed_sql = reset(tables, seed)
    redis.flushdb
    setup&.call
    redis_before = setup ? snapshot_redis(redis) : nil
    Rails.cache.clear
    $jid_seq = 0
    EsCapture.requests.clear
    EsCapture.body = extra[:es_body]&.to_json
    EsCapture.bodies = extra[:es_bodies]&.map(&:to_json)
    HttpCapture.requests.clear
    HttpCapture.responses = extra[:http_responses]&.dup
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
    }.merge(@capture_es ? { "es" => EsCapture.requests.dup } : {})
     .merge(@capture_http ? { "http" => HttpCapture.requests.dup } : {})
     .merge(redis_before ? { "redis_before" => redis_before } : {})
     .merge(extra.transform_keys(&:to_s))
  end
end
