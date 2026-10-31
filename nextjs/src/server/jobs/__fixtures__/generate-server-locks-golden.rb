# frozen_string_literal: true

# Produces server-locks.golden.json: what sidekiq-unique-jobs 8.0.10's *server* middleware does to
# Redis for the runtime locks (while_executing, until_and_while_executing), including conflicts
# between two jobs running at once. Same gems and setup as generate-sidekiq-golden.rb:
#
#   REDIS_URL=redis://127.0.0.1:6379/8 ruby generate-server-locks-golden.rb
#
# A concurrent second job is modelled by running it from inside the first one's body, which is
# what two Sidekiq threads look like to Redis. server-locks.integration.test.ts replays each case
# through the Node worker's processor and compares the keyspace at the same points.
gem "json", "2.13.2"
gem "sidekiq", "7.3.4"
gem "sidekiq-unique-jobs", "8.0.10"
require "json"
require "sidekiq"
require "sidekiq_unique_jobs"

REDIS_URL = ENV.fetch("REDIS_URL", "redis://127.0.0.1:6379/15")
abort "Refusing to run against db 0" unless REDIS_URL.match?(%r{/\d+\z}) && !REDIS_URL.end_with?("/0")

Sidekiq.configure_client do |config|
  config.redis = { url: REDIS_URL }
  config.client_middleware { |chain| chain.add SidekiqUniqueJobs::Middleware::Client }
end
Sidekiq.default_job_options = { "backtrace" => true, "retry" => 25 }
SidekiqUniqueJobs.configure { |config| config.logger = Logger.new(nil) }

# Mirrors of real job options (app/sidekiq/*.rb at the time of writing).
class SendChargeReceiptJob
  include Sidekiq::Job
  sidekiq_options queue: :critical, retry: 5, lock: :while_executing, lock_timeout: 2,
                  unique_across_queues: true, on_conflict: { server: :raise }

  def self.lock_args(args) = [args.first]
end

class SyncStripeBusinessProfileUrlJob
  include Sidekiq::Job
  sidekiq_options retry: 3, queue: :low, lock: :while_executing, lock_timeout: 0,
                  lock_ttl: 10 * 60, on_conflict: { server: :reschedule }
end

class RefreshUserProductsRecommendationEligibilityJob
  include Sidekiq::Job
  sidekiq_options retry: 3, queue: :low, lock: :while_executing, lock_timeout: 0,
                  lock_ttl: 6 * 3600, schedule_in: 60, on_conflict: { server: :reschedule }
end

# No app job uses these two shapes today; they pin the remaining branches.
class WhileExecutingLogJob
  include Sidekiq::Job
  sidekiq_options queue: :default, lock: :while_executing, on_conflict: :log
end

class UntilAndWhileExecutingJob
  include Sidekiq::Job
  sidekiq_options queue: :default, retry: 2, lock: :until_and_while_executing, lock_ttl: 300,
                  on_conflict: { client: :log, server: :raise }
end

FIXED_NOW = Time.at(1_761_955_200, 123_456, :usec)
class Time
  class << self
    def now(...) = FIXED_NOW
  end
end

$jid_seq = 0
module SecureRandom
  def self.hex(n = nil)
    return super unless n == 12
    $jid_seq += 1
    format("%024x", $jid_seq)
  end
end

def redis(&) = Sidekiq.redis(&)
def flush! = redis { |conn| conn.call("FLUSHDB") }

def snapshot
  redis do |conn|
    conn.call("KEYS", "*").sort.to_h do |key|
      type = conn.call("TYPE", key)
      value =
        case type
        when "string" then conn.call("GET", key)
        when "list" then conn.call("LRANGE", key, 0, -1)
        when "set" then conn.call("SMEMBERS", key).sort
        when "hash" then conn.call("HGETALL", key)
        when "zset" then conn.call("ZRANGE", key, 0, -1, "WITHSCORES").flatten.each_slice(2).map { |m, score| [m, score.to_f] }
        end
      pttl = conn.call("PTTL", key)
      entry = { "type" => type, "value" => value, "expires" => pttl.positive? }
      # The changelog embeds timings; compare its messages only.
      entry = { "type" => type, "messages" => value.map { |(json, _)| JSON.parse(json)["message"] }, "expires" => entry["expires"] } if key == "uniquejobs:changelog"
      [key, entry]
    end
  end
end

# Sidekiq::Client#push through the unique-jobs client middleware, then the fetch: the payload the
# server middleware would receive.
def push_and_fetch(klass, args)
  jid = klass.perform_async(*args)
  return { "jid" => nil } unless jid
  queue = klass.get_sidekiq_options["queue"].to_s
  payload = redis { |conn| conn.call("RPOP", "queue:#{queue}") }
  { "jid" => jid, "payload" => payload }
end

def run_server(payload, events, label, &body)
  item = Sidekiq.load_json(payload)
  worker = Object.const_get(item["class"]).new
  SidekiqUniqueJobs::Middleware::Server.new.call(worker, item, item["queue"]) do
    events << "#{label} ran"
    body&.call
  end
  events << "#{label} returned"
rescue StandardError => e
  events << "#{label} raised #{e.class}: #{e.message}"
end

Job = Struct.new(:label, :klass, :args, keyword_init: true)

CASES = [
  { "name" => "while_executing runs and releases its :RUN lock", "jobs" => [["a", "SendChargeReceiptJob", [7, 1]]],
    "body" => { "a" => "snapshot" } },
  { "name" => "while_executing with lock_ttl", "jobs" => [["a", "SyncStripeBusinessProfileUrlJob", [3]]],
    "body" => { "a" => "snapshot" } },
  { "name" => "while_executing releases the lock when the job raises", "jobs" => [["a", "SendChargeReceiptJob", [7, 1]]],
    "body" => { "a" => "raise" } },
  { "name" => "while_executing conflict with on_conflict server: raise", "jobs" => [["a", "SendChargeReceiptJob", [7, 1]], ["b", "SendChargeReceiptJob", [7, 2]]],
    "body" => { "a" => "run b" } },
  { "name" => "while_executing conflict with on_conflict server: reschedule", "jobs" => [["a", "SyncStripeBusinessProfileUrlJob", [3]], ["b", "SyncStripeBusinessProfileUrlJob", [3]]],
    "body" => { "a" => "run b" } },
  { "name" => "while_executing reschedule honours schedule_in", "jobs" => [["a", "RefreshUserProductsRecommendationEligibilityJob", [9]], ["b", "RefreshUserProductsRecommendationEligibilityJob", [9]]],
    "body" => { "a" => "run b" } },
  { "name" => "while_executing conflict with on_conflict: log", "jobs" => [["a", "WhileExecutingLogJob", [1]], ["b", "WhileExecutingLogJob", [1]]],
    "body" => { "a" => "run b" } },
  { "name" => "while_executing jobs with different lock args run together", "jobs" => [["a", "SendChargeReceiptJob", [7, 1]], ["b", "SendChargeReceiptJob", [8, 1]]],
    "body" => { "a" => "run b", "b" => "snapshot" } },
  { "name" => "until_and_while_executing swaps the client lock for the :RUN lock", "jobs" => [["a", "UntilAndWhileExecutingJob", [1]]],
    "body" => { "a" => "snapshot" } },
  { "name" => "until_and_while_executing relocks the client lock when the job raises", "jobs" => [["a", "UntilAndWhileExecutingJob", [1]]],
    "body" => { "a" => "raise" } },
  { "name" => "until_and_while_executing skips the job when it no longer holds the client lock", "jobs" => [["a", "UntilAndWhileExecutingJob", [1]]],
    "body" => { "a" => "snapshot" }, "before_run" => "flush" },
  { "name" => "until_and_while_executing runtime conflict raises and relocks", "jobs" => [["a", "UntilAndWhileExecutingJob", [1]], ["b", "UntilAndWhileExecutingJob", [1]]],
    "body" => { "a" => "run b" }, "push_b_inside_a" => true },
].freeze

results = CASES.map do |c|
  flush!
  $jid_seq = 0
  jobs = c["jobs"].to_h { |label, klass, args| [label, Job.new(label:, klass: Object.const_get(klass), args:)] }
  pushed = {}
  # A job that is pushed while the first one runs (until_and_while_executing's client lock is
  # free again by then) is pushed from inside the body.
  jobs.each_value { |job| pushed[job.label] = push_and_fetch(job.klass, job.args) unless c["push_b_inside_a"] && job.label == "b" }
  flush! if c["before_run"] == "flush"
  before = snapshot
  events = []
  snapshots = {}
  runner = nil
  runner = lambda do |label|
    run_server(pushed[label]["payload"], events, label) do
      case c["body"][label]
      when "snapshot" then snapshots[label] = snapshot
      when "raise" then raise ArgumentError, "boom from #{label}"
      when /\Arun (\w+)\z/
        other = Regexp.last_match(1)
        pushed[other] = push_and_fetch(jobs[other].klass, jobs[other].args) if c["push_b_inside_a"]
        snapshots["#{label} before #{other}"] = snapshot
        runner.call(other)
        snapshots[label] = snapshot
      end
    end
  end
  runner.call("a")
  c.merge("pushed" => pushed, "before" => before, "events" => events, "inside" => snapshots, "after" => snapshot)
end

flush!
File.write(
  File.join(__dir__, "server-locks.golden.json"),
  JSON.pretty_generate(
    "generated_with" => { "ruby" => RUBY_VERSION, "sidekiq" => Sidekiq::VERSION, "sidekiq_unique_jobs" => SidekiqUniqueJobs::VERSION },
    "now" => FIXED_NOW.to_f,
    "cases" => results,
  ) + "\n",
)
puts "wrote #{results.size} cases"
