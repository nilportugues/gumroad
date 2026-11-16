# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/radar-value-list-jobs.golden.json: Radar::AddValueListItemJob and
# Radar::RemoveValueListItemJob run by the real app against a scratch database as Sidekiq jobs (support/sidekiq_executor.rb), with
# Stripe answered by the local capture server from each case's script. A case that names `during_stripe` changes the block's row
# right after the first item call, as a concurrent unblock or block would. Run it like lift-platform-stripe-pause.rb.
require_relative "support/rails_cases"
require_relative "../../src/server/stripe/__fixtures__/capture_server"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/radar-value-list-jobs.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[platform_blocks].freeze
FINGERPRINT = "Hxj29skLpq0a1B"

SERVER = CaptureServer.new
Stripe.api_base = "http://127.0.0.1:#{SERVER.port}"
Stripe.api_key = "sk_test_golden"
Stripe.max_network_retries = 0
Rails.logger = ActiveSupport::Logger.new(nil)

# Lets a case change the row between the service's check and its last read, as a concurrent writer would.
$after_item_call = nil
Stripe::Radar::ValueListItem.singleton_class.prepend(Module.new do
  def create(*) = super.tap { $after_item_call&.call }
  def delete(*) = super.tap { $after_item_call&.call }
end)

def block_row(id = 1, type: "email", value: "buyer@example.com", blocked_at: SEEDED_AT, expires_at: nil) = { id:, object_type: type, object_value: value, blocked_at:, expires_at:, created_at: SEEDED_AT, updated_at: SEEDED_AT }

def ok(body) = [200, { "Content-Type" => "application/json", "Request-Id" => "req_ok" }, body.to_json]

def failure(status, code, message, type: "invalid_request_error") = [status, { "Content-Type" => "application/json", "Request-Id" => "req_err" }, { error: { type:, code:, message:, param: "value" } }.to_json]

def list(*items) = ok({ object: "list", data: items, has_more: false, url: "/v1/radar/value_lists" })

def value_list(id = "rsl_1", alias_name = "gumroad_blocked_emails") = { id:, object: "radar.value_list", alias: alias_name, item_type: "email" }

def item(id) = { id:, object: "radar.value_list_item", value: "buyer@example.com" }

def run(name, job, args, seed, stripe: [], enabled: true, during_stripe: nil)
  SERVER.requests.clear
  SERVER.responses = stripe.dup
  enabled ? ENV["ENABLE_RADAR_VALUE_LIST_SYNC"] = "1" : ENV.delete("ENABLE_RADAR_VALUE_LIST_SYNC")
  $after_item_call = during_stripe
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job:, args:, enabled:) do
    job.constantize.new.perform(*args)
  end
  $after_item_call = nil
  result.delete("seed")
  result.merge("stripe" => { "responses" => stripe, "requests" => SERVER.requests.map { _1.slice("method", "path", "query", "body") } })
end

CLEAR_BLOCK = -> { PlatformBlock.where(id: 1).update_all(blocked_at: nil) }
RESTORE_BLOCK = -> { PlatformBlock.where(id: 1).update_all(blocked_at: SEEDED_AT) }
EXISTS = failure(400, "value_list_item_already_exists", "A value list item already exists with that value.")
ALREADY_EXISTS_BY_MESSAGE = failure(400, "parameter_invalid", "Value list alias already exists")
LISTED = list(value_list)
NO_LIST = list
ONE = { platform_blocks: [block_row] }.freeze
ADD = "Radar::AddValueListItemJob"
REMOVE = "Radar::RemoveValueListItemJob"

cases = []

# Radar::AddValueListItemJob
cases << run("add: an unknown block", ADD, [99], {})
cases << run("add: sync switched off", ADD, [1], ONE, enabled: false)
cases << run("add: a block type Radar does not enforce", ADD, [1], { platform_blocks: [block_row(type: "ip_address", value: "203.0.113.5")] })
cases << run("add: a block that was cleared", ADD, [1], { platform_blocks: [block_row(blocked_at: nil)] })
cases << run("add: a fingerprint that is not alphanumeric", ADD, [1], { platform_blocks: [block_row(type: "charge_processor_fingerprint", value: "fp-bad!")] })
cases << run("add: an email into the existing list", ADD, [1], ONE, stripe: [LISTED, ok(item("rsli_1"))])
cases << run("add: a card fingerprint into the existing list", ADD, [1], { platform_blocks: [block_row(type: "charge_processor_fingerprint", value: FINGERPRINT)] }, stripe: [list(value_list("rsl_2", "gumroad_blocked_cards")), ok(item("rsli_2"))])
cases << run("add: the list is created when it does not exist", ADD, [1], ONE, stripe: [NO_LIST, ok(value_list), ok(item("rsli_1"))])
cases << run("add: a list created by someone else in between", ADD, [1], ONE, stripe: [NO_LIST, ALREADY_EXISTS_BY_MESSAGE, LISTED, ok(item("rsli_1"))])
cases << run("add: a list that cannot be found after the race", ADD, [1], ONE, stripe: [NO_LIST, ALREADY_EXISTS_BY_MESSAGE, NO_LIST])
cases << run("add: another list creation error is raised", ADD, [1], ONE, stripe: [NO_LIST, failure(400, "parameter_invalid", "Invalid alias")])
cases << run("add: an item that already exists by code", ADD, [1], ONE, stripe: [LISTED, EXISTS])
cases << run("add: an item that already exists by message", ADD, [1], ONE, stripe: [LISTED, failure(400, "parameter_invalid", "That item already exists in the list")])
cases << run("add: another item error is raised", ADD, [1], ONE, stripe: [LISTED, failure(400, "parameter_invalid", "Invalid value")])
cases << run("add: a Stripe outage is raised", ADD, [1], ONE, stripe: [failure(500, nil, "Internal error", type: "api_error")])
cases << run("add: a block cleared while the item was added is taken back out", ADD, [1], ONE, stripe: [LISTED, ok(item("rsli_1")), list(item("rsli_1")), ok({ id: "rsli_1", deleted: true })], during_stripe: CLEAR_BLOCK)
cases << run("add: a cleared block whose item is already gone", ADD, [1], ONE, stripe: [LISTED, ok(item("rsli_1")), list], during_stripe: CLEAR_BLOCK)
cases << run("add: a cleared block that Stripe no longer knows", ADD, [1], ONE, stripe: [LISTED, ok(item("rsli_1")), failure(404, "resource_missing", "No such value list")], during_stripe: CLEAR_BLOCK)
cases << run("add: a cleared block whose delete fails", ADD, [1], ONE, stripe: [LISTED, ok(item("rsli_1")), list(item("rsli_1")), failure(400, "parameter_invalid", "Cannot delete")], during_stripe: CLEAR_BLOCK)
cases << run("add: a block that expired is not enforced", ADD, [1], { platform_blocks: [block_row(expires_at: "2026-06-01 00:00:00")] }, stripe: [LISTED, ok(item("rsli_1")), list(item("rsli_1")), ok({ id: "rsli_1", deleted: true })])
cases << run("add: a block that expires later stays", ADD, [1], { platform_blocks: [block_row(expires_at: "2027-06-01 00:00:00")] }, stripe: [LISTED, ok(item("rsli_1"))])
cases << run("add: the id given as a string", ADD, ["1"], ONE, stripe: [LISTED, ok(item("rsli_1"))])

# Radar::RemoveValueListItemJob
cases << run("remove: an unknown block", REMOVE, [99], {})
cases << run("remove: sync switched off", REMOVE, [1], { platform_blocks: [block_row(blocked_at: nil)] }, enabled: false)
cases << run("remove: a block type Radar does not enforce", REMOVE, [1], { platform_blocks: [block_row(type: "email_domain", value: "example.org", blocked_at: nil)] })
cases << run("remove: a block that is active again", REMOVE, [1], ONE)
cases << run("remove: a fingerprint that is not alphanumeric", REMOVE, [1], { platform_blocks: [block_row(type: "charge_processor_fingerprint", value: "fp-bad!", blocked_at: nil)] })
cases << run("remove: an email taken out of the list", REMOVE, [1], { platform_blocks: [block_row(blocked_at: nil)] }, stripe: [LISTED, list(item("rsli_1")), ok({ id: "rsli_1", deleted: true })])
cases << run("remove: an item listed twice is deleted twice", REMOVE, [1], { platform_blocks: [block_row(blocked_at: nil)] }, stripe: [LISTED, list(item("rsli_1"), item("rsli_2")), ok({ id: "rsli_1", deleted: true }), ok({ id: "rsli_2", deleted: true })])
cases << run("remove: a value that is not in the list", REMOVE, [1], { platform_blocks: [block_row(blocked_at: nil)] }, stripe: [LISTED, list])
cases << run("remove: a card fingerprint taken out of the list", REMOVE, [1], { platform_blocks: [block_row(type: "charge_processor_fingerprint", value: FINGERPRINT, blocked_at: nil)] }, stripe: [list(value_list("rsl_2", "gumroad_blocked_cards")), list(item("rsli_3")), ok({ id: "rsli_3", deleted: true })])
cases << run("remove: the list is created when it does not exist", REMOVE, [1], { platform_blocks: [block_row(blocked_at: nil)] }, stripe: [NO_LIST, ok(value_list), list])
cases << run("remove: a list the item call cannot find", REMOVE, [1], { platform_blocks: [block_row(blocked_at: nil)] }, stripe: [LISTED, failure(404, "resource_missing", "No such value list")])
cases << run("remove: another listing error is raised", REMOVE, [1], { platform_blocks: [block_row(blocked_at: nil)] }, stripe: [LISTED, failure(400, "parameter_invalid", "Bad request")])
cases << run("remove: a block added back while the item was removed is put back", REMOVE, [1], { platform_blocks: [block_row(blocked_at: nil)] }, stripe: [LISTED, list(item("rsli_1")), ok({ id: "rsli_1", deleted: true }), ok(item("rsli_1"))], during_stripe: RESTORE_BLOCK)
cases << run("remove: a re-added item that already exists", REMOVE, [1], { platform_blocks: [block_row(blocked_at: nil)] }, stripe: [LISTED, list(item("rsli_1")), ok({ id: "rsli_1", deleted: true }), EXISTS], during_stripe: RESTORE_BLOCK)
cases << run("remove: a re-add that fails", REMOVE, [1], { platform_blocks: [block_row(blocked_at: nil)] }, stripe: [LISTED, list(item("rsli_1")), ok({ id: "rsli_1", deleted: true }), failure(400, "parameter_invalid", "Invalid value")], during_stripe: RESTORE_BLOCK)
cases << run("remove: the id given as a string", REMOVE, ["1"], { platform_blocks: [block_row(blocked_at: nil)] }, stripe: [LISTED, list])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
