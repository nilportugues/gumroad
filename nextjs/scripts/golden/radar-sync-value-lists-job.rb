# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/radar-sync-value-lists-job.golden.json: Radar::SyncValueListsJob run by the real app
# against a scratch database as a Sidekiq job (support/sidekiq_executor.rb), with Stripe answered by the local capture server from each
# case's script. A case that names `during_stripe` changes the table right after the first item call, as a concurrent unblock would.
# Run it like radar-value-list-jobs.rb.
require_relative "support/rails_cases"
require_relative "../../src/server/stripe/__fixtures__/capture_server"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/radar-sync-value-lists-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[platform_blocks].freeze

SERVER = CaptureServer.new
Stripe.api_base = "http://127.0.0.1:#{SERVER.port}"
Stripe.api_key = "sk_test_golden"
Stripe.max_network_retries = 0
Rails.logger = ActiveSupport::Logger.new(nil)

# Lets a case change the table between the job's SELECT and its next reload, as a concurrent writer would.
$after_item_call = nil
Stripe::Radar::ValueListItem.singleton_class.prepend(Module.new do
  def create(*) = super.tap { fire_after_item_call }
  def delete(*) = super.tap { fire_after_item_call }

  def fire_after_item_call
    callback, $after_item_call = $after_item_call, nil
    callback&.call
  end
end)

def hours_ago(hours) = (NOW - hours * 3600).strftime("%Y-%m-%d %H:%M:%S")

def block_row(id, type: "email", value: "buyer#{id}@example.com", blocked_at: hours_ago(1), expires_at: nil, updated_at: hours_ago(1)) = { id:, object_type: type, object_value: value, blocked_at:, expires_at:, created_at: SEEDED_AT, updated_at: }

def card_row(id, **overrides) = block_row(id, type: "charge_processor_fingerprint", value: "Fp#{id}abc", **overrides)

def ok(body) = [200, { "Content-Type" => "application/json", "Request-Id" => "req_ok" }, body.to_json]

def failure(status, code, message, type: "invalid_request_error") = [status, { "Content-Type" => "application/json", "Request-Id" => "req_err" }, { error: { type:, code:, message:, param: "value" } }.to_json]

def list(*items) = ok({ object: "list", data: items, has_more: false, url: "/v1/radar/value_lists" })

def value_list(id = "rsl_1", alias_name = "gumroad_blocked_emails") = { id:, object: "radar.value_list", alias: alias_name, item_type: "email" }

def item(id) = { id:, object: "radar.value_list_item", value: "buyer@example.com" }

def run(name, seed, stripe: [], enabled: true, during_stripe: nil)
  SERVER.requests.clear
  SERVER.responses = stripe.dup
  enabled ? ENV["ENABLE_RADAR_VALUE_LIST_SYNC"] = "1" : ENV.delete("ENABLE_RADAR_VALUE_LIST_SYNC")
  $after_item_call = during_stripe
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "Radar::SyncValueListsJob", args: [], enabled:) do
    Radar::SyncValueListsJob.new.perform
  end
  $after_item_call = nil
  result.delete("seed")
  result.merge("stripe" => { "responses" => stripe, "requests" => SERVER.requests.map { _1.slice("method", "path", "query", "body") } })
end

LIST_E = list(value_list)
LIST_C = list(value_list("rsl_2", "gumroad_blocked_cards"))
NO_LIST = list
EXISTS = failure(400, "value_list_item_already_exists", "A value list item already exists with that value.")
ALREADY_EXISTS_BY_MESSAGE = failure(400, "parameter_invalid", "Value list alias already exists")
DELETED = ok({ id: "rsli_1", deleted: true })
FOUND = list(item("rsli_1"))
MISSING = failure(404, "resource_missing", "No such value list")
CLEAR_SECOND = -> { PlatformBlock.where(id: 2).update_all(blocked_at: nil, updated_at: hours_ago(1)) }
DELETE_SECOND = -> { PlatformBlock.where(id: 2).delete_all }

cases = []
cases << run("sync switched off", { platform_blocks: [block_row(1)] }, enabled: false)
cases << run("nothing to sync", {}, stripe: [LIST_E, LIST_C])
cases << run("both lists are created when they do not exist", {}, stripe: [NO_LIST, ok(value_list), NO_LIST, ok(value_list("rsl_2", "gumroad_blocked_cards"))])
cases << run("a list created by someone else in between", {}, stripe: [NO_LIST, ALREADY_EXISTS_BY_MESSAGE, LIST_E, LIST_C])
cases << run("a list that cannot be found after the race", {}, stripe: [NO_LIST, ALREADY_EXISTS_BY_MESSAGE, NO_LIST])
cases << run("another list creation error is raised", {}, stripe: [NO_LIST, failure(400, "parameter_invalid", "Invalid alias")])
cases << run("a Stripe outage is raised", {}, stripe: [failure(500, nil, "Internal error", type: "api_error")])
cases << run("an email blocked an hour ago is added", { platform_blocks: [block_row(1)] }, stripe: [LIST_E, ok(item("rsli_1")), LIST_C])
cases << run("two emails blocked are added in id order", { platform_blocks: [block_row(1), block_row(2)] }, stripe: [LIST_E, ok(item("rsli_1")), ok(item("rsli_2")), LIST_C])
cases << run("an email cleared while the first was added is skipped", { platform_blocks: [block_row(1), block_row(2)] }, stripe: [LIST_E, ok(item("rsli_1")), FOUND, DELETED, LIST_C], during_stripe: CLEAR_SECOND)
cases << run("an email deleted while the first was added is skipped", { platform_blocks: [block_row(1), block_row(2)] }, stripe: [LIST_E, ok(item("rsli_1")), LIST_C], during_stripe: DELETE_SECOND)
cases << run("an email that is already listed by code", { platform_blocks: [block_row(1)] }, stripe: [LIST_E, EXISTS, LIST_C])
cases << run("an email that is already listed by message", { platform_blocks: [block_row(1)] }, stripe: [LIST_E, failure(400, "parameter_invalid", "That item already exists in the list"), LIST_C])
cases << run("another item error is raised", { platform_blocks: [block_row(1)] }, stripe: [LIST_E, failure(400, "parameter_invalid", "Invalid value")])
cases << run("an email blocked 26 hours ago is left alone", { platform_blocks: [block_row(1, blocked_at: hours_ago(26))] }, stripe: [LIST_E, LIST_C])
cases << run("blocks at the edge of the 25 hour window", { platform_blocks: [block_row(1, blocked_at: "2026-11-03 11:30:45"), block_row(2, blocked_at: "2026-11-03 11:30:46")] }, stripe: [LIST_E, ok(item("rsli_2")), LIST_C])
cases << run("an email block that expires later is added", { platform_blocks: [block_row(1, expires_at: "2027-06-01 00:00:00")] }, stripe: [LIST_E, ok(item("rsli_1")), LIST_C])
cases << run("an email block that expired an hour ago is taken out", { platform_blocks: [block_row(1, blocked_at: hours_ago(48), expires_at: hours_ago(1), updated_at: hours_ago(48))] }, stripe: [LIST_E, FOUND, DELETED, LIST_C])
cases << run("an email block that expired 26 hours ago is left alone", { platform_blocks: [block_row(1, blocked_at: hours_ago(48), expires_at: hours_ago(26), updated_at: hours_ago(48))] }, stripe: [LIST_E, LIST_C])
cases << run("an expiry in the future is not yet taken out", { platform_blocks: [block_row(1, blocked_at: hours_ago(48), expires_at: "2027-06-01 00:00:00", updated_at: hours_ago(48))] }, stripe: [LIST_E, LIST_C])
cases << run("an email unblocked an hour ago is taken out", { platform_blocks: [block_row(1, blocked_at: nil)] }, stripe: [LIST_E, FOUND, DELETED, LIST_C])
cases << run("an email unblocked 26 hours ago is left alone", { platform_blocks: [block_row(1, blocked_at: nil, updated_at: hours_ago(26))] }, stripe: [LIST_E, LIST_C])
cases << run("an unblocked email that is not in the list", { platform_blocks: [block_row(1, blocked_at: nil)] }, stripe: [LIST_E, list, LIST_C])
cases << run("an unblocked email listed twice", { platform_blocks: [block_row(1, blocked_at: nil)] }, stripe: [LIST_E, list(item("rsli_1"), item("rsli_2")), DELETED, ok({ id: "rsli_2", deleted: true }), LIST_C])
cases << run("an unblocked email whose list Stripe cannot find", { platform_blocks: [block_row(1, blocked_at: nil)] }, stripe: [LIST_E, MISSING, LIST_C])
cases << run("another removal error is raised", { platform_blocks: [block_row(1, blocked_at: nil)] }, stripe: [LIST_E, failure(400, "parameter_invalid", "Bad request")])
cases << run("a removal whose delete fails", { platform_blocks: [block_row(1, blocked_at: nil)] }, stripe: [LIST_E, FOUND, failure(400, "parameter_invalid", "Cannot delete")])
cases << run("an add, an unblock and an expiry together", { platform_blocks: [block_row(1), block_row(2, blocked_at: nil), block_row(3, blocked_at: hours_ago(48), expires_at: hours_ago(2), updated_at: hours_ago(48))] }, stripe: [LIST_E, ok(item("rsli_1")), FOUND, DELETED, list(item("rsli_3")), ok({ id: "rsli_3", deleted: true }), LIST_C])
cases << run("types Radar does not enforce are ignored", { platform_blocks: [block_row(1, type: "ip_address", value: "203.0.113.5"), block_row(2, type: "email_domain", value: "example.org"), block_row(3, type: "browser_guid", value: "guid")] }, stripe: [LIST_E, LIST_C])
cases << run("a card fingerprint blocked an hour ago is added", { platform_blocks: [card_row(1)] }, stripe: [LIST_E, LIST_C, ok(item("rsli_1"))])
cases << run("two card fingerprints are added", { platform_blocks: [card_row(1), card_row(2)] }, stripe: [LIST_E, LIST_C, ok(item("rsli_1")), ok(item("rsli_2"))])
cases << run("a card cleared while the first was added is skipped", { platform_blocks: [card_row(1), card_row(2)] }, stripe: [LIST_E, LIST_C, ok(item("rsli_1")), FOUND, DELETED], during_stripe: CLEAR_SECOND)
cases << run("a card whose fingerprint is not alphanumeric is ignored in every step", { platform_blocks: [card_row(1, value: "fp-bad!"), card_row(2, value: "fp-bad2", blocked_at: nil), card_row(3, value: "fp-bad3", blocked_at: hours_ago(48), expires_at: hours_ago(1), updated_at: hours_ago(48))] }, stripe: [LIST_E, LIST_C])
cases << run("a fingerprint with an underscore is ignored", { platform_blocks: [card_row(1, value: "Fp_1abc")] }, stripe: [LIST_E, LIST_C])
cases << run("a card unblocked an hour ago is taken out", { platform_blocks: [card_row(1, blocked_at: nil)] }, stripe: [LIST_E, LIST_C, list(item("rsli_1")), DELETED])
cases << run("a card block that expired an hour ago is taken out", { platform_blocks: [card_row(1, blocked_at: hours_ago(48), expires_at: hours_ago(1), updated_at: hours_ago(48))] }, stripe: [LIST_E, LIST_C, FOUND, DELETED])
cases << run("a card block older than the window is left alone", { platform_blocks: [card_row(1, blocked_at: hours_ago(30), updated_at: hours_ago(30))] }, stripe: [LIST_E, LIST_C])
cases << run("the card list is created when it does not exist", { platform_blocks: [card_row(1)] }, stripe: [LIST_E, NO_LIST, ok(value_list("rsl_2", "gumroad_blocked_cards")), ok(item("rsli_1"))])
cases << run("a card already listed", { platform_blocks: [card_row(1)] }, stripe: [LIST_E, LIST_C, EXISTS])
cases << run("emails and cards together", { platform_blocks: [block_row(1), card_row(2), block_row(3, blocked_at: nil), card_row(4, blocked_at: nil)] }, stripe: [LIST_E, ok(item("rsli_1")), FOUND, DELETED, LIST_C, ok(item("rsli_2")), list(item("rsli_4")), ok({ id: "rsli_4", deleted: true })])
cases << run("an email error stops before the cards", { platform_blocks: [block_row(1), card_row(2)] }, stripe: [LIST_E, failure(400, "parameter_invalid", "Invalid value")])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
