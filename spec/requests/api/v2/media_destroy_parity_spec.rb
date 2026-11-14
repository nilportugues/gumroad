# frozen_string_literal: true

require "spec_helper"

# Api::V2::MediaController#destroy, recorded for the Next.js port (nextjs/parity/__tests__/api-v2-ws17c.replay.test.ts). Node answers the
# scope checks and the lookup; deleting a hosted file purges its blob, so an example named "hands a ... back to Rails" records that.
# #create is throttled by Rack::Attack and stays in Rails.
describe "API v2 media delete", type: :request do
  include Parity::ApiV2Requests

  let(:seller) { create(:user) }
  let(:token) { api_token(seller, scopes: "edit_profile") }
  let!(:file) { create(:public_file, :with_audio, resource: seller, seller:, display_name: "Theme") }

  describe "DELETE /v2/media/:id" do
    it "refuses a token without the edit_profile scope", parity: true do
      api_call(:delete, "/media/#{file.public_id}", token: api_token(seller, scopes: "view_profile"))

      expect(response).to have_http_status(:forbidden)
    end

    it "says the media was not found", parity: true do
      api_call(:delete, "/media/missing", token:)

      expect(response.parsed_body["message"]).to eq("The media was not found.")
    end

    it "does not find the file of another seller", parity: true do
      other = create(:user)
      theirs = create(:public_file, :with_audio, resource: other, seller: other)

      api_call(:delete, "/media/#{theirs.public_id}", token:, api_host: false)

      expect(response.parsed_body["message"]).to eq("The media was not found.")
    end

    it "does not find a file that belongs to a product", parity: true do
      product = create(:product, user: seller)
      attached = create(:public_file, :with_audio, resource: product, seller:)

      api_call(:delete, "/media/#{attached.public_id}", token:)

      expect(response.parsed_body["message"]).to eq("The media was not found.")
    end

    it "does not find a file that is already deleted", parity: true do
      file.update_columns(deleted_at: 1.day.ago)

      api_call(:delete, "/media/#{file.public_id}", token:)

      expect(response.parsed_body["message"]).to eq("The media was not found.")
    end

    it "hands a delete of a hosted file back to Rails", parity: true do
      api_call(:delete, "/media/#{file.public_id}", token:)

      expect(response.parsed_body).to include("success" => true, "message" => "The file was deleted.")
      expect(file.reload.deleted_at).to be_present
    end
  end
end
