# frozen_string_literal: true

require "spec_helper"

# The shared props a signed-in request computes from data the first Next.js port could not read:
# an uploaded avatar, a US minor's guardian and a payout setup rejection note. Recorded for the port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/help-center-signed-in-gaps.replay.test.ts, which sends the last request of
# each example.
describe "Help center when signed in, with data the shared props read", type: :request do
  let(:seller) { create(:user, name: "Signed In Seller") }
  let(:article_path) { help_center_article_path(HelpCenter::Article.first) }

  before { host! DOMAIN }

  # Forgery protection is on in the test environment, so a page's token is fetched first.
  def csrf_token
    get help_center_category_path(HelpCenter::Category.first)
    inertia_props_of(response).fetch("authenticity_token")
  end

  def log_in(user)
    post login_path, params: { authenticity_token: csrf_token, user: { login_identifier: user.email, password: user.password } }
    expect(response).to have_http_status(:found)
  end

  def inertia_props_of(response)
    page = response.body[/<script[^>]*data-page="[^"]*"[^>]*>(.*?)<\/script>/m, 1] || CGI.unescapeHTML(response.body[/\sdata-page="([^"]*)"/, 1])
    JSON.parse(page)["props"]
  end

  describe "an uploaded avatar" do
    def upload(fixture, filename:, content_type:)
      ActiveStorage::Blob.create_and_upload!(io: File.open(Rails.root.join("spec/support/fixtures", fixture)), filename:, content_type:)
    end

    # The processed 400x400 variant Rails keeps for the avatar. The digest is Active Storage's own, and
    # the variant's file is a stand-in: ImageMagick is not needed to read an existing variant.
    def attach_avatar(blob)
      ActiveStorage::Attachment.create!(name: "avatar", record: seller, blob:)
      variation = seller.reload.avatar.variant(resize_to_limit: [400, 400]).variation
      variant_record = blob.variant_records.create!(variation_digest: variation.digest)
      ActiveStorage::Attachment.create!(name: "image", record: variant_record, blob: upload("kFDzu.png", filename: "resized.png", content_type: "image/png"))
    end

    it "links the processed variant of a png avatar", parity: true do
      attach_avatar(upload("lemons-640x362.png", filename: "lemons.png", content_type: "image/png"))
      log_in(seller)

      get article_path

      expect(response).to be_successful
      props = inertia_props_of(response)
      expect(props["logged_in_user"]["avatar_url"]).to eq(seller.avatar_url)
      expect(props["logged_in_user"]["avatar_url"]).not_to include("default-avatar")
      expect(props["current_seller"]["avatar_url"]).to eq(seller.avatar_url)
    end

    it "links the processed variant of a jpeg avatar named in capitals", parity: true do
      attach_avatar(upload("autumn-leaves-1280x720.jpeg", filename: "LEAVES.JPG", content_type: "image/jpeg"))
      log_in(seller)

      get article_path

      expect(inertia_props_of(response)["logged_in_user"]["avatar_url"]).to eq(seller.avatar_url)
    end

    it "links the uploaded file itself when it cannot be turned into a variant", parity: true do
      blob = upload("test.pdf", filename: "not-an-image.pdf", content_type: "application/pdf")
      ActiveStorage::Attachment.create!(name: "avatar", record: seller, blob:)
      log_in(seller)

      get article_path

      expect(inertia_props_of(response)["logged_in_user"]["avatar_url"]).to eq(seller.reload.avatar.url)
    end

    it "shows the avatar of the seller a team member switched into", parity: true do
      attach_avatar(upload("lemons-640x362.png", filename: "lemons.png", content_type: "image/png"))
      member = create(:user, name: "Team Member")
      # Memberships created in the same second are ordered arbitrarily by MySQL.
      create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_ADMIN, created_at: 1.hour.ago)
      log_in(member)

      get article_path

      memberships = inertia_props_of(response)["logged_in_user"]["team_memberships"]
      expect(memberships.map { _1["seller_avatar_url"] }).to include(seller.avatar_url)
    end
  end

  describe "a US minor's guardian" do
    let(:birthday) { Date.current - 15.years }

    def minor_with(guardian = nil)
      create(:user_compliance_info, user: seller, birthday:, guardian:)
    end

    it "is not met without a guardian", parity: true do
      minor_with
      log_in(seller)

      get article_path

      expect(inertia_props_of(response)["current_seller"]).to include("legal_guardian_requirement_met" => false, "legal_guardian_unsupported" => false)
    end

    it "is met by a complete guardian", parity: true do
      minor_with(create(:guardian, user: seller))
      log_in(seller)

      get article_path

      expect(inertia_props_of(response)["current_seller"]).to include("legal_guardian_requirement_met" => true)
    end

    it "is not met by a guardian who has not accepted the terms", parity: true do
      minor_with(create(:guardian, user: seller, stripe_tos_accepted: false, stripe_tos_accepted_at: nil, stripe_tos_ip: nil))
      log_in(seller)

      get article_path

      expect(inertia_props_of(response)["current_seller"]).to include("legal_guardian_requirement_met" => false)
    end

    it "is not met by a guardian without a state in a country that has a state list", parity: true do
      minor_with(create(:guardian, user: seller, state: nil))
      log_in(seller)

      get article_path

      expect(inertia_props_of(response)["current_seller"]).to include("legal_guardian_requirement_met" => false)
    end

    it "is not met by a guardian who was removed", parity: true do
      guardian = create(:guardian, user: seller)
      minor_with(guardian)
      guardian.mark_deleted!
      log_in(seller)

      get article_path

      expect(inertia_props_of(response)["current_seller"]).to include("legal_guardian_requirement_met" => false)
    end
  end

  describe "a seller who cannot publish" do
    before { seller.update!(payment_address: nil) }

    def payout_note(json_data, author_id: GUMROAD_ADMIN_ID, **attributes)
      Comment.create!(commentable: seller, author_id:, comment_type: Comment::COMMENT_TYPE_PAYOUT_NOTE, content: "Stripe rejected the setup", json_data:, **attributes)
    end

    it "is told the payout setup was rejected when the admin left a marked note", parity: true do
      payout_note({ StripeMerchantAccountManager::PAYOUT_SETUP_REJECTION_NOTE_FLAG => true })
      log_in(seller)

      get article_path

      expect(inertia_props_of(response)["current_seller"]).to include("can_publish_products" => false, "publish_blocked_reason" => "payout_setup_rejected")
    end

    it "is told there is no payout method when the note's marker is false, deleted or someone else's", parity: true do
      payout_note({ StripeMerchantAccountManager::PAYOUT_SETUP_REJECTION_NOTE_FLAG => false })
      payout_note({ StripeMerchantAccountManager::PAYOUT_SETUP_REJECTION_NOTE_FLAG => true }, deleted_at: 1.day.ago)
      payout_note({ StripeMerchantAccountManager::PAYOUT_SETUP_REJECTION_NOTE_FLAG => true }, author_id: create(:user).id)
      payout_note({ "mentions" => "payout_setup_rejection in passing" })
      log_in(seller)

      get article_path

      expect(inertia_props_of(response)["current_seller"]).to include("can_publish_products" => false, "publish_blocked_reason" => "no_payout_method")
    end

    it "is told there is no payout method without any note", parity: true do
      log_in(seller)

      get article_path

      expect(inertia_props_of(response)["current_seller"]).to include("can_publish_products" => false, "publish_blocked_reason" => "no_payout_method")
    end
  end
end
