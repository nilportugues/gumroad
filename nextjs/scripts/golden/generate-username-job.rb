# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/generate-username-job.golden.json: GenerateUsernameJob run by the real app against a
# scratch database as a Sidekiq job (support/sidekiq_executor.rb). A user with no username and an email or a name reaches OpenAI: every
# outbound request is answered by WebMock (capture_http!) and recorded under `http`, and Node hands those cases back right after the user
# is read, before the request. Run it like seller-update-worker.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases
capture_http!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/generate-username-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users versions].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

def user_row(id, **overrides) = { id:, email: "user#{id}@example.com", username: nil, name: nil, external_id: (1000 + id).to_s, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def run(name, seed, id = 1)
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "GenerateUsernameJob", args: [id], at: NOW.to_f) do
    GenerateUsernameJob.new.perform(id)
  end
  result.delete("seed")
  result
end

cases = []
cases << run("a user that does not exist", {}, 9)
cases << run("a user id of nil", { users: [user_row(1)] }, nil)
cases << run("a user who already has a username", { users: [user_row(1, username: "alice")] })
cases << run("a user with an email and a username", { users: [user_row(1, username: "alice", name: "Alice")] })
cases << run("a user with no email and no name", { users: [user_row(1, email: nil)] })
cases << run("a user with a blank email and a blank name", { users: [user_row(1, email: "", name: "  ")] })
cases << run("a user with a blank email and a name", { users: [user_row(1, email: " ", name: "Alice Doe")] })
cases << run("a user with a null email and a name", { users: [user_row(1, email: nil, name: "Alice Doe")] })
cases << run("a user with an email and no username", { users: [user_row(1)] })
cases << run("a user with an email and a name and no username", { users: [user_row(1, name: "Alice Doe")] })
cases << run("a user whose username is blank text", { users: [user_row(1, username: "  ")] })
cases << run("a user whose username is an empty string", { users: [user_row(1, username: "")] })
cases << run("a user id given as a digit string and a username", { users: [user_row(1, username: "alice")] }, "1")
cases << run("a user id given as a digit string and no data", { users: [user_row(1, email: nil)] }, "1")
cases << run("a user id given as a float and a username", { users: [user_row(1, username: "alice")] }, 1.0)
cases << run("a user id given as a word", { users: [user_row(1, username: "alice")] }, "abc")

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
