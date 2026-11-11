# frozen_string_literal: true

require "spec_helper"

# The subscribers report the audience page requests (POST /audience/export), recorded for the Next.js port (PARITY_RECORD=1)
# and replayed by nextjs/parity/__tests__/audience-mutations.replay.test.ts. Examples named `hands a ...` are the requests the
# port leaves to Rails whole.
describe "Audience export when signed in", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Export Seller") }
  let(:headers) { { "Accept" => "application/json", "Content-Type" => "application/json" } }

  before { host! DOMAIN }

  def export(body)
    token = csrf_token
    post "/audience/export", params: body.to_json, headers: headers.merge("X-CSRF-Token" => token)
  end

  it "queues the report for the chosen audiences", parity: true do
    log_in(seller)

    export(options: { followers: true, customers: true, affiliates: false })

    expect(response).to have_http_status(:ok)
    expect(Exports::AudienceExportWorker.jobs.size).to eq(1)
  end

  it "queues the report for a single audience", parity: true do
    log_in(seller)

    export(options: { affiliates: true })

    expect(Exports::AudienceExportWorker.jobs.last["args"]).to eq([seller.id, seller.id, { "affiliates" => true }])
  end

  it "sends the report to the seller when a team member asks for it", parity: true do
    member = create(:user, name: "Marketing Member")
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_MARKETING)
    log_in(member)
    switch_to(membership)

    export(options: { followers: true })

    expect(Exports::AudienceExportWorker.jobs.last["args"].first(2)).to eq([seller.id, seller.id])
  end

  it "keeps only the permitted audiences and scalar values", parity: true do
    log_in(seller)

    export(options: { customers: true, followers: "false", affiliates: nil, admin: true, nested: { followers: true } })

    expect(Exports::AudienceExportWorker.jobs.last["args"].last).to eq({ "followers" => "false", "customers" => true, "affiliates" => nil })
  end

  it "queues an empty selection, which the worker rejects", parity: true do
    log_in(seller)

    export(options: { followers: false, customers: false, affiliates: false })

    expect(response).to have_http_status(:ok)
  end

  it "hands a request without options to Rails", parity: true do
    log_in(seller)

    export({})

    expect(response).to have_http_status(:bad_request)
  end
end
