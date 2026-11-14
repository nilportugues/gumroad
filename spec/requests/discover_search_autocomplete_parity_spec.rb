# frozen_string_literal: true

require "spec_helper"

# DELETE /discover_search_autocomplete (Discover::SearchAutocompleteController#delete_search_suggestion), recorded for the Next.js port
# (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/discover-search-suggestions.replay.test.ts, which sends the last request
# of each example. An example named "hands a ..." is one Node leaves to Rails whole.
describe "Discover search suggestions", type: :request do
  include Parity::AudienceSignedIn

  let(:guid) { "parity-browser-guid" }
  let(:user) { create(:user, name: "Searching Buyer") }
  let(:json_headers) { { "Accept" => "application/json", "Content-Type" => "application/json" } }

  before { host! VALID_DISCOVER_REQUEST_HOST }

  def suggest(query, **owner)
    create(:discover_search_suggestion, discover_search: create(:discover_search, query:, **owner))
  end

  def forget(body, headers: json_headers, token: csrf_token)
    delete "/discover_search_autocomplete", params: body.to_json, headers: token ? headers.merge("X-CSRF-Token" => token) : headers
  end

  it "removes the signed-in buyer's suggestion for the query", parity: true do
    log_in(user)
    mine = suggest("blender rigs", user:)
    other_query = suggest("blender textures", user:)
    other_buyer = suggest("blender rigs", user: create(:user))

    forget({ query: "blender rigs" })

    expect(response).to have_http_status(:no_content)
    expect(mine.reload).to be_deleted
    expect(other_query.reload).not_to be_deleted
    expect(other_buyer.reload).not_to be_deleted
  end

  it "removes every suggestion of the buyer that has the query", parity: true do
    log_in(user)
    first = suggest("film packs", user:)
    second = suggest("film packs", user:)

    forget({ query: "film packs" })

    expect(first.reload).to be_deleted
    expect(second.reload).to be_deleted
  end

  it "matches the query regardless of case", parity: true do
    log_in(user)
    suggestion = suggest("Blender Rigs", user:)

    forget({ query: "blender rigs" })

    expect(suggestion.reload).to be_deleted
  end

  it "removes a visitor's suggestion by the guid cookie and leaves the buyers' suggestions", parity: true do
    cookies["_gumroad_guid"] = guid
    mine = suggest("sound packs", browser_guid: guid)
    other_guid = suggest("sound packs", browser_guid: "someone-else")
    buyers = suggest("sound packs", browser_guid: guid, user:)

    forget({ query: "sound packs" })

    expect(response).to have_http_status(:no_content)
    expect(mine.reload).to be_deleted
    expect(other_guid.reload).not_to be_deleted
    expect(buyers.reload).not_to be_deleted
  end

  it "leaves the anonymous searches of a signed-in buyer's browser", parity: true do
    cookies["_gumroad_guid"] = guid
    log_in(user)
    anonymous = suggest("icon sets", browser_guid: guid)

    forget({ query: "icon sets" })

    expect(response).to have_http_status(:no_content)
    expect(anonymous.reload).not_to be_deleted
  end

  it "does nothing for a visitor without a guid cookie", parity: true do
    suggestion = suggest("font bundles", browser_guid: guid)

    forget({ query: "font bundles" })

    expect(response).to have_http_status(:no_content)
    expect(suggestion.reload).not_to be_deleted
  end

  it "keeps a suggestion that was already deleted as it was", parity: true do
    log_in(user)
    deleted_at = Time.utc(2025, 1, 2, 3, 4, 5)
    suggestion = suggest("old search", user:)
    suggestion.update_columns(deleted_at:)

    forget({ query: "old search" })

    expect(suggestion.reload.deleted_at).to eq(deleted_at)
  end

  it "answers 204 for a query nobody searched", parity: true do
    log_in(user)

    forget({ query: "nothing here" })

    expect(response).to have_http_status(:no_content)
  end

  it "removes the suggestions of a search without a query when none is sent", parity: true do
    log_in(user)
    blank = suggest(nil, user:)
    named = suggest("kept", user:)

    forget({})

    expect(response).to have_http_status(:no_content)
    expect(blank.reload).to be_deleted
    expect(named.reload).not_to be_deleted
  end

  it "reads the query from the query string", parity: true do
    log_in(user)
    suggestion = suggest("query string", user:)

    delete "/discover_search_autocomplete?query=query+string", headers: json_headers.merge("X-CSRF-Token" => csrf_token)

    expect(response).to have_http_status(:no_content)
    expect(suggestion.reload).to be_deleted
  end

  it "removes the suggestions of a query sent as a one-element list", parity: true do
    log_in(user)
    suggestion = suggest("listed", user:)

    forget({ query: ["listed"] })

    expect(response).to have_http_status(:no_content)
    expect(suggestion.reload).to be_deleted
  end

  it "removes the suggestions of every query in a list and keeps the others", parity: true do
    log_in(user)
    first = suggest("Listed One", user:)
    second = suggest("listed two", user:)
    kept = suggest("listed three", user:)

    forget({ query: ["listed one", "listed two"] })

    expect(response).to have_http_status(:no_content)
    expect(first.reload).to be_deleted
    expect(second.reload).to be_deleted
    expect(kept.reload).not_to be_deleted
  end

  it "removes nothing for an empty list of queries", parity: true do
    log_in(user)
    suggestion = suggest("listed", user:)

    forget({ query: [] })

    expect(response).to have_http_status(:no_content)
    expect(suggestion.reload).not_to be_deleted
  end

  describe "query shapes the form never sends" do
    {
      "an integer" => [42, "42"],
      "a whole-number float" => [42.0, "42.0"],
      "a fractional float" => [4.5, "4.5"],
      "true" => [true, "1"],
      "false" => [false, "0"]
    }.each do |label, (sent, stored)|
      it "reads a query sent as #{label} as its text", parity: true do
        log_in(user)
        suggestion = suggest(stored, user:)
        kept = suggest("kept", user:)

        forget({ query: sent })

        expect(response).to have_http_status(:no_content)
        expect(suggestion.reload).to be_deleted
        expect(kept.reload).not_to be_deleted
      end
    end

    it "reads a list of integers as a list of their text", parity: true do
      log_in(user)
      first = suggest("42", user:)
      second = suggest("7", user:)

      forget({ query: [42, 7] })

      expect(response).to have_http_status(:no_content)
      expect(first.reload).to be_deleted
      expect(second.reload).to be_deleted
    end

    it "hands a list of queries holding a null to Rails", parity: true do
      log_in(user)
      blank = suggest(nil, user:)
      named = suggest("listed", user:)

      forget({ query: [nil, "listed"] })

      expect(response).to have_http_status(:no_content)
      expect(named.reload).to be_deleted
      expect(blank.reload).not_to be_deleted
    end

    it "hands a list holding only a null to Rails", parity: true do
      log_in(user)
      blank = suggest(nil, user:)

      forget({ query: [nil] })

      expect(response).to have_http_status(:no_content)
      expect(blank.reload).not_to be_deleted
    end

    it "reads a list mixing numbers, booleans and text as a list of their text", parity: true do
      log_in(user)
      number = suggest("42", user:)
      boolean = suggest("1", user:)
      text = suggest("listed", user:)
      kept = suggest("kept", user:)

      forget({ query: [42, true, "listed"] })

      expect(response).to have_http_status(:no_content)
      expect(number.reload).to be_deleted
      expect(boolean.reload).to be_deleted
      expect(text.reload).to be_deleted
      expect(kept.reload).not_to be_deleted
    end
  end

  it "hands a request without a CSRF token to Rails", parity: true do
    log_in(user)
    suggestion = suggest("untokened", user:)

    forget({ query: "untokened" }, token: nil)

    expect(suggestion.reload).not_to be_deleted
  end
end
