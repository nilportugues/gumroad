# frozen_string_literal: true

require "spec_helper"

# Products::PublishSchedulesController, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/publish-schedules.replay.test.ts, which sends the last request of each example. An example named
# "hands a ..." records what Node passes to Rails whole: a shape whose answer Node cannot prove.
#
# `parity_hours_ahead` and `parity_zone` are read by the replay only (it rewrites `local_time` to the same distance from its own
# clock); Rails ignores them.
describe "Product publish schedules", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:named_seller, name: "Schedule Seller") }
  let!(:product) { create(:product, user: seller, name: "Draft product", unique_permalink: "draftprod", draft: true) }
  let(:json_headers) { { "Accept" => "application/json", "Content-Type" => "application/json" } }
  let(:path) { "/links/#{product.unique_permalink}/publish_schedule" }

  before do
    host! DOMAIN
    Feature.activate_user(:scheduled_product_publishing, seller)
  end

  def send_json(method, target, body = {})
    public_send(method, target, params: body.to_json, headers: json_headers.merge("X-CSRF-Token" => csrf_token))
  end

  def local(hours, zone: seller.timezone_id)
    (Time.current + hours.hours).in_time_zone(zone).strftime("%Y-%m-%dT%H:%M")
  end

  def schedule(hours: 3, zone: seller.timezone_id)
    send_json(:post, path, local_time: local(hours, zone:), parity_hours_ahead: hours, parity_zone: zone)
  end

  def set_flag(name)
    product.public_send(:"#{name}=", true)
    product.update_columns(flags: product.flags)
  end

  def as_team_member(role)
    member = create(:user, name: "#{role.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  describe "POST /links/:link_id/publish_schedule" do
    it "schedules a never-published draft in the seller's time zone", parity: true do
      log_in(seller)

      schedule

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["publish_schedule"]).to include("status" => "scheduled", "failure_message" => nil)
      expect(product.reload.publish_schedule.scheduled_by).to eq(seller)
    end

    it "schedules for a seller in Eastern Time", parity: true do
      seller.update!(timezone: "Eastern Time (US & Canada)")
      log_in(seller)

      schedule(zone: "America/New_York")

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["publish_schedule"]["label"]).to match(/E[SD]T\z/)
    end

    it "schedules for a seller in UTC", parity: true do
      seller.update!(timezone: "UTC")
      log_in(seller)

      schedule(zone: "Etc/UTC")

      expect(response.parsed_body["publish_schedule"]["label"]).to end_with("UTC")
    end

    it "schedules a draft that was scheduled by a marketing team member", parity: true do
      as_team_member(TeamMembership::ROLE_MARKETING)

      schedule

      expect(response).to have_http_status(:ok)
    end

    it "replaces a failed schedule with a new one", parity: true do
      log_in(seller)
      create(:product_publish_schedule, product:, status: "failed", failure_message: "We couldn't publish your product at the scheduled time.")

      schedule

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["publish_schedule"]["status"]).to eq("scheduled")
      expect(ProductPublishSchedule.where(product_id: product.id).count).to eq(1)
    end

    it "refuses when scheduled publishing is not on for the seller", parity: true do
      Feature.deactivate_user(:scheduled_product_publishing, seller)
      log_in(seller)

      schedule

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body).to eq("success" => false, "error_message" => "Scheduled publishing isn't available for your account yet.")
    end

    it "refuses a time less than five minutes away", parity: true do
      log_in(seller)

      send_json(:post, path, local_time: local(0), parity_hours_ahead: 0, parity_zone: seller.timezone_id)

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["error_message"]).to eq("Choose a time at least 5 minutes from now.")
    end

    it "refuses a time in the past", parity: true do
      log_in(seller)

      send_json(:post, path, local_time: local(-30), parity_hours_ahead: -30, parity_zone: seller.timezone_id)

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["error_message"]).to eq("Choose a time at least 5 minutes from now.")
    end

    it "refuses a request without a time", parity: true do
      log_in(seller)

      send_json(:post, path)

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["error_message"]).to eq("Enter a valid date and time.")
    end

    it "refuses a date that does not exist", parity: true do
      log_in(seller)

      send_json(:post, path, local_time: "2031-02-30T09:30")

      expect(response.parsed_body["error_message"]).to eq("Enter a valid date and time.")
    end

    it "refuses an hour of 24 or more", parity: true do
      log_in(seller)

      send_json(:post, path, local_time: "2031-06-15T24:30")

      expect(response.parsed_body["error_message"]).to eq("Enter a valid date and time.")
    end

    it "refuses a wall-clock time that clocks skip forward over", parity: true do
      log_in(seller)

      send_json(:post, path, local_time: "2031-03-09T02:30")

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["error_message"]).to eq("That time doesn't exist in America/Los_Angeles because clocks skip forward. Choose a different time.")
    end

    it "refuses a wall-clock time that happens twice when clocks go back", parity: true do
      log_in(seller)

      send_json(:post, path, local_time: "2031-11-02T01:30")

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["error_message"]).to eq("That time happens twice in America/Los_Angeles because clocks go back. Choose a different time.")
    end

    it "hands a time that is not in the form the editor sends to Rails", parity: true do
      log_in(seller)

      send_json(:post, path, local_time: "tomorrow at noon")

      expect(response).to have_http_status(:unprocessable_entity)
    end

    it "hands a time that is not a string to Rails", parity: true do
      log_in(seller)

      send_json(:post, path, local_time: 12_345)

      expect(response).to have_http_status(:unprocessable_entity)
    end

    it "refuses a second schedule while one is pending", parity: true do
      log_in(seller)
      create(:product_publish_schedule, product:)

      schedule

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["error_message"]).to eq("This product already has a schedule. Cancel it first.")
    end

    it "refuses a second schedule while the job is publishing one", parity: true do
      log_in(seller)
      create(:product_publish_schedule, product:, status: "publishing", claimed_at: Time.current)

      schedule

      expect(response.parsed_body["error_message"]).to eq("This product already has a schedule. Cancel it first.")
    end

    it "refuses a product that is already published", parity: true do
      product.update!(draft: false)
      log_in(seller)

      schedule

      expect(response.parsed_body["error_message"]).to eq("Only products that have never been published can be scheduled.")
    end

    it "refuses a draft that was published before", parity: true do
      product.update_columns(first_published_at: 2.days.ago)
      log_in(seller)

      schedule

      expect(response.parsed_body["error_message"]).to eq("Only products that have never been published can be scheduled.")
    end

    it "refuses an archived draft", parity: true do
      set_flag(:archived)
      log_in(seller)

      schedule

      expect(response.parsed_body["error_message"]).to eq("This product can't be scheduled.")
    end

    it "refuses a banned draft", parity: true do
      product.update_columns(banned_at: Time.current)
      log_in(seller)

      schedule

      expect(response.parsed_body["error_message"]).to eq("This product can't be scheduled.")
    end

    it "refuses a pre-order", parity: true do
      set_flag(:is_in_preorder_state)
      log_in(seller)

      schedule

      expect(response.parsed_body["error_message"]).to eq("Pre-orders can't be scheduled.")
    end

    it "refuses a draft the admins unpublished", parity: true do
      set_flag(:is_unpublished_by_admin)
      log_in(seller)

      schedule

      expect(response.parsed_body["error_message"]).to eq(Link::UNPUBLISHED_BY_ADMIN_MESSAGE)
    end

    it "refuses a draft with an active sales hold", parity: true do
      create(:product_sales_hold, product:)
      log_in(seller)

      schedule

      expect(response.parsed_body["error_message"]).to eq(Link::UNPUBLISHED_BY_ADMIN_MESSAGE)
    end

    it "refuses a seller who has not confirmed their email", parity: true do
      seller.update_columns(confirmed_at: nil)
      log_in(seller)

      schedule

      expect(response.parsed_body["error_message"]).to eq("You have to confirm your email address before you can do that.")
    end

    it "hands a physical product to Rails", parity: true do
      set_flag(:is_physical)
      log_in(seller)

      schedule

      expect(response).to have_http_status(:unprocessable_entity)
    end

    it "hands a seller in a time zone whose abbreviation Node cannot print to Rails", parity: true do
      seller.update!(timezone: "London")
      log_in(seller)

      schedule(zone: "Europe/London")

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["publish_schedule"]["label"]).to match(/(GMT|BST)\z/)
    end

    it "refuses a support team member", parity: true do
      as_team_member(TeamMembership::ROLE_SUPPORT)

      schedule

      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body).to eq("success" => false, "error" => "Your current role as Support cannot perform this action.")
    end

    it "answers not found for an unknown product", parity: true do
      log_in(seller)

      send_json(:post, "/links/nosuchproduct/publish_schedule", local_time: local(3))

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "error" => "Not found")
    end

    it "answers not found for the product of another seller", parity: true do
      other = create(:product, user: create(:user, name: "Other Seller"), unique_permalink: "otherprod", draft: true)
      log_in(seller)

      send_json(:post, "/links/#{other.unique_permalink}/publish_schedule", local_time: local(3))

      expect(response).to have_http_status(:not_found)
    end

    it "answers not found for a deleted product", parity: true do
      product.update_columns(deleted_at: Time.current)
      log_in(seller)

      schedule

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "DELETE /links/:link_id/publish_schedule" do
    it "cancels a pending schedule", parity: true do
      log_in(seller)
      create(:product_publish_schedule, product:)

      send_json(:delete, path)

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to eq("success" => true)
      expect(product.reload.publish_schedule).to be_nil
    end

    it "dismisses a failure banner", parity: true do
      log_in(seller)
      create(:product_publish_schedule, product:, status: "failed", failure_message: "We couldn't publish your product.")

      send_json(:delete, path)

      expect(response).to have_http_status(:ok)
      expect(product.reload.publish_schedule).to be_nil
    end

    it "does not cancel a schedule the job has claimed", parity: true do
      log_in(seller)
      create(:product_publish_schedule, product:, status: "publishing", claimed_at: Time.current)

      send_json(:delete, path)

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body).to eq("success" => false, "error_message" => "There is no schedule to cancel.")
      expect(product.reload.publish_schedule.status).to eq("publishing")
    end

    it "keeps a schedule that already published", parity: true do
      log_in(seller)
      create(:product_publish_schedule, product:, status: "published", published_at: Time.current)

      send_json(:delete, path)

      expect(response).to have_http_status(:unprocessable_entity)
    end

    it "refuses when there is no schedule", parity: true do
      log_in(seller)

      send_json(:delete, path)

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["error_message"]).to eq("There is no schedule to cancel.")
    end

    it "cancels a schedule after the flag was turned off", parity: true do
      Feature.deactivate_user(:scheduled_product_publishing, seller)
      log_in(seller)
      create(:product_publish_schedule, product:)

      send_json(:delete, path)

      expect(response).to have_http_status(:ok)
    end

    it "cancels a schedule of a product that was published since", parity: true do
      product.update_columns(draft: false)
      log_in(seller)
      create(:product_publish_schedule, product:)

      send_json(:delete, path)

      expect(response).to have_http_status(:ok)
    end

    it "refuses a support team member", parity: true do
      as_team_member(TeamMembership::ROLE_SUPPORT)
      create(:product_publish_schedule, product:)

      send_json(:delete, path)

      expect(response).to have_http_status(:unauthorized)
      expect(ProductPublishSchedule.where(product_id: product.id).count).to eq(1)
    end

    it "answers not found for the product of another seller", parity: true do
      other = create(:product, user: create(:user, name: "Other Seller"), unique_permalink: "otherprod", draft: true)
      log_in(seller)
      create(:product_publish_schedule, product: other)

      send_json(:delete, "/links/#{other.unique_permalink}/publish_schedule")

      expect(response).to have_http_status(:not_found)
      expect(ProductPublishSchedule.where(product_id: other.id).count).to eq(1)
    end

    it "answers not found for an unknown product", parity: true do
      log_in(seller)

      send_json(:delete, "/links/nosuchproduct/publish_schedule")

      expect(response).to have_http_status(:not_found)
    end
  end
end
