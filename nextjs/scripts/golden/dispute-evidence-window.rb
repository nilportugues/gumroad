# frozen_string_literal: true

# Produces nextjs/src/server/models/__fixtures__/dispute-evidence-window.golden.json: the evidence
# window arithmetic of app/models/dispute_evidence.rb (due date, weekend extension, open check, hour
# count, reminder time) over a grid of stamps around the cutover, weekends and midnights. Pure
# computation: run it with the usual test environment, e.g.
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_ws49 TEST_DATABASE_NAME=gumroad_ws49 DISABLE_TEST_REDIS_ISOLATION=1 \
#     bundle exec rails runner nextjs/scripts/golden/dispute-evidence-window.rb
include ActiveSupport::Testing::TimeHelpers

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/dispute-evidence-window.golden.json")

def iso(time) = time&.utc&.strftime("%Y-%m-%dT%H:%M:%S.%LZ")

stamps = []
(Time.utc(2026, 9, 30)..Time.utc(2026, 10, 21)).step(6.hours) { stamps << _1 }
# Midnights and the instants either side of them, around the cutover and a weekend.
[Time.utc(2026, 10, 5), Time.utc(2026, 10, 2), Time.utc(2026, 10, 9), Time.utc(2026, 10, 10), Time.utc(2026, 10, 11), Time.utc(2026, 10, 12)].each do |midnight|
  stamps.push(midnight - 1.second, midnight, midnight + 1.second, midnight + 0.5.seconds)
end
stamps.push(Time.utc(2025, 1, 1), Time.utc(2026, 10, 4, 23, 59, 59, 999_000), Time.utc(2026, 12, 31, 23, 59, 59))
stamps.uniq!

cases = stamps.map do |stamp|
  due_at = DisputeEvidence.seller_response_due_at(stamp)
  nows = [stamp, stamp + 1.hour, due_at - 1.second, due_at - 0.001.seconds, due_at, due_at + 0.001.seconds, due_at + 1.day, due_at - 29.minutes].uniq
  {
    "stamp" => iso(stamp),
    "due_at" => iso(due_at),
    "reminder_at" => iso(DisputeEvidence.seller_response_reminder_at(stamp)),
    "at" => nows.map do |now|
      travel_to(now, with_usec: true) { [iso(now), DisputeEvidence.window_open?(stamp), DisputeEvidence.hours_left_in_window(stamp)] }
    end,
  }
end

nil_case = { "due_at" => DisputeEvidence.seller_response_due_at(nil), "reminder_at" => DisputeEvidence.seller_response_reminder_at(nil), "hours_left" => DisputeEvidence.hours_left_in_window(nil) }
File.write(OUT, JSON.pretty_generate({ "cases" => cases, "nil" => nil_case }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} stamps)"
