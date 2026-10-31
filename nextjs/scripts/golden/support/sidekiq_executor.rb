# frozen_string_literal: true

# Runs a golden case the way production Sidekiq runs a job, so the statements recorded are the
# ones Rails sends there:
#
# - on a thread of its own, as each Sidekiq processor is: the query cache store, the leased
#   connection and mysql2_proxy's last-write clock are all per thread;
# - inside the Rails executor (Sidekiq::Rails::Reloader), which turns the query cache on for the
#   job and clears it afterwards;
# - with production's USE_DB_WORKER_REPLICAS=true pools: ApplicationRecord on a mysql2_proxy primary
#   plus a replica, with lib/mysql2_proxy_routing.rb applied, so the cache is also cleared whenever
#   the pool serving a SELECT changes.
#
# Generators that boot the app (`rails runner`) get the pools from database.yml when run with
# USE_DB_WORKER_REPLICAS=true; the standalone ones (fake_mysql.rb) call establish_proxy_connection
# and connect_application_record! instead.
module SidekiqExecutor
  ROOT = File.expand_path("../../../..", __dir__)

  class << self
    # The primary and replica pools database.yml declares with USE_DB_WORKER_REPLICAS=true, both on
    # `config` (the fake driver answers both), and config/initializers/active_record_proxy_adapters.rb.
    def establish_proxy_connection(config)
      require "active_record_proxy_adapters"
      require "active_record/connection_adapters/mysql2_proxy_adapter"
      require File.join(ROOT, "lib/mysql2_proxy_routing")
      ActiveRecordProxyAdapters::PrimaryReplicaProxy.prepend(Mysql2ProxyRouting::ScopedRoles)
      ActiveRecord::ConnectionAdapters::Mysql2ProxyAdapter.prepend(Mysql2ProxyRouting::ServingPoolCache)
      ActiveRecordProxyAdapters.configure { |c| c.proxy_delay = 2.seconds }

      config = config.transform_keys(&:to_s)
      ActiveRecord::Base.configurations = {
        "test" => { "primary" => config.merge("adapter" => "mysql2_proxy"), "primary_replica" => config.merge("replica" => true) },
      }
      ActiveRecord::Base.establish_connection(:primary)
      @standalone = true
    end

    # application_record.rb's `connects_to` (replica_roles_configured? is true in production Sidekiq).
    def connect_application_record!
      ApplicationRecord.connects_to(database: { writing: :primary, reading: :primary_replica })
    end

    def perform(&block)
      Thread.new { wrap(&block) }.value
    end

    private
      def wrap(&block)
        if defined?(Rails.application) && Rails.application
          raise "run with USE_DB_WORKER_REPLICAS=true" unless ENV["USE_DB_WORKER_REPLICAS"] == "true"

          Rails.application.reloader.wrap(source: "job.sidekiq", &block)
        else
          raise "call SidekiqExecutor.establish_proxy_connection first" unless @standalone

          standalone_executor.wrap(source: "job.sidekiq", &block)
        end
      end

      # The hooks activerecord's railtie installs on the app executor.
      def standalone_executor
        @standalone_executor ||= Class.new(ActiveSupport::Executor).tap do |executor|
          ActiveRecord::QueryCache.install_executor_hooks(executor)
          ActiveRecord::ConnectionAdapters::ConnectionPool.install_executor_hooks(executor)
        end
      end
  end
end
