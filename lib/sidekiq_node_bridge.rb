# frozen_string_literal: true

# Sends Sidekiq jobs whose body has moved to the Node worker (nextjs/src/worker) there instead of
# to a Sidekiq queue, so `FooJob.perform_async` keeps working from Ruby unchanged.
#
# Add it after SidekiqUniqueJobs::Middleware::Client in both configure_client and
# configure_server (jobs enqueued from inside jobs use the server's client chain). Placed there,
# the unique-jobs lock is already taken, and the Node worker releases it after the run exactly as
# the Sidekiq server middleware would. See nextjs/src/server/jobs/README.md.
#
# The diverted push returns nil from perform_async, as a deduplicated one does.
class SidekiqNodeBridge
  include Sidekiq::ClientMiddleware

  INBOX = "nextjs:bridge:inbox"
  NODE_OWNED_PATH = ENV.fetch("NODE_OWNED_JOBS_PATH") do
    File.expand_path("../nextjs/src/server/jobs/node-owned-jobs.generated.json", __dir__)
  end

  # Diverting without a Node worker running would strand jobs in INBOX with no error, so the
  # bridge is opt-in per deploy. Off in tests, like sidekiq-unique-jobs, so specs keep asserting
  # on `Job.jobs`.
  def self.enabled?
    ENV["NODE_JOB_WORKER"] == "enabled" && !Rails.env.test?
  end

  def self.node_owned
    @node_owned ||= JSON.parse(File.read(NODE_OWNED_PATH)).to_set.freeze
  end

  # config/sidekiq_schedule.yml minus the entries Node schedules itself; without this both fire.
  def self.ruby_schedule(schedule)
    schedule.reject { |_name, entry| entry.is_a?(Hash) && node_owned.include?(entry["class"].to_s) }
  end

  def call(_job_class, job, _queue, redis_pool)
    return yield unless self.class.node_owned.include?(job["class"].to_s)

    (redis_pool || Sidekiq.default_configuration.redis_pool).with do |conn|
      conn.call("LPUSH", INBOX, Sidekiq.dump_json(job))
    end
    false
  end
end
