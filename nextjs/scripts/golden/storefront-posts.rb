# frozen_string_literal: true

# Produces nextjs/src/server/page-props/storefront/__fixtures__/storefront-posts.golden.json: what the
# storefront post page derives from a message and a timestamp, run by the real code: time_ago_in_words,
# PostPresenter#snippet, Installment#truncated_description and Post::SocialImage. Run from the repository
# root under the test environment (no database rows are read or written):
#
#   RAILS_ENV=test bundle exec rails runner nextjs/scripts/golden/storefront-posts.rb
require "json"
require "fileutils"

OUT = Rails.root.join("nextjs/src/server/page-props/storefront/__fixtures__/storefront-posts.golden.json")
helpers = Object.new.extend(ActionView::Helpers::DateHelper)

NOW = Time.utc(2026, 11, 1, 12, 0, 0)
MINUTE = 60
HOUR = 3600
DAY = 86_400
SECONDS = [
  0, 20, 29, 30, 31, 59, 60, 89, 90, 91, 149, 150, 151, 44 * MINUTE, 44 * MINUTE + 29, 44 * MINUTE + 30, 45 * MINUTE, 89 * MINUTE, 90 * MINUTE,
  3 * HOUR, 23 * HOUR + 59 * MINUTE, 24 * HOUR - 31, 24 * HOUR, 41 * HOUR, 41 * HOUR + 59 * MINUTE, 42 * HOUR, 2 * DAY, 3 * DAY + 11 * HOUR,
  29 * DAY, 29 * DAY + 23 * HOUR + 59 * MINUTE, 30 * DAY, 40 * DAY, 44 * DAY, 45 * DAY, 59 * DAY, 60 * DAY, 75 * DAY, 150 * DAY, 364 * DAY,
  365 * DAY, 366 * DAY, 400 * DAY, 500 * DAY, 548 * DAY, 600 * DAY, 700 * DAY, 730 * DAY, 800 * DAY, 1000 * DAY, 1461 * DAY, 2000 * DAY, 3650 * DAY
].freeze
time_ago = SECONDS.map { |seconds| [seconds, helpers.distance_of_time_in_words(NOW - seconds, NOW)] }
# Years straddle the leap-year rule, which depends on where the range starts.
leap = [Time.utc(2020, 2, 1), Time.utc(2020, 3, 1), Time.utc(2023, 1, 1), Time.utc(2024, 3, 2), Time.utc(2019, 12, 31)].flat_map do |from|
  [400, 730, 800, 1200].map { |days| [from.iso8601, (from + days * DAY).iso8601, helpers.distance_of_time_in_words(from, from + days * DAY)] }
end

MESSAGES = [
  "<p>Hello world</p>",
  "<p>Some words &amp; more &lt;b&gt; here</p>",
  "<p>First</p><p>Second</p><ul><li>One</li><li>Two</li></ul>",
  "<p>#{'word ' * 80}</p>",
  "<p>#{'x' * 300}</p>",
  "<h1>Title</h1><p>Body<br>with a break</p>",
  "<p>Intro</p><figure><img src=\"https://example.com/cover.png\"><p class=\"figcaption\">A caption</p></figure>",
  "<figure><img src=\"https://example.com/a.png\"></figure><figure><img src=\"https://example.com/b.png\"><p class=\"figcaption\">Second</p></figure>",
  "<figure><p>no image</p></figure><p>text</p>",
  "<p>Ünïcödé &mdash; text</p>",
  "<script>alert(1)</script><p>After</p>",
  "plain text",
  "  \n  ",
  "<p>a &nbsp; b</p>"
].freeze
messages = MESSAGES.map do |message|
  image = Post::SocialImage.for(message)
  presenter = PostPresenter.allocate
  presenter.define_singleton_method(:message) { message }
  installment = Installment.new(message:)
  {
    message:,
    snippet: presenter.snippet,
    truncated_description: installment.truncated_description,
    social_image: { url: image.url, caption: image.caption }
  }
end

FileUtils.mkdir_p(File.dirname(OUT))
File.write(OUT, JSON.pretty_generate({ now: NOW.iso8601, time_ago:, leap:, messages: }) + "\n")
puts "wrote #{OUT}"
