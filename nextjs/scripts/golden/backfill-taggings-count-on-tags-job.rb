# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/backfill-taggings-count-on-tags-job.golden.json: BackfillTaggingsCountOnTagsJob
# run by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). Run it like
# delete-expired-oauth-device-authorizations-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/backfill-taggings-count-on-tags-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[tags product_taggings].freeze
BATCH_SIZE = Onetime::BackfillTaggingsCountOnTags::BATCH_SIZE

Rails.logger = ActiveSupport::Logger.new(nil)

$replica_lag_watches = 0
ReplicaLagWatcher.singleton_class.prepend(Module.new do
  def watch(*) = ($replica_lag_watches += 1)
end)

def tag_row(id, taggings_count: 0, **overrides)
  { id:, name: "tag#{id}", humanized_name: "tag#{id}", taggings_count:, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def tagging_row(id, tag_id, product_id = id) = { id:, tag_id:, product_id:, created_at: SEEDED_AT, updated_at: SEEDED_AT }

# The job prints its progress; the cases keep it so Node can be held to the same lines.
def run(name, tags, taggings = [])
  $replica_lag_watches = 0
  stdout = $stdout
  $stdout = StringIO.new
  result = capture(name, now: NOW, tables: TABLES, seed: { tags:, product_taggings: taggings }, sidekiq: true, job: "BackfillTaggingsCountOnTagsJob", args: []) do
    BackfillTaggingsCountOnTagsJob.new.perform
  end
  result.merge("replica_lag_watches" => $replica_lag_watches, "output" => $stdout.string)
ensure
  $stdout = stdout
end

cases = []
cases << run("no tags", [])
cases << run("a tag with no taggings and a zero count", [tag_row(1)])
cases << run("a tag with no taggings and a stale count", [tag_row(1, taggings_count: 7)])
cases << run("a tag with three taggings", [tag_row(1)], (1..3).map { tagging_row(_1, 1) })
cases << run("a count that is already right", [tag_row(1, taggings_count: 2)], (1..2).map { tagging_row(_1, 1) })
cases << run("a count that is too high", [tag_row(1, taggings_count: 9)], [tagging_row(1, 1)])
cases << run("tags sharing counts and one of their own", [tag_row(1), tag_row(2), tag_row(3), tag_row(4, taggings_count: 5), tag_row(5)],
             [tagging_row(1, 2), tagging_row(2, 3), tagging_row(3, 3), tagging_row(4, 5), tagging_row(5, 1)])
cases << run("taggings of a tag that does not exist", [tag_row(1)], [tagging_row(1, 2), tagging_row(2, 1)])
cases << run("a tagging with no tag", [tag_row(1)], [tagging_row(1, nil)])
cases << run("tag ids that are not contiguous", [tag_row(10), tag_row(500), tag_row(70_000)], [tagging_row(1, 500), tagging_row(2, 70_000), tagging_row(3, 70_000)])
cases << run("one batch exactly", (1..BATCH_SIZE).map { tag_row(_1) }, [tagging_row(1, 1), tagging_row(2, BATCH_SIZE)])
cases << run("one tag past a batch", (1..(BATCH_SIZE + 1)).map { tag_row(_1) }, [tagging_row(1, 1), tagging_row(2, BATCH_SIZE), tagging_row(3, BATCH_SIZE + 1), tagging_row(4, BATCH_SIZE + 1)])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
