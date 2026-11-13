# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/alert-sellers-of-undelivered-receipts-job.golden.json:
# AlertSellersOfUndeliveredReceiptsJob run by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb).
# Node runs the cursor (stored, or the first-run boundary when the newest receipts are all older than the lookback) and the receipt scan
# up to the first row old enough to judge; a run that reaches one is where Node hands back (its purchase, buyer and seller are read and
# the digest mail is enqueued). Those cases are recorded up to the first judged row, which a marker exception stands in for, as are a
# first-run boundary inside the lookback (a binary search) and a previous run's retry set. The Redis a case starts from is its
# `redis_before` (REDIS_HOST and SIDEKIQ_REDIS_HOST must name the same database). Run it like send-bundles-marketing-email-job.rb
# (USE_DB_WORKER_REPLICAS=true).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/alert-sellers-of-undelivered-receipts-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
TABLES = %w[email_infos].freeze
CURSOR = "undelivered_receipt_sweep:cursor"
PENDING = "undelivered_receipt_sweep:pending_retry"

Rails.logger = ActiveSupport::Logger.new(nil)
ErrorNotifier.singleton_class.prepend(Module.new { def notify(*) = nil })

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

AlertSellersOfUndeliveredReceiptsJob.prepend(Module.new do
  private

  def collect(*, **) = raise(HandBackMarker)
  def block_from(*, **) = raise(HandBackMarker)

  def collect_pending_retries(by_seller)
    raise HandBackMarker if UndeliveredReceiptNotifier.pending_retry_purchase_ids(AlertSellersOfUndeliveredReceiptsJob::MAX_RETRIES_PER_RUN).any?

    super
  end
end)

def at(seconds_from_now) = (NOW + seconds_from_now).utc.strftime("%Y-%m-%d %H:%M:%S")

def info_row(id, **overrides)
  { id:, purchase_id: id, type: "CustomerEmailInfo", email_name: "receipt", state: "sent", sent_at: at(-3 * 86_400), delivered_at: nil, opened_at: nil }.merge(overrides)
end

def run(name, infos: [], cursor: nil, retry_ids: [])
  hands_back = false
  setup = -> { redis.set(CURSOR, cursor) unless cursor.nil?; retry_ids.each { redis.sadd(PENDING, _1) } }
  result = capture(name, now: NOW, tables: TABLES, seed: { email_infos: infos }, setup:, sidekiq: true, job: "AlertSellersOfUndeliveredReceiptsJob", args: []) do
    AlertSellersOfUndeliveredReceiptsJob.new.perform
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

old = at(-3 * 86_400)
young = at(-86_400)
month = at(-30 * 86_400)

cases = []
cases << run("no receipts and a cursor", cursor: "5")
cases << run("no receipts and a cursor of zero", cursor: "0")
cases << run("no receipts and no cursor")
cases << run("a stored cursor that is not a number", cursor: "abc", infos: [info_row(1, sent_at: young)])
cases << run("a stored cursor that is empty and no receipts", cursor: "")
cases << run("a stored cursor of only spaces and no receipts", cursor: "  ")
cases << run("a stored cursor with leading spaces", cursor: "  7", infos: [info_row(9, sent_at: young)])
cases << run("a stored cursor with trailing text", cursor: "2x", infos: [info_row(3, sent_at: young)])
cases << run("a receipt sent a day ago", cursor: "0", infos: [info_row(1, sent_at: young)])
cases << run("a receipt sent two days and a second ago", cursor: "0", infos: [info_row(1, sent_at: at(-2 * 86_400 - 1))])
cases << run("a receipt sent two days ago to the second", cursor: "0", infos: [info_row(1, sent_at: at(-2 * 86_400))])
cases << run("a receipt sent two days less a second ago", cursor: "0", infos: [info_row(1, sent_at: at(-2 * 86_400 + 1))])
cases << run("a receipt sent a second from now", cursor: "0", infos: [info_row(1, sent_at: at(1))])
cases << run("a receipt that was never sent", cursor: "0", infos: [info_row(1, sent_at: nil, state: "created")])
cases << run("a bounced receipt that was never stamped", cursor: "0", infos: [info_row(1, sent_at: nil, state: "bounced")])
cases << run("a bounced receipt sent three days ago", cursor: "0", infos: [info_row(1, state: "bounced")])
cases << run("a receipt sent three days ago", cursor: "0", infos: [info_row(1)])
cases << run("a delivered receipt", cursor: "0", infos: [info_row(1, state: "delivered")])
cases << run("an opened receipt", cursor: "0", infos: [info_row(1, state: "opened")])
cases << run("a receipt in a created state", cursor: "0", infos: [info_row(1, state: "created")])
cases << run("a receipt with no state", cursor: "0", infos: [info_row(1, state: nil)])
cases << run("a receipt of another email name", cursor: "0", infos: [info_row(1, email_name: "preorder_receipt")])
cases << run("a receipt with no email name", cursor: "0", infos: [info_row(1, email_name: nil)])
cases << run("an email info of another type", cursor: "0", infos: [info_row(1, type: "EmailInfo")])
cases << run("an email info with no type", cursor: "0", infos: [info_row(1, type: nil)])
cases << run("a receipt at the cursor", cursor: "1", infos: [info_row(1)])
cases << run("a receipt before the cursor", cursor: "4", infos: [info_row(1), info_row(2)])
cases << run("a receipt after the cursor", cursor: "1", infos: [info_row(1), info_row(2)])
cases << run("a young receipt after settled ones at the cursor", cursor: "2", infos: [info_row(1), info_row(2), info_row(3, sent_at: young)])
cases << run("a young receipt first, an old one after", cursor: "0", infos: [info_row(1, sent_at: young), info_row(2)])
cases << run("an old receipt first, a young one after", cursor: "0", infos: [info_row(1), info_row(2, sent_at: young)])
cases << run("an unsent receipt first, an old one after", cursor: "0", infos: [info_row(1, sent_at: nil), info_row(2)])
cases << run("two young receipts", cursor: "0", infos: [info_row(1, sent_at: young), info_row(2, sent_at: young)])
cases << run("a delivered receipt before a young one", cursor: "0", infos: [info_row(1, state: "delivered"), info_row(2, sent_at: young)])
cases << run("a receipt with no purchase", cursor: "0", infos: [info_row(1, purchase_id: nil)])
cases << run("a young receipt with no purchase", cursor: "0", infos: [info_row(1, purchase_id: nil, sent_at: young)])
cases << run("a retry set and no receipts", cursor: "3", retry_ids: [11])
cases << run("a retry set and a young receipt", cursor: "0", retry_ids: [11, 12], infos: [info_row(1, sent_at: young)])
cases << run("a retry set and no cursor on an empty table", retry_ids: [11])
cases << run("a retry set and a receipt a month old and no cursor", retry_ids: [11], infos: [info_row(1, sent_at: month)])
cases << run("no cursor and only receipts a month old", infos: [info_row(1, sent_at: month), info_row(2, sent_at: month)])
cases << run("no cursor and only receipts without a send time", infos: [info_row(1, sent_at: nil), info_row(2, sent_at: nil)])
cases << run("no cursor and a receipt a week old", infos: [info_row(1, sent_at: month), info_row(2, sent_at: at(-7 * 86_400 - 1800))])
cases << run("no cursor and a receipt inside the lookback", infos: [info_row(1, sent_at: month), info_row(2, sent_at: at(-86_400))])
cases << run("no cursor and a receipt just past the skew bound", infos: [info_row(1, sent_at: at(-7 * 86_400 - 3600 - 1))])
cases << run("no cursor and a receipt at the skew bound", infos: [info_row(1, sent_at: at(-7 * 86_400 - 3600))])
cases << run("no cursor and a receipt of another email name inside the lookback", infos: [info_row(1, sent_at: month), info_row(2, sent_at: young, email_name: "preorder_receipt")])
cases << run("no cursor and one recent receipt", infos: [info_row(1, sent_at: young)])
cases << run("no cursor and a recent receipt that was never sent", infos: [info_row(1, sent_at: month), info_row(2, sent_at: nil)])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
