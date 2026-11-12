# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/sitemap-workers.golden.json: the lock-contention paths of RefreshSitemapDailyWorker,
# RefreshWishlistSitemapDailyWorker and the categories step of RefreshSitemapMonthlyWorker, run by the real app as Sidekiq jobs
# (support/sidekiq_executor.rb) against the real SitemapService generation lock. A run that wins the lock goes on to write the
# sitemap (SitemapGenerator, S3), which Node does not do: those cases stop at the first configuration call, which a marker exception
# stands in for, and are what Node hands back to Rails. Run it like publish-scheduled-post.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/sitemap-workers.rb   (env as in publish-scheduled-post.rb)
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/sitemap-workers.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
LOCK = RedisKey.sitemap_generation_lock

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

SitemapService.prepend(Module.new do
  private

  def sitemap_config(*) = raise(HandBackMarker)
end)

def held = -> { redis.set(LOCK, "another-run", ex: 3600) }

def run(name, job, args, locked: false)
  hands_back = false
  result = capture(name, now: NOW, tables: [], setup: locked ? held : nil, sidekiq: true, job:, args:) do
    job.constantize.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("a daily run while another run writes", "RefreshSitemapDailyWorker", ["2026-10-01"], locked: true)
cases << run("a daily run with no date while another run writes", "RefreshSitemapDailyWorker", [], locked: true)
cases << run("a daily run with a date that does not parse while another run writes", "RefreshSitemapDailyWorker", ["not a date"], locked: true)
cases << run("a daily run with a non-string date while another run writes", "RefreshSitemapDailyWorker", [5], locked: true)
cases << run("a daily run that wins the lock", "RefreshSitemapDailyWorker", ["2026-10-01"])
cases << run("a daily run with no date that wins the lock", "RefreshSitemapDailyWorker", [])
cases << run("a daily run with a date that does not parse", "RefreshSitemapDailyWorker", ["not a date"])
cases << run("a wishlist run while another run writes", "RefreshWishlistSitemapDailyWorker", [], locked: true)
cases << run("a wishlist run that wins the lock", "RefreshWishlistSitemapDailyWorker", [])
cases << run("a categories retry while another run writes", "RefreshSitemapMonthlyWorker", ["categories_only", 1], locked: true)
cases << run("a categories retry on the last attempt but one", "RefreshSitemapMonthlyWorker", ["categories_only", 23], locked: true)
cases << run("a categories retry on the last attempt", "RefreshSitemapMonthlyWorker", ["categories_only", 24], locked: true)
cases << run("a categories retry past the last attempt", "RefreshSitemapMonthlyWorker", ["categories_only", 30], locked: true)
cases << run("a categories retry with the attempt as a string", "RefreshSitemapMonthlyWorker", ["categories_only", "2"], locked: true)
cases << run("a categories retry with no attempt", "RefreshSitemapMonthlyWorker", ["categories_only"], locked: true)
cases << run("a categories retry that wins the lock", "RefreshSitemapMonthlyWorker", ["categories_only", 3])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
