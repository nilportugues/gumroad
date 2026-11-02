# frozen_string_literal: true

# Golden for infra/anycable.ts: what `CommunityChannel.broadcast_to("community_<id>", payload)` writes to Redis in production
# (cable.yml `any_cable` adapter over AnyCable's `redisx` broadcaster), run by the real gems against a scratch Redis database.
#
#   REDIS_DB=7 bundle exec rails runner nextjs/scripts/golden/anycable.rb > nextjs/src/server/infra/__fixtures__/anycable.golden.json
require "json"
require "redis"

redis_url = "redis://127.0.0.1:6379/#{ENV.fetch("REDIS_DB")}"
STREAM = "__anycable_golden__"

AnyCable.config.redis_url = redis_url
AnyCable.config.redis_channel = STREAM
AnyCable.broadcast_adapter = :redisx

class GoldenChannel < ActionCable::Channel::Base
end

# config/cable.yml selects the test adapter in the test environment; production uses `any_cable`.
ActionCable.server.config.cable = { "adapter" => "any_cable" }
ActionCable.server.remove_instance_variable(:@pubsub) if ActionCable.server.instance_variable_defined?(:@pubsub)

redis = Redis.new(url: redis_url)
redis.del(STREAM)

CASES = {
  "plain message" => { type: "create_chat_message", message: { id: "abc=", content: "Hello", user: { id: "1", name: "Ann", is_seller: true } } },
  "html and separators" => { type: "update_chat_message", message: { id: "abc=", content: "a < b > c & d   e   f \"q\" \\ / é 😀" } },
  "null avatar and delete" => { type: "delete_chat_message", message: { id: "x", user: { avatar_url: nil, name: nil } } },
}.freeze

cases = CASES.map do |name, payload|
  redis.del(STREAM)
  GoldenChannel.broadcast_to("community_zzz", payload)
  entries = redis.xrange(STREAM, "-", "+")
  { name:, payload:, stream_entries: entries.map { |(_id, fields)| fields } }
end

redis.del(STREAM)
puts JSON.pretty_generate({ channel: "community", cases: })
