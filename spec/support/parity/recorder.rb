# frozen_string_literal: true

require "cgi"
require "digest"
require "fileutils"
require_relative "canonical"
require_relative "db_snapshot"

module Parity
  # Records request and controller spec examples as replayable fixtures for the Next.js port.
  # Inert unless PARITY_RECORD is set:
  #
  #   PARITY_RECORD=1   bin/rspec spec/requests/foo_spec.rb   # examples tagged `parity: true`
  #   PARITY_RECORD=all bin/rspec spec/requests/foo_spec.rb   # every request/controller example
  #
  # Format and replay: nextjs/parity/README.md.
  class Recorder
    FORMAT_VERSION = 1
    FIXTURES_DIR = ENV.fetch("PARITY_FIXTURES_DIR") { File.expand_path("../../../nextjs/parity/fixtures", __dir__) }
    RECORDED_TYPES = %i[request controller].freeze
    DEBUG_PAGE_BODY = "<rails exception debug page, not recorded: the replay ignores a 404 body>"
    MAX_SLUG_LENGTH = 120

    # Per-request or random values, or ones Rails emits for itself. Keep in sync with
    # VOLATILE_RESPONSE_HEADERS in nextjs/parity/src/http.ts.
    VOLATILE_RESPONSE_HEADERS = %w[
      date etag content-length x-request-id x-runtime server-timing set-cookie
      content-security-policy content-security-policy-report-only
    ].freeze

    # Key types of the main Redis database that are seeded back before a replayed request: Flipper
    # features (hashes and a set), the impersonation key and similar. Lists and sorted sets are
    # queues and counters the port does not read.
    REDIS_SEEDED_TYPES = %w[string hash set].freeze

    ACTIVE_JOB_WRAPPERS = %w[
      Sidekiq::ActiveJob::Wrapper ActiveJob::QueueAdapters::SidekiqAdapter::JobWrapper
    ].freeze

    class << self
      attr_reader :current

      def enabled_for?(example)
        mode = ENV["PARITY_RECORD"].to_s
        return false if mode.empty? || !RECORDED_TYPES.include?(example.metadata[:type])

        mode == "all" || example.metadata[:parity].present?
      end

      def around(example)
        recorder = new(example)
        recorder.prepare!
        @current = recorder
        example.run
      ensure
        @current = nil
        # A failing example's state is not a contract worth replaying.
        recorder&.write! if example.exception.nil?
      end

      def install_hooks!
        return if @hooks_installed

        @hooks_installed = true
        ActionDispatch::Integration::Session.prepend(IntegrationHook)
        # Prepended late so it sits in front of Sidekiq::Testing's raw_push, which swallows
        # the call in fake mode.
        Sidekiq::Client.prepend(SidekiqHook) if defined?(Sidekiq::Client)
        ActionMailer::Base.register_observer(MailObserver) if defined?(ActionMailer::Base)
        if defined?(WebMock)
          WebMock.after_request { |signature, response| Recorder.current&.record_http(signature, response) }
        end
      end
    end

    attr_reader :exchanges

    def initialize(example)
      @example = example
      @exchanges = []
      @snapshot = DbSnapshot.new(ActiveRecord::Base.connection)
    end

    def prepare!
      self.class.install_hooks!
      connection = ActiveRecord::Base.connection
      if connection.transaction_open?
        warn "[parity] #{@example.location}: a transaction is already open, so ids are not reset and may differ between recordings"
      else
        @snapshot.reset_auto_increments!
      end
    end

    # Wraps one request. `context` is the integration session or controller test case, both of
    # which expose the finished request and response.
    def capture(context, source)
      return yield if @capturing

      now = Time.current
      redis_before = redis_snapshot
      elasticsearch_before = elasticsearch_snapshot(now)
      before = @snapshot.dump(@snapshot.non_empty_tables)
      auto_increments = @snapshot.auto_increments
      @capturing = true
      @jobs = []
      @mails = []
      @http = []
      begin
        result = yield
      ensure
        @capturing = false
      end
      after = @snapshot.dump(before.keys | @snapshot.non_empty_tables)

      @exchanges << {
        "seed" => {
          "tables" => before.transform_values { |dump| seed_table(dump, now) },
          "autoIncrement" => auto_increments,
        },
        "redis" => redis_before.presence,
        "elasticsearch" => elasticsearch_before.presence,
        "request" => request_json(context.request, source, now),
        "response" => response_json(context.response, now),
        "db" => Canonical.diff(before, after, now),
        "jobs" => @jobs.map { job_json(_1, now) },
        "mails" => @mails.map { mail_json(_1, now) },
        "http" => @http.map { |signature, response| http_json(signature, response, now) },
      }.compact
      result
    end

    def record_job(payload)
      @jobs << payload.deep_dup if @capturing
    end

    def record_mail(message)
      @mails << message if @capturing
    end

    def record_http(signature, response)
      @http << [signature, response] if @capturing
    end

    def write!
      return if @exchanges.empty?

      path = fixture_path
      json = JSON.pretty_generate(fixture) + "\n"
      # Fixtures are committed: an exception debug page or a backtrace would publish the recording machine's paths.
      raise "#{path} would record a local path (#{Dir.home}); keep debug pages and backtraces out of the fixture" if json.include?(Dir.home)

      FileUtils.mkdir_p(File.dirname(path))
      File.write(path, json)
    end

    def fixture
      {
        "version" => FORMAT_VERSION,
        "spec" => @example.metadata[:rerun_file_path].to_s.delete_prefix("./"),
        "example" => @example.full_description,
        "sessionCookie" => Rails.application.config.session_options[:key],
        # Test-only: lets the replayer re-encrypt the recorded cookies for its own secret.
        "secretKeyBase" => Rails.application.secret_key_base,
        "exchanges" => @exchanges,
      }
    end

    def fixture_path
      spec = @example.metadata[:rerun_file_path].to_s.delete_prefix("./").delete_prefix("spec/").delete_suffix(".rb")
      File.join(FIXTURES_DIR, spec, "#{slug}.json")
    end

    private
      def slug
        full = @example.full_description.downcase.gsub(/[^a-z0-9]+/, "-").gsub(/\A-|-\z/, "")
        return full if full.length <= MAX_SLUG_LENGTH

        "#{full[0, MAX_SLUG_LENGTH].chomp("-")}-#{Digest::SHA1.hexdigest(full)[0, 8]}"
      end

      # The documents of ConfirmedFollowerEvent, the one index that has no table behind it (every other index is rebuilt
      # from the rows the replay seeds): `{ index => [{ "id", "source" }] }`, with times as tokens.
      def elasticsearch_snapshot(now)
        [ConfirmedFollowerEvent].each_with_object({}) do |model, snapshot|
          next unless EsClient.indices.exists?(index: model.index_name)

          EsClient.indices.refresh(index: model.index_name)
          hits = EsClient.search(index: model.index_name, body: { query: { match_all: {} }, sort: [{ timestamp: :asc }, { follower_id: :asc }], size: 10_000 }).dig("hits", "hits")
          next if hits.empty?

          snapshot[model.name] = hits.map { { "source" => Canonical.json(_1["_source"], now) } }
        end
      end

      # `{ key => { "type", "value", "ttl" } }` for the main Redis database, sorted by key.
      def redis_snapshot
        $redis.scan_each.sort.each_with_object({}) do |key, snapshot|
          type = $redis.type(key)
          next unless REDIS_SEEDED_TYPES.include?(type)

          value =
            case type
            when "string" then $redis.get(key)
            when "hash" then $redis.hgetall(key).sort.to_h
            else $redis.smembers(key).sort
            end
          ttl = $redis.ttl(key)
          snapshot[key] = { "type" => type, "value" => value, "ttl" => (ttl if ttl.positive?) }.compact
        end
      end

      def seed_table(dump, now)
        {
          "columns" => dump.fetch("columns").to_h,
          "primaryKey" => dump.fetch("primaryKey"),
          "rows" => dump.fetch("rows").map { Canonical.row(dump, _1, now) },
        }
      end

      def request_json(request, source, now)
        env = request.env
        headers = env.filter_map do |key, value|
          next unless key.start_with?("HTTP_") && key != "HTTP_COOKIE"

          [key.delete_prefix("HTTP_").downcase.tr("_", "-"), value.to_s]
        end.to_h
        headers["content-type"] = env["CONTENT_TYPE"] if env["CONTENT_TYPE"].present?

        body = request.raw_post.to_s
        {
          "source" => source,
          "method" => request.request_method,
          "path" => request.path,
          "query" => query_with_date_tokens(request.query_string, now).presence,
          "headers" => headers.sort.to_h,
          "cookies" => parse_cookie_header(env["HTTP_COOKIE"]),
          "remoteIp" => request.remote_ip,
        }.merge(body_field(body)).compact
      end

      # A date a query parameter holds is as relative to the recording as the rows are: the replayer resolves the
      # token against its own clock.
      def query_with_date_tokens(query, now)
        query.to_s.gsub(/(?<==)(\d{4}-\d{2}-\d{2})(?=&|\z)/) { Canonical.date_token(Date.iso8601(_1), now) }
      rescue Date::Error
        query
      end

      def body_field(body)
        return {} if body.empty?

        utf8 = body.dup.force_encoding(Encoding::UTF_8)
        utf8.valid_encoding? ? { "body" => utf8 } : { "bodyBase64" => Base64.strict_encode64(body) }
      end

      def parse_cookie_header(header)
        header.to_s.split(/;\s*/).filter_map do |pair|
          name, value = pair.split("=", 2)
          [name, CGI.unescape(value.to_s)] if name.present?
        end.sort.to_h.presence
      end

      def response_json(response, now)
        headers = response.headers.to_h.transform_keys(&:downcase)
        out = {
          "status" => response.status,
          "location" => response.location,
          "headers" => Canonical.json(headers.except("location", *VOLATILE_RESPONSE_HEADERS).sort.to_h, now),
          "cookies" => set_cookies(headers["set-cookie"], now).presence,
        }.compact
        out.merge(response_body(response, headers["content-type"].to_s, now)).tap do |json|
          # The test environment answers an error with its exception debug page, which names local paths;
          # replays compare an error page's status and headers, never that body.
          json["body"] = DEBUG_PAGE_BODY if response.status >= 400 && json["body"].is_a?(String) && json["body"].include?(Rails.root.to_s)
        end
      end

      def set_cookies(header, now)
        lines = header.is_a?(Array) ? header : header.to_s.split("\n")
        lines.sort.to_h do |line|
          pair, *attributes = line.split(/;\s*/)
          name, value = pair.split("=", 2)
          parsed = { "value" => Canonical.cookie_value(name, CGI.unescape(value.to_s)) }
          attributes.each do |attribute|
            key, attr_value = attribute.split("=", 2)
            key = key.downcase
            parsed[key] =
              if attr_value.nil? then true
              elsif key == "expires" then expires_token(attr_value, now)
              else attr_value
              end
          end
          [name, parsed]
        end
      end

      def expires_token(value, now)
        Canonical.time_token(Time.httpdate(value), now)
      rescue ArgumentError
        value
      end

      def response_body(response, content_type, now)
        body = response.body.to_s
        return {} if body.empty?

        if content_type.include?("json")
          { "json" => Canonical.json(JSON.parse(body), now) }
        elsif content_type.include?("html") && (page = inertia_page(body))
          { "inertia" => Canonical.json(page, now) }
        else
          utf8 = body.dup.force_encoding(Encoding::UTF_8)
          utf8.valid_encoding? ? { "body" => Canonical.string(utf8, now) } : { "bodyBase64" => Base64.strict_encode64(body) }
        end
      rescue JSON::ParserError
        { "body" => Canonical.string(body, now) }
      end

      # inertia_rails renders the initial page into data-page (or a JSON script element when
      # use_script_element_for_initial_page is on). The surrounding HTML is layout, not contract.
      def inertia_page(html)
        if (match = html.match(/<script[^>]*data-page="[^"]*"[^>]*>(.*?)<\/script>/m))
          JSON.parse(match[1])
        elsif (match = html.match(/\sdata-page="([^"]*)"/))
          JSON.parse(CGI.unescapeHTML(match[1]))
        end
      rescue JSON::ParserError
        nil
      end

      def job_json(payload, now)
        job = { "class" => payload["class"].to_s, "args" => payload["args"], "queue" => payload["queue"] }
        if ACTIVE_JOB_WRAPPERS.include?(job["class"]) && payload["wrapped"]
          job["class"] = payload["wrapped"].to_s
          job["args"] = payload["args"].first["arguments"]
          job["activeJob"] = true
        end
        job["at"] = Canonical.time_token(Time.at(payload["at"].to_r), now) if payload["at"]
        Canonical.json(job, now)
      end

      def mail_json(message, now)
        mailer = message.delivery_handler
        mail = {
          "mailer" => mailer.respond_to?(:name) ? mailer.name : nil,
          "from" => message.from,
          "to" => message.to,
          "cc" => message.cc,
          "bcc" => message.bcc,
          "replyTo" => message.reply_to,
          "subject" => message.subject,
          "text" => mail_part(message, "text/plain"),
          "html" => mail_part(message, "text/html"),
        }
        Canonical.json(mail.compact, now)
      end

      def mail_part(message, mime_type)
        part = mime_type == "text/html" ? message.html_part : message.text_part
        return part.decoded if part

        message.decoded if !message.multipart? && message.mime_type == mime_type
      end

      # Only content-type is kept from request headers: the rest carry API keys.
      def http_json(signature, response, now)
        uri = signature.uri.dup
        uri.port = nil if uri.port == uri.default_port
        request_headers = (signature.headers || {}).transform_keys(&:downcase)
        response_headers = (response&.headers || {}).transform_keys(&:downcase)
        call = {
          "method" => signature.method.to_s.upcase,
          "url" => uri.to_s,
          "contentType" => request_headers["content-type"],
          "body" => signature.body.presence,
          "response" => {
            "status" => Array(response&.status).first,
            "contentType" => response_headers["content-type"],
            "body" => response&.body.to_s,
          }.compact,
        }
        Canonical.json(call.compact, now)
      end
  end

  module IntegrationHook
    def process(...)
      recorder = Recorder.current
      return super unless recorder

      recorder.capture(self, "request") { super }
    end
  end

  module ControllerHook
    def process(...)
      recorder = Recorder.current
      return super unless recorder

      recorder.capture(self, "controller") { super }
    end
  end

  module SidekiqHook
    def raw_push(payloads)
      payloads.each { Recorder.current&.record_job(_1) }
      super
    end
  end

  module MailObserver
    def self.delivered_email(message)
      Recorder.current&.record_mail(message)
    end
  end
end

RSpec.configure do |config|
  config.include Parity::ControllerHook, type: :controller

  config.around(:each) do |example|
    Parity::Recorder.enabled_for?(example) ? Parity::Recorder.around(example) : example.run
  end
end
