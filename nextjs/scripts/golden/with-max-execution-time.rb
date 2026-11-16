# frozen_string_literal: true

# Produces nextjs/src/server/models/runtime/__fixtures__/with-max-execution-time.golden.json: the statements
# WithMaxExecutionTime.timeout_queries sends, recorded from the real app as a Sidekiq job runs it (support/sidekiq_executor.rb).
# Run it twice, once per pool layout; each run writes its own key and keeps the other's:
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_test_ws88 TEST_DATABASE_NAME=gumroad_test_ws88 DISABLE_TEST_REDIS_ISOLATION=1 \
#     USE_DB_WORKER_REPLICAS=true SIDEKIQ_REDIS_HOST=redis:6379/58 REDIS_HOST=redis:6379/57 \
#     bundle exec ruby bin/rails runner nextjs/scripts/golden/with-max-execution-time.rb     # key "replicas" (production Sidekiq)
#   ... without USE_DB_WORKER_REPLICAS                                                       # key "single_pool" (one pool, as Node has)
require "json"
require_relative "support/rails_recorder"
require_relative "support/sidekiq_executor"

OUT = Rails.root.join("nextjs/src/server/models/runtime/__fixtures__/with-max-execution-time.golden.json")
SCRATCH = "ws88_slow"
MODE = ENV["USE_DB_WORKER_REPLICAS"] == "true" ? "replicas" : "single_pool"
abort "Refusing to run against #{ActiveRecord::Base.connection_db_config.database}" unless ActiveRecord::Base.connection_db_config.database.match?(/_(ws)?\d+[a-z]?\z/)

Rails.logger = ActiveSupport::Logger.new(nil)
conn = ActiveRecord::Base.connection
conn.execute("DROP TABLE IF EXISTS #{SCRATCH}")
conn.execute("CREATE TABLE #{SCRATCH} (id INT PRIMARY KEY)")
conn.execute("INSERT INTO #{SCRATCH} (id) VALUES #{(1..400).map { "(#{_1})" }.join(",")}")
# MySQL answers COUNT(*) from an index and ignores the cap for SLEEP(), so the sum has to be computed row by row.
SLOW = "select sum(a.id * b.id + c.id) from #{SCRATCH} a join #{SCRATCH} b join #{SCRATCH} c"

# Runs the block as a job would. `body` runs inside timeout_queries; its own statements are kept in the log, so a case with a
# body shows where they sit between the cap and its restore.
def run(name, seconds, &body)
  error = nil
  value = nil
  job = lambda do
    value = WithMaxExecutionTime.timeout_queries(seconds:) { body ? body.call : nil }
  rescue Exception => e # rubocop:disable Lint/RescueException
    error = { "class" => e.class.name, "superclass" => e.class.superclass.name, "message" => e.message }
  end
  statements = RailsRecorder.recording do
    if MODE == "replicas"
      SidekiqExecutor.perform(&job)
    else
      Thread.new { Rails.application.executor.wrap(&job) }.join
    end
  end
  { "name" => name, "seconds" => seconds, "statements" => statements, "error" => error, "value" => value }
end

cases = []
cases << run("an empty block", 5)
cases << run("a fractional number of seconds", 1.5)
cases << run("a cap below a millisecond", 0.0004)
cases << run("a cap of 1.9 milliseconds", 0.0019)
cases << run("a duration of one hour", 1.hour)
cases << run("a block that returns a value", 5) { :returned }
cases << run("a block that writes", 5) { ApplicationRecord.connection.execute("insert into #{SCRATCH} (id) values (1000)") }
cases << run("nested blocks", 10) { WithMaxExecutionTime.timeout_queries(seconds: 3) { nil } }
cases << run("a block that raises", 5) { raise ArgumentError, "boom" }
cases << run("a statement over the cap", 0.05) { ApplicationRecord.connection.select_value(SLOW) }

conn.execute("DROP TABLE #{SCRATCH}")
golden = OUT.exist? ? JSON.parse(OUT.read) : {}
golden[MODE] = cases
File.write(OUT, JSON.pretty_generate(golden.sort.to_h) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{MODE}: #{cases.size} cases)"
