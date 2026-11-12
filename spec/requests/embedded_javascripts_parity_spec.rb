# frozen_string_literal: true

require "spec_helper"

# EmbeddedJavascriptsController#overlay and #embed (the loader scripts of /js/gumroad*), recorded for the Next.js port (PARITY_RECORD=1) and
# replayed by nextjs/parity/__tests__/embedded-javascripts.replay.test.ts. A script tag asks for `*/*`; for an HTML request the template is
# missing and Rails raises, so there is no response to copy. #analytics is recorded in public_files_parity_spec.rb.
describe "Embedded javascripts", type: :request do
  let(:script_headers) { { "Accept" => "*/*" } }

  before { host! DOMAIN }

  %w[gumroad gumroad-overlay gumroad-multioverlay].each do |name|
    it "serves the overlay loader at /js/#{name}", parity: true do
      get "/js/#{name}", headers: script_headers

      expect(response).to be_successful
      expect(response.body).to include("/js/gumroad-bundle.js")
      expect(response.body).to include("stylesUrl")
    end
  end

  it "serves the embed loader at /js/gumroad-embed", parity: true do
    get "/js/gumroad-embed", headers: script_headers

    expect(response).to be_successful
    expect(response.body).to include("/js/gumroad-embed-bundle.js")
    expect(response.body).not_to include("stylesUrl")
  end

  it "serves the loader to a visitor who already has a guid", parity: true do
    get "/js/gumroad", headers: script_headers.merge("Cookie" => "_gumroad_guid=abc123")

    expect(response).to be_successful
    expect(response.headers["Set-Cookie"].to_s).not_to include("_gumroad_guid")
  end

  it "serves the loader whatever the query string says", parity: true do
    get "/js/gumroad-embed", params: { utm_source: "newsletter", ref: "footer" }, headers: script_headers

    expect(response).to be_successful
  end
end
