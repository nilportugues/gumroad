# frozen_string_literal: true

# Writes flipper.golden.json with flipper 1.3.0 and flipper-redis 1.3.0 (the versions in Gemfile.lock):
# the Redis hashes Flipper::Adapters::Redis writes for each gate, and Flipper's own enabled? answer
# for a set of actors.
#   GEM_HOME=<dir with flipper/flipper-redis 1.3.0> ruby flipper.rb > ../flipper.golden.json
require "flipper"
require "flipper/adapters/redis"
require "json"
require "set"
require "zlib"

# Just enough of the redis-rb API for Flipper::Adapters::Redis, so the dump is exactly what it writes.
class RecordingRedis
  attr_reader :data

  def initialize = @data = {}
  def sadd(key, member) = (@data[key] ||= Set.new) << member.to_s
  def srem(key, member) = @data[key]&.delete(member.to_s)
  def smembers(key) = (@data[key] || Set.new).to_a
  def del(key) = @data.delete(key)
  def hset(key, field, value) = (@data[key] ||= {})[field.to_s] = value.to_s
  def hdel(key, field) = @data[key]&.delete(field.to_s)
  def hgetall(key) = (@data[key] || {}).dup
  def pipelined = yield(self).then { |results| results }
end

redis = RecordingRedis.new
flipper = Flipper.new(Flipper::Adapters::Redis.new(redis))

flipper.enable(:bool_on)
flipper.enable(:bool_off)
flipper.disable(:bool_off)
flipper.enable_actor(:actors, Flipper::Actor.new("User;1"))
flipper.enable_actor(:actors, Flipper::Actor.new("User;42"))
flipper.enable_actor(:actors, Flipper::Actor.new("browser_guid:abc/def"))
flipper.enable_percentage_of_actors(:pct_actors_25, 25)
flipper.enable_percentage_of_actors(:pct_actors_decimal, 12.345)
flipper.enable_percentage_of_actors(:pct_actors_zero, 0)
flipper.enable_percentage_of_actors(:pct_actors_100, 100)
flipper.enable_percentage_of_time(:pct_time_100, 100)
flipper.enable_percentage_of_time(:pct_time_0, 0)
flipper.enable_actor(:combined, Flipper::Actor.new("User;7"))
flipper.enable_percentage_of_actors(:combined, 10)
flipper.enable_group(:group_only, :admins)
flipper.enable_actor(:actors_then_bool, Flipper::Actor.new("User;9"))
flipper.enable(:actors_then_bool)
flipper.enable_actor(:actors_then_off, Flipper::Actor.new("User;9"))
flipper.disable(:actors_then_off)

features = %w[
  bool_on bool_off actors pct_actors_25 pct_actors_decimal pct_actors_zero pct_actors_100
  pct_time_100 pct_time_0 combined group_only actors_then_bool actors_then_off never_created
]

actor_sets = [[]]
actor_sets += (1..200).map { |id| ["User;#{id}"] }
actor_sets += [["browser_guid:abc/def"], ["browser_guid:"], ["User;3", "User;5"], ["User;5", "User;3"], ["User;12", "User;7"]]

results = features.to_h do |feature|
  [feature, actor_sets.map { |ids| flipper.enabled?(feature, *ids.map { |id| Flipper::Actor.new(id) }) }]
end

crc32 = ["", "a", "pct_actors_25User;1", "featureUser;3User;5", "héllo"].to_h { |s| [s, Zlib.crc32(s)] }

puts JSON.pretty_generate(
  redis: redis.data.transform_values { |value| value.is_a?(Set) ? value.to_a.sort : value },
  actor_sets:,
  results:,
  crc32:,
)
