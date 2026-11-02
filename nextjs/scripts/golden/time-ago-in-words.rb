# frozen_string_literal: true

# Writes src/server/models/concerns/__fixtures__/time-ago-in-words.golden.json: ActionView's distance_of_time_in_words
# (what `time_ago_in_words` calls) for a spread of distances. Run with `bundle exec ruby nextjs/scripts/golden/time-ago-in-words.rb`.
require "action_view"
require "json"
require "time"

include ActionView::Helpers::DateHelper

to = Time.utc(2026, 11, 1, 12, 0, 0)
offsets = [0, 29, 30, 89, 90, 119, 120, 44 * 60, 45 * 60, 89 * 60, 90 * 60, 23 * 3600, 24 * 3600, 41 * 3600, 42 * 3600, 20 * 86_400, 29 * 86_400, 30 * 86_400, 44 * 86_400, 59 * 86_400,
           60 * 86_400, 200 * 86_400, 364 * 86_400, 365 * 86_400, 400 * 86_400, 500 * 86_400, 600 * 86_400, 700 * 86_400, 800 * 86_400, 1100 * 86_400, 2000 * 86_400, 4000 * 86_400]
cases = offsets.map { |seconds| { "from" => (to - seconds).iso8601, "to" => to.iso8601, "words" => distance_of_time_in_words(to - seconds, to) } }
# Leap-year handling depends on the calendar position, not just the distance.
[Time.utc(2020, 2, 1), Time.utc(2019, 3, 1), Time.utc(2016, 2, 29)].each do |from|
  [Time.utc(2022, 1, 1), Time.utc(2024, 2, 1), Time.utc(2026, 11, 1)].each do |upto|
    cases << { "from" => from.iso8601, "to" => upto.iso8601, "words" => distance_of_time_in_words(from, upto) }
  end
end
File.write(File.expand_path("../../src/server/models/concerns/__fixtures__/time-ago-in-words.golden.json", __dir__), "#{JSON.pretty_generate(cases)}\n")
