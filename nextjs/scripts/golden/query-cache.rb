# frozen_string_literal: true

# Produces nextjs/src/server/models/runtime/__fixtures__/query-cache.golden.json: ActiveRecord 8.1's
# query cache, driven by scripted scenarios that runtime/query-cache.test.ts replays op for op. Each
# scenario runs under the executor the way a Sidekiq job does in production (support/sidekiq_executor.rb:
# its own thread, mysql2_proxy primary/replica pools and lib/mysql2_proxy_routing.rb), or the way a
# Puma request does (one plain mysql2 pool), and records every statement ActiveRecord sent. Only the
# mysql2 driver is faked (src/worker/jobs/__fixtures__/fake_mysql.rb).
#
#   BUNDLE_GEMFILE=Gemfile bundle exec ruby nextjs/scripts/golden/query-cache.rb
ENV["TZ"] = "UTC"
require "json"
require "logger"
require "active_record"
require "active_support/all"
require_relative "../../src/worker/jobs/__fixtures__/fake_mysql"
require_relative "support/sidekiq_executor"

ROOT = File.expand_path("../../..", __dir__)
OUT = File.join(ROOT, "nextjs/src/server/models/runtime/__fixtures__/query-cache.golden.json")

# mysql2_proxy's proxy_delay reads Time.now; `advance` ops move it.
START = Time.at(1_761_955_200, 123_000, :usec).utc
$clock = START
class Time
  class << self
    def now(...) = $clock
  end
end

module Rails
  def self.env = ActiveSupport::StringInquirer.new("test")
end
ActiveRecord.default_timezone = :utc
ActiveRecord::Base.logger = nil
schema = FakeMysql::SchemaCapture.load(File.join(ROOT, "db/schema.rb"))
FakeMysql.schema = schema.tables
FakeMysql.indexes = schema.indexes
require "active_record/connection_adapters/mysql2_adapter"
ActiveRecord::ConnectionAdapters::Mysql2Adapter.class_eval { private def default_type(*) = :literal }
CONFIG = { adapter: "mysql2", database: "gumroad_test", encoding: "utf8mb4", collation: "utf8mb4_unicode_ci" }.freeze

class ApplicationRecord < ActiveRecord::Base
  self.abstract_class = true
end
class User < ApplicationRecord; end

ROW = FakeMysql::Rows.new(["id"], [[1]])
# One row for every SELECT but find_in_batches' second batch, which ends the loop.
RESPONDER = ->(sql) { sql.start_with?("SELECT") ? (sql.include?("`users`.`id` > ") ? FakeMysql::Rows.new(["id"], []) : ROW) : nil }
CONNECTION = -> { ApplicationRecord.connection }

def run_ops(ops)
  ops.each do |op, *rest|
    case op
    when "select" then CONNECTION.call.select_all(rest[0])
    when "write" then CONNECTION.call.update(rest[0])
    when "insert" then CONNECTION.call.insert(rest[0])
    # A relation with `lock`: "FOR UPDATE" for true, else the clause given.
    when "lock" then User.where(id: rest[0]).lock(rest[1]).load
    when "transaction" then ApplicationRecord.transaction { run_ops(rest[0]) }
    when "rollback"
      ApplicationRecord.transaction do
        run_ops(rest[0])
        raise ActiveRecord::Rollback
      end
    when "uncached" then ApplicationRecord.uncached(dirties: rest[0]) { run_ops(rest[1]) }
    when "cache" then ApplicationRecord.cache { run_ops(rest[0]) }
    when "connected_to" then ApplicationRecord.connected_to(role: rest[0].to_sym) { run_ops(rest[1]) }
    when "clear" then CONNECTION.call.clear_query_cache
    when "find_in_batches" then User.find_in_batches(batch_size: rest[0]) { run_ops(rest[1]) }
    when "advance" then $clock += rest[0]
    else raise "unknown op #{op}"
    end
  end
end

USERS = "SELECT `users`.* FROM `users` WHERE `users`.`id` = 1 LIMIT 1"
USERS_2 = "SELECT `users`.* FROM `users` WHERE `users`.`id` = 2 LIMIT 1"
LINKS = "SELECT `links`.* FROM `links` WHERE `links`.`user_id` = 1"
UPDATE = "UPDATE `users` SET `users`.`flags` = 1 WHERE `users`.`id` = 1"
INSERT = "INSERT INTO `comments` (`content`) VALUES ('a')"
selects = ->(range) { range.map { ["select", "SELECT `users`.* FROM `users` WHERE `users`.`id` = #{_1} LIMIT 1"] } }

# Scenarios for both executors: the cache itself.
CACHE_SCENARIOS = {
  "a repeated select is sent once" => [["select", USERS], ["select", USERS], ["select", USERS_2], ["select", USERS]],
  "a write clears it" => [["select", USERS], ["write", UPDATE], ["select", USERS], ["insert", INSERT], ["select", USERS]],
  "locking reads are never cached" => [["lock", 1, true], ["lock", 1, true], ["lock", 1, "FOR SHARE"], ["lock", 1, "LOCK IN SHARE MODE"], ["lock", 1, "FOR SHARE"]],
  "a locking read neither reads nor fills the cache" => [["select", USERS], ["lock", 1, true], ["select", USERS]],
  "uncached reads skip it and leave it as it was" => [["select", USERS], ["uncached", true, [["select", USERS], ["select", LINKS], ["select", LINKS]]], ["select", USERS], ["select", LINKS]],
  "a write inside uncached still clears it" => [["select", USERS], ["uncached", true, [["write", UPDATE]]], ["select", USERS]],
  "uncached(dirties: false) writes keep it" => [["select", USERS], ["uncached", false, [["write", UPDATE]]], ["select", USERS]],
  "cache inside the executor keeps it" => [["select", USERS], ["cache", [["select", USERS]]], ["select", USERS]],
  "clear_query_cache, as reload does" => [["select", USERS], ["clear"], ["select", USERS]],
  "a committed transaction keeps what it read" => [["transaction", [["select", USERS], ["select", USERS]]], ["select", USERS]],
  "a rollback clears it" => [["select", LINKS], ["rollback", [["select", USERS]]], ["select", USERS], ["select", LINKS]],
  "a rollback of a transaction that sent nothing keeps it" => [["select", USERS], ["transaction", [["select", USERS]]], ["rollback", []], ["select", USERS]],
  "find_in_batches loads skip it, the block does not" => [
    ["select", "SELECT `users`.* FROM `users` ORDER BY `users`.`id` ASC LIMIT 1"],
    ["find_in_batches", 1, [["select", USERS], ["select", USERS]]],
    ["select", "SELECT `users`.* FROM `users` ORDER BY `users`.`id` ASC LIMIT 1"],
  ],
  "the oldest of 100 entries is evicted" => [*selects.(1..101), ["select", USERS], *selects.(3..3)],
  "a hit makes an entry the newest" => [*selects.(1..100), ["select", USERS], ["select", USERS_2], *selects.(101..101), ["select", USERS], ["select", USERS_2], *selects.(3..3)],
}.freeze

# Scenarios for the Sidekiq executor only: mysql2_proxy changing the serving pool.
PROXY_SCENARIOS = {
  "a transaction moves reads to the primary" => [["select", USERS], ["transaction", [["select", USERS], ["lock", 1, true], ["select", USERS]]], ["select", USERS]],
  "a read-only transaction moves them back afterwards" => [["select", USERS], ["transaction", [["select", LINKS]]], ["select", LINKS], ["select", USERS]],
  "reads stay on the primary for proxy_delay after a write" => [
    ["write", UPDATE], ["select", USERS], ["advance", 1.5], ["select", USERS], ["advance", 0.5], ["select", USERS], ["select", USERS],
  ],
  "a write inside a transaction pins reads after it" => [["select", LINKS], ["transaction", [["insert", INSERT]]], ["select", LINKS], ["advance", 3], ["select", LINKS], ["select", LINKS]],
  "connected_to(role: :writing) switches pools" => [["select", USERS], ["connected_to", "writing", [["select", USERS], ["select", USERS]]], ["select", USERS]],
  # The reading role is another pool, with a cache store of its own.
  "connected_to(role: :reading) inside a transaction" => [["transaction", [["select", USERS], ["connected_to", "reading", [["select", USERS]]], ["select", USERS]]]],
  "connected_to(role: :reading) has its own store" => [
    ["connected_to", "reading", [["select", USERS], ["select", LINKS]]], ["select", USERS], ["connected_to", "reading", [["select", USERS], ["clear"], ["select", LINKS]]],
    ["select", USERS], ["write", UPDATE], ["connected_to", "reading", [["select", USERS]]],
  ],
  "uncached inside connected_to(role: :reading) disables only its store" => [
    ["connected_to", "writing", [["select", USERS]]],
    ["connected_to", "reading", [["select", USERS], ["uncached", true, [["select", USERS], ["connected_to", "writing", [["select", USERS]]]]]]],
  ],
  "a FOR UPDATE outside a transaction is routed to the primary" => [["select", USERS], ["lock", 1, true], ["select", USERS]],
  "FOR SHARE outside a transaction stays on the replica" => [["select", USERS], ["lock", 1, "FOR SHARE"], ["select", USERS]],
  "uncached reads do not move the cache's pool" => [["select", USERS], ["transaction", [["uncached", true, [["select", LINKS]]]]], ["select", USERS]],
  "a select whose text looks like a write pins reads to the primary" => [
    ["transaction", [["select", USERS], ["select", "SELECT `users`.* FROM `users` WHERE `users`.`name` = 'x UPDATE y'"]]], ["select", USERS],
  ],
  "a select that does not look like a write leaves reads free to move back" => [
    ["transaction", [["select", USERS], ["select", "SELECT `users`.* FROM `users` WHERE `users`.`name` = 'x_UPDATE y'"]]], ["select", USERS],
  ],
}.freeze

def record(name, ops)
  $clock = START
  { "name" => name, "ops" => ops, "statements" => FakeMysql.run(RESPONDER) { yield } }
end

golden = { "start" => START.to_f, "web" => [], "sidekiq" => [] }

# Puma: ApplicationRecord on one plain mysql2 pool, the executor around each request.
ActiveRecord::Base.establish_connection(CONFIG)
ActiveRecord::QueryCache.install_executor_hooks
CACHE_SCENARIOS.each do |name, ops|
  golden["web"] << record(name, ops) { Thread.new { ActiveSupport::Executor.wrap { run_ops(ops) } }.join }
end
ActiveRecord::Base.connection_handler.clear_all_connections!(:all)

SidekiqExecutor.establish_proxy_connection(CONFIG)
SidekiqExecutor.connect_application_record!
CACHE_SCENARIOS.merge(PROXY_SCENARIOS).each do |name, ops|
  golden["sidekiq"] << record(name, ops) { SidekiqExecutor.perform { run_ops(ops) } }
end

FileUtils.mkdir_p(File.dirname(OUT))
File.write(OUT, JSON.pretty_generate(golden) + "\n")
puts "wrote #{OUT.delete_prefix("#{ROOT}/")}"
