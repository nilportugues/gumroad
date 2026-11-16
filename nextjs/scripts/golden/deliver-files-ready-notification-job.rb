# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/deliver-files-ready-notification-job.golden.json: DeliverFilesReadyNotificationJob run by
# the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). The request check (a flag bit on the purchase's
# `UrlRedirect`) and `Purchase.find` run in Node; a purchase whose buyer asked for the notification reaches
# `PdfStampingService.stamp_pending?`, which Node hands back, recorded up to there with a marker exception (`hands_back`). Run it like
# pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/deliver-files-ready-notification-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[purchases url_redirects].freeze
REQUESTED = 1 << 4
ENQUEUED = 1 << 5

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

PdfStampingService.singleton_class.prepend(Module.new do
  def stamp_pending?(*, **) = raise(HandBackMarker)
end)

def purchase_row(id, **overrides)
  { id:, link_id: 1, seller_id: 1, email: "buyer#{id}@example.com", purchase_state: "successful", price_cents: 100, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def redirect_row(id, purchase_id, flags: REQUESTED) = { id:, purchase_id:, token: "token#{id}", flags:, created_at: SEEDED_AT, updated_at: SEEDED_AT }

def run(name, args, purchases, redirects = [])
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { purchases:, url_redirects: redirects }, sidekiq: true, job: "DeliverFilesReadyNotificationJob", args:) do
    DeliverFilesReadyNotificationJob.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("a purchase without a download page", [1], [purchase_row(1)])
cases << run("a purchase whose buyer asked for the notification", [1], [purchase_row(1)], [redirect_row(1, 1)])
cases << run("a purchase whose request is also enqueued", [1], [purchase_row(1)], [redirect_row(1, 1, flags: REQUESTED | ENQUEUED)])
cases << run("a purchase whose notification was not requested", [1], [purchase_row(1)], [redirect_row(1, 1, flags: 0)])
cases << run("a purchase whose notification is enqueued but not requested", [1], [purchase_row(1)], [redirect_row(1, 1, flags: ENQUEUED)])
cases << run("a request for a purchase that does not exist", [9], [purchase_row(1)], [redirect_row(1, 9)])
cases << run("a request among other redirects", [2], [purchase_row(1), purchase_row(2)], [redirect_row(1, 1, flags: 0), redirect_row(2, 2), redirect_row(3, 3)])
cases << run("a request on a later poll", [1, 3], [purchase_row(1)], [redirect_row(1, 1)])
cases << run("a request on the last poll", [1, 120], [purchase_row(1)], [redirect_row(1, 1)])
cases << run("a purchase id of nil", [nil], [purchase_row(1)], [redirect_row(1, 1)])
cases << run("a purchase id as a digit string", ["1"], [purchase_row(1)], [redirect_row(1, 1)])
cases << run("a purchase id as a float", [1.0], [purchase_row(1)], [redirect_row(1, 1)])
cases << run("a purchase id as a word", ["one"], [purchase_row(1)], [redirect_row(1, 1)])
cases << run("an empty purchase id", [""], [purchase_row(1)], [redirect_row(1, 1)])
cases << run("no arguments", [], [purchase_row(1)], [redirect_row(1, 1)])
cases << run("one argument too many", [1, 0, 1], [purchase_row(1)], [redirect_row(1, 1)])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
