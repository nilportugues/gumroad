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
  NODE_OWNED_MAILERS_PATH = ENV.fetch("NODE_OWNED_MAILERS_PATH") do
    File.expand_path("../nextjs/src/server/mail/node-owned-mailers.generated.json", __dir__)
  end
  ACTIVE_JOB_WRAPPER = "ActiveJob::QueueAdapters::SidekiqAdapter::JobWrapper"

  # Diverting without a Node worker running would strand jobs in INBOX with no error, so the
  # bridge is opt-in per deploy. Off in tests, like sidekiq-unique-jobs, so specs keep asserting
  # on `Job.jobs`.
  def self.enabled?
    ENV["NODE_JOB_WORKER"] == "enabled" && !Rails.env.test?
  end

  def self.node_owned
    @node_owned ||= JSON.parse(File.read(NODE_OWNED_PATH)).to_set.freeze
  end

  # "Mailer#method" pairs whose `deliver_later` the Node worker runs. It re-checks its own rollout
  # switch and hands the job back to Sidekiq when Node mail delivery is off.
  def self.node_owned_mailers
    @node_owned_mailers ||= JSON.parse(File.read(NODE_OWNED_MAILERS_PATH)).to_set.freeze
  end

  def self.node_owned?(job)
    return node_owned.include?(job["class"].to_s) unless job["class"].to_s == ACTIVE_JOB_WRAPPER

    active_job = Array(job["args"]).first
    return false unless active_job.is_a?(Hash) && active_job["job_class"] == "MailDeliveryJob"

    mailer, method = active_job["arguments"]
    node_owned_mailers.include?("#{mailer}##{method}")
  end

  # config/sidekiq_schedule.yml minus the entries Node schedules itself; without this both fire.
  def self.ruby_schedule(schedule)
    schedule.reject { |_name, entry| entry.is_a?(Hash) && node_owned.include?(entry["class"].to_s) }
  end

  def call(_job_class, job, _queue, redis_pool)
    return yield unless self.class.node_owned?(job)

    (redis_pool || Sidekiq.default_configuration.redis_pool).with do |conn|
      conn.call("LPUSH", INBOX, Sidekiq.dump_json(job))
    end
    false
  end
end
