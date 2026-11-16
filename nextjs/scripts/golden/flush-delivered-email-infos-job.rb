# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/flush-delivered-email-infos-job.golden.json: FlushDeliveredEmailInfosJob
# (EmailInfo.flush_delivered_buffer!) run by the real app against a scratch database and Redis as a Sidekiq job
# (support/sidekiq_executor.rb). Run it like workflow-jobs.rb, with USE_DB_WORKER_REPLICAS=true and one Redis database for
# REDIS_HOST and SIDEKIQ_REDIS_HOST:
#
#   bundle exec rails runner nextjs/scripts/golden/flush-delivered-email-infos-job.rb
#
# A case may shrink the chunk size and the chunk cap (recorded as `chunk` and `max_chunks`) so a few entries cover the
# chunk loop, and may make the lock renewal fail from its nth call on (`lose_lock_at`).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/flush-delivered-email-infos-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
TABLES = %w[email_infos].freeze
DEFAULT_CHUNK = EmailInfo::DELIVERED_BUFFER_CHUNK
DEFAULT_MAX_CHUNKS = EmailInfo::MAX_FLUSH_CHUNKS
SENT_AT = "2026-11-01 08:00:00"
BASE = Time.utc(2026, 11, 3, 10, 0, 0).to_i

Rails.logger = ActiveSupport::Logger.new(nil)

$uuid_seq = 0
SecureRandom.singleton_class.prepend(Module.new do
  def uuid
    $uuid_seq += 1
    format("00000000-0000-4000-8000-%012d", $uuid_seq)
  end
end)

$renew_calls = 0
$lose_lock_at = nil
EmailInfo.singleton_class.prepend(Module.new do
  def renew_flush_lock!(lock_key, token)
    $renew_calls += 1
    return false if $lose_lock_at && $renew_calls >= $lose_lock_at

    super
  end
end)

def set_constant(name, value)
  EmailInfo.send(:remove_const, name)
  EmailInfo.const_set(name, value)
end

def info(id, installment_id: 1, purchase_id: id, state: "sent", type: "CreatorContactingCustomersEmailInfo", **overrides)
  { id:, purchase_id:, installment_id:, type:, email_name: "creator_contacting_customers_email", state:, sent_at: SENT_AT }.merge(overrides)
end

def entry(installment_id, purchase_id, epoch) = { i: installment_id, p: purchase_id, t: epoch }.to_json

def run(name, rows, buffer: [], inflight: [], lock: false, chunk: DEFAULT_CHUNK, max_chunks: DEFAULT_MAX_CHUNKS, lose_lock_at: nil)
  $uuid_seq = 0
  $renew_calls = 0
  $lose_lock_at = lose_lock_at
  set_constant(:DELIVERED_BUFFER_CHUNK, chunk)
  set_constant(:MAX_FLUSH_CHUNKS, max_chunks)
  setup = lambda {
    buffer.each { $redis.rpush(RedisKey.email_info_delivered_buffer, _1) }
    inflight.each { $redis.rpush(RedisKey.email_info_delivered_inflight, _1) }
    $redis.set(RedisKey.email_info_delivered_flush_lock, "held-by-another-process", ex: 600) if lock
  }
  result = capture(name, now: NOW, tables: TABLES, seed: { email_infos: rows }, setup:, sidekiq: true, job: "FlushDeliveredEmailInfosJob", args: [],
                         chunk:, max_chunks:, lose_lock_at:) { FlushDeliveredEmailInfosJob.new.perform }
  result.delete("seed")
  result
end

cases = []
cases << run("nothing buffered", [])
cases << run("a sent email delivered", [info(1)], buffer: [entry(1, 1, BASE)])
cases << run("a created email delivered", [info(1, state: "created", sent_at: nil)], buffer: [entry(1, 1, BASE)])
%w[delivered opened bounced].each_with_index do |state, i|
  cases << run("a #{state} email is not moved", [info(1, state:, delivered_at: "2026-11-02 09:00:00", opened_at: ("2026-11-02 09:30:00" if state == "opened"))], buffer: [entry(1, 1, BASE + i)])
end
cases << run("an email with no state is not moved", [info(1, state: nil)], buffer: [entry(1, 1, BASE)])
cases << run("a created email that already has a delivered time", [info(1, state: "created", delivered_at: "2026-11-02 09:00:00")], buffer: [entry(1, 1, BASE)])
cases << run("an email of another type is not touched", [info(1, type: nil), info(2, type: "EmailInfo", purchase_id: 1)], buffer: [entry(1, 1, BASE)])
cases << run("an email of another installment is not touched", [info(1, installment_id: 2)], buffer: [entry(1, 1, BASE)])
cases << run("an entry with no email info", [], buffer: [entry(1, 1, BASE)])
cases << run("the earliest of three deliveries of a purchase wins", [info(1)], buffer: [entry(1, 1, BASE + 60), entry(1, 1, BASE), entry(1, 1, BASE + 30)])
cases << run("an entry at the epoch", [info(1)], buffer: [entry(1, 1, 0)])
cases << run("an entry far in the future", [info(1)], buffer: [entry(1, 1, 4_102_444_800)])
cases << run("several purchases of one installment", [info(1), info(2), info(3)], buffer: [entry(1, 3, BASE + 3), entry(1, 1, BASE + 1), entry(1, 2, BASE + 2)])
cases << run("several installments", [info(1), info(2, installment_id: 2), info(3, installment_id: 3)],
             buffer: [entry(2, 2, BASE + 2), entry(1, 1, BASE + 1), entry(3, 3, BASE + 3), entry(1, 1, BASE + 4)])
cases << run("the same purchase in two installments", [info(1), info(2, installment_id: 2, purchase_id: 1)], buffer: [entry(1, 1, BASE), entry(2, 1, BASE + 5)])
cases << run("a purchase and installment id past 32 bits", [info(1, installment_id: 5_000_000_000, purchase_id: 6_000_000_000)], buffer: [entry(5_000_000_000, 6_000_000_000, BASE)])
cases << run("another process holds the lock", [info(1)], buffer: [entry(1, 1, BASE)], lock: true)
cases << run("a chunk of two entries then a short one", (1..3).map { info(_1) }, buffer: (1..3).map { entry(1, _1, BASE + _1) }, chunk: 2)
cases << run("a buffer that fills the chunk exactly", (1..4).map { info(_1) }, buffer: (1..4).map { entry(1, _1, BASE + _1) }, chunk: 2)
cases << run("a chunk of four split into slices of four purchases", (1..5).map { info(_1) }, buffer: (1..5).map { entry(1, _1, BASE + _1) }, chunk: 4)
cases << run("the chunk cap leaves the rest buffered", (1..7).map { info(_1) }, buffer: (1..7).map { entry(1, _1, BASE + _1) }, chunk: 2, max_chunks: 2)
cases << run("a chunk cap of zero", [info(1)], buffer: [entry(1, 1, BASE)], max_chunks: 0)
cases << run("an unfinished chunk is applied before the buffer", (1..3).map { info(_1) },
             buffer: [entry(1, 3, BASE + 3)], inflight: [entry(1, 1, BASE + 1), entry(1, 2, BASE + 2)])
cases << run("an unfinished chunk alone", [info(1), info(2)], inflight: [entry(1, 1, BASE), entry(1, 2, BASE + 1)])
cases << run("an unfinished chunk longer than the chunk size", (1..3).map { info(_1) }, inflight: (1..3).map { entry(1, _1, BASE + _1) }, chunk: 2)
cases << run("the lock is lost before the first chunk", [info(1)], buffer: [entry(1, 1, BASE)], lose_lock_at: 1)
cases << run("the lock is lost while the first chunk is applied", [info(1)], buffer: [entry(1, 1, BASE)], lose_lock_at: 2)
cases << run("the lock is lost between two installments", [info(1), info(2, installment_id: 2)], buffer: [entry(1, 1, BASE), entry(2, 2, BASE + 1)], lose_lock_at: 3)
cases << run("the lock is lost before the second chunk", (1..4).map { info(_1) }, buffer: (1..4).map { entry(1, _1, BASE + _1) }, chunk: 2, lose_lock_at: 4)
cases << run("many entries across installments", (1..12).map { info(_1, installment_id: 1 + (_1 % 3)) }, buffer: (1..12).map { entry(1 + (_1 % 3), _1, BASE + _1) }, chunk: 5)

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
