# frozen_string_literal: true

require "spec_helper"

# GET /purchases/search, the customers search box, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/purchases-search.replay.test.ts, which sends the last request of each example and rebuilds the purchases index.
# An example named "hands a ..." is one Node leaves to Rails whole.
describe "Purchases search", type: :request, elasticsearch_wait_for_refresh: true do
  include Parity::AudienceSignedIn

  let(:json_headers) { { "Accept" => "application/json" } }
  let(:seller) { create(:user, name: "Search Seller", created_at: 120.days.ago) }
  let(:product) { create(:product, user: seller, name: "Searchable") }

  before do
    host! DOMAIN
    Purchase.__elasticsearch__.create_index!(force: true)
  end

  def sell(email:, **attributes)
    # The purchase factory charges a card through Stripe; the search only reads the row.
    build(:purchase, link: product, seller:, purchase_state: "successful", email:, **attributes).tap { |row| row.save!(validate: false) }
  end

  def search(params = {})
    index_model_records(Purchase)
    log_in(seller)
    get "/purchases/search", params:, headers: json_headers
  end

  it "answers an empty list to a seller with no sales", parity: true do
    search(query: "ada")

    expect(response.parsed_body).to eq([])
  end

  it "answers an empty list when no purchase matches the query", parity: true do
    sell(email: "ada@example.com", full_name: "Ada Lovelace")

    search(query: "nobody@example.com")

    expect(response.parsed_body).to eq([])
  end

  it "answers an empty list to a query of only spaces on a seller with no sales", parity: true do
    search(query: "   ")

    expect(response.parsed_body).to eq([])
  end

  it "answers an empty list for a quoted name no buyer has", parity: true do
    sell(email: "ada@example.com", full_name: "Ada Lovelace")

    search(query: "\"Grace Hopper\"")

    expect(response.parsed_body).to eq([])
  end

  it "answers an empty list for a license key no purchase has", parity: true do
    sell(email: "ada@example.com")

    search(query: "0a1b2c3d-0a1b2c3d-0a1b2c3d-0a1b2c3d")

    expect(response.parsed_body).to eq([])
  end

  it "answers an empty list for a page past the last legal window", parity: true do
    sell(email: "ada@example.com")

    search(query: "ada", page: "9999")

    expect(response.parsed_body).to eq([])
  end

  it "answers an empty list for a page that is not a number", parity: true do
    search(query: "ada", page: "abc")

    expect(response.parsed_body).to eq([])
  end

  it "answers an empty list for a second page of a single match", parity: true do
    sell(email: "ada@example.com")

    search(query: "ada@example.com", page: "2")

    expect(response.parsed_body).to eq([])
  end

  it "answers an empty list when only another seller's purchase matches", parity: true do
    other = create(:product, user: create(:user), name: "Elsewhere")
    build(:purchase, link: other, seller: other.user, purchase_state: "successful", email: "ada@example.com").save!(validate: false)

    search(query: "ada@example.com")

    expect(response.parsed_body).to eq([])
  end

  it "answers an empty list when the only match is a failed purchase", parity: true do
    sell(email: "ada@example.com", purchase_state: "failed")

    search(query: "ada@example.com")

    expect(response.parsed_body).to eq([])
  end

  it "answers an empty list for imported customers whose email does not match", parity: true do
    create(:imported_customer, importing_user: seller, email: "grace@example.com", link: product)

    search(query: "ada")

    expect(response.parsed_body).to eq([])
  end

  it "answers an empty list when the only matching imported customer is deleted", parity: true do
    create(:imported_customer, importing_user: seller, email: "ada@example.com", link: product, deleted_at: 1.day.ago)

    search(query: "ada")

    expect(response.parsed_body).to eq([])
  end

  it "answers an empty list to a team member with the accountant role", parity: true do
    member = create(:user, name: "Accountant Member")
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_ACCOUNTANT)
    index_model_records(Purchase)
    log_in(member)
    switch_to(membership)

    get "/purchases/search", params: { query: "ada" }, headers: json_headers

    expect(response.parsed_body).to eq([])
  end

  it "hands a search that matches a purchase to Rails", parity: true do
    sell(email: "ada@example.com", full_name: "Ada Lovelace")

    search(query: "ada@example.com")

    expect(response.parsed_body.size).to eq(1)
  end

  it "hands a search with no query on a seller with sales to Rails", parity: true do
    sell(email: "ada@example.com")

    search

    expect(response.parsed_body.size).to eq(1)
  end

  it "hands a search that matches an imported customer to Rails", parity: true do
    create(:imported_customer, importing_user: seller, email: "ada@example.com", link: product)

    search(query: "ada")

    expect(response.parsed_body.size).to eq(1)
  end

  it "hands a query that is not text to Rails", parity: true do
    index_model_records(Purchase)
    log_in(seller)

    get "/purchases/search?query[]=ada", headers: json_headers

    expect(response).to be_successful
  end

  it "hands a request that does not ask for JSON to Rails", parity: true do
    index_model_records(Purchase)
    log_in(seller)

    get "/purchases/search", params: { query: "ada" }

    expect(response).to be_successful
  end
end
