# frozen_string_literal: true

require "spec_helper"
require_relative "../../lib/sidekiq_node_bridge"

describe SidekiqNodeBridge do
  let(:job) { { "class" => "LogResendEventJob", "args" => [1], "queue" => "low", "jid" => "abc123" } }

  before do
    allow(described_class).to receive(:node_owned).and_return(Set["LogResendEventJob"])
    allow(described_class).to receive(:node_owned_mailers).and_return(Set["UserSignupMailer#email_changed"])
  end

  describe ".enabled?" do
    it "is enabled only when the deploy opts in and outside tests" do
      allow(Rails.env).to receive(:test?).and_return(false)

      allow(ENV).to receive(:[]).and_call_original
      allow(ENV).to receive(:[]).with("NODE_JOB_WORKER").and_return("enabled")
      expect(described_class.enabled?).to eq(true)

      allow(ENV).to receive(:[]).with("NODE_JOB_WORKER").and_return(nil)
      expect(described_class.enabled?).to eq(false)
    end

    it "stays disabled in tests even when the deploy opts in" do
      allow(ENV).to receive(:[]).and_call_original
      allow(ENV).to receive(:[]).with("NODE_JOB_WORKER").and_return("enabled")

      expect(described_class.enabled?).to eq(false)
    end
  end

  describe ".ruby_schedule" do
    it "drops cron entries whose job the Node worker schedules" do
      schedule = {
        "log_resend" => { "class" => "LogResendEventJob", "cron" => "* * * * *" },
        "other" => { "class" => "SomeRubyJob", "cron" => "0 * * * *" },
      }

      expect(described_class.ruby_schedule(schedule).keys).to eq(["other"])
    end
  end

  describe "#call" do
    let(:connection) { double("redis connection") }
    let(:redis_pool) { double("redis pool") }

    before { allow(redis_pool).to receive(:with).and_yield(connection) }

    it "pushes a Node-owned job to the inbox instead of a Sidekiq queue" do
      expect(connection).to receive(:call).with("LPUSH", SidekiqNodeBridge::INBOX, Sidekiq.dump_json(job))

      pushed_to_sidekiq = false
      result = described_class.new.call("LogResendEventJob", job, "low", redis_pool) { pushed_to_sidekiq = true }

      expect(result).to eq(false)
      expect(pushed_to_sidekiq).to eq(false)
    end

    it "lets every other job through to Sidekiq" do
      expect(connection).not_to receive(:call)
      other_job = job.merge("class" => "SomeRubyJob")

      result = described_class.new.call("SomeRubyJob", other_job, "low", redis_pool) { :pushed }

      expect(result).to eq(:pushed)
    end

    describe "mail deliveries" do
      def mail_job(mailer, method)
        {
          "class" => SidekiqNodeBridge::ACTIVE_JOB_WRAPPER,
          "wrapped" => "MailDeliveryJob",
          "queue" => "default",
          "jid" => "def456",
          "args" => [{ "job_class" => "MailDeliveryJob", "arguments" => [mailer, method, "deliver_now", { "args" => [] }] }],
        }
      end

      it "pushes a delivery of a Node-owned mailer method to the inbox" do
        item = mail_job("UserSignupMailer", "email_changed")
        expect(connection).to receive(:call).with("LPUSH", SidekiqNodeBridge::INBOX, Sidekiq.dump_json(item))

        result = described_class.new.call(SidekiqNodeBridge::ACTIVE_JOB_WRAPPER, item, "default", redis_pool) { :pushed }

        expect(result).to eq(false)
      end

      it "lets deliveries of other mailer methods and other ActiveJobs through to Sidekiq" do
        expect(connection).not_to receive(:call)
        other_method = mail_job("UserSignupMailer", "reset_password_instructions")
        other_job = mail_job("UserSignupMailer", "email_changed").tap { |item| item["args"][0]["job_class"] = "SomeActiveJob" }

        [other_method, other_job].each do |item|
          expect(described_class.new.call(SidekiqNodeBridge::ACTIVE_JOB_WRAPPER, item, "default", redis_pool) { :pushed }).to eq(:pushed)
        end
      end
    end
  end
end
