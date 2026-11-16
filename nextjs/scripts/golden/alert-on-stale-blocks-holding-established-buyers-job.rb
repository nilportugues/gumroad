# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/alert-on-stale-blocks-holding-established-buyers-job.golden.json:
# AlertOnStaleBlocksHoldingEstablishedBuyersJob run by the real app against a scratch database as a Sidekiq job
# (support/sidekiq_executor.rb). An active email block past the cursor is where Node hands back (the settled-purchase counts, the
# sibling blocks and the unblock writes follow); those cases are recorded up to the first settled-purchase read, which a marker
# exception stands in for. The cursor a case starts from is its `redis_before` (REDIS_HOST and SIDEKIQ_REDIS_HOST must name the same
# database). Run it like send-bundles-marketing-email-job.rb (USE_DB_WORKER_REPLICAS=true).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/alert-on-stale-blocks-holding-established-buyers-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[platform_blocks].freeze
CURSOR = "stale_block_sweep:cursor"

Rails.logger = ActiveSupport::Logger.new(nil)
ErrorNotifier.singleton_class.prepend(Module.new { def notify(*) = nil })

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

AlertOnStaleBlocksHoldingEstablishedBuyersJob.prepend(Module.new do
  private

  def settled_purchase_counts(*, **) = raise(HandBackMarker)
end)

def at(seconds_from_now) = (NOW + seconds_from_now).utc.strftime("%Y-%m-%d %H:%M:%S.%6N")

def block_row(id, **overrides)
  { id:, object_type: "email", object_value: "Buyer#{id}@example.com", blocked_at: SEEDED_AT, expires_at: nil, blocked_by: nil, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, blocks: [], cursor: nil)
  hands_back = false
  setup = cursor.nil? ? nil : -> { redis.set(CURSOR, cursor) }
  result = capture(name, now: NOW, tables: TABLES, seed: { platform_blocks: blocks }, setup:, sidekiq: true, job: "AlertOnStaleBlocksHoldingEstablishedBuyersJob", args: []) do
    AlertOnStaleBlocksHoldingEstablishedBuyersJob.new.perform
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("no blocks")
cases << run("no blocks and a cursor", cursor: "5")
cases << run("no blocks and a cursor of zero", cursor: "0")
cases << run("an active email block", blocks: [block_row(1)])
cases << run("an active email block past the cursor", blocks: [block_row(1), block_row(2)], cursor: "1")
cases << run("an active email block at the cursor", blocks: [block_row(1)], cursor: "1")
cases << run("an active email block before the cursor", blocks: [block_row(1)], cursor: "7")
cases << run("two active email blocks before the cursor", blocks: [block_row(1), block_row(2)], cursor: "7")
cases << run("an email block before the cursor, none after, then none to start over", blocks: [block_row(1, blocked_by: 3)], cursor: "7")
cases << run("an active email block and a cursor that is not a number", blocks: [block_row(1)], cursor: "abc")
cases << run("an active email block and an empty cursor", blocks: [block_row(1)], cursor: "")
cases << run("an active email block and a cursor with trailing text", blocks: [block_row(2)], cursor: "1x")
cases << run("an active email block and a cursor of only spaces", blocks: [block_row(1)], cursor: "  ")
cases << run("an active email block and a cursor with leading spaces", blocks: [block_row(3)], cursor: "  2")
cases << run("an active email block and a negative cursor", blocks: [block_row(1)], cursor: "-4")
cases << run("an active block of another type", blocks: [block_row(1, object_type: "ip_address")])
cases << run("an active block of another type before the cursor", blocks: [block_row(1, object_type: "browser_guid")], cursor: "7")
cases << run("an active email-domain block", blocks: [block_row(1, object_type: "email_domain")])
cases << run("an email block set by a person", blocks: [block_row(1, blocked_by: 4)])
cases << run("an email block that is not blocked yet", blocks: [block_row(1, blocked_at: nil)])
cases << run("an email block that expired a second ago", blocks: [block_row(1, expires_at: at(-1))])
cases << run("an email block that expires now", blocks: [block_row(1, expires_at: at(0))])
cases << run("an email block that expires a second from now", blocks: [block_row(1, expires_at: at(1))])
cases << run("an email block that expires in a day", blocks: [block_row(1, expires_at: at(86_400))])
cases << run("an expired email block before an active one", blocks: [block_row(1, expires_at: at(-60)), block_row(2)])
cases << run("an email block set by a person before an active one", blocks: [block_row(1, blocked_by: 4), block_row(2)])
cases << run("three active email blocks", blocks: [block_row(1), block_row(2), block_row(3)])
cases << run("an active email block with a gap in ids", blocks: [block_row(3), block_row(9)], cursor: "4")

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
