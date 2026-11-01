# frozen_string_literal: true

require "spec_helper"

# The post page on seller subdomains and custom domains (PostsController#show) and the Gumroad blog's
# post page, recorded for the Next.js port (PARITY_RECORD=1). Replayed by
# nextjs/parity/__tests__/storefront.replay.test.ts.
describe "Post pages", type: :request do
  let(:seller) { create(:named_seller, name: "Parity Seller", bio: "Makes things.") }

  def inertia_props_of(response)
    page = response.body[/<script[^>]*data-page="[^"]*"[^>]*>(.*?)<\/script>/m, 1] || CGI.unescapeHTML(response.body[/\sdata-page="([^"]*)"/, 1])
    JSON.parse(page)["props"]
  end

  def seller_host!(user = seller)
    host! user.subdomain
  end

  describe "on a seller subdomain" do
    before { seller_host! }

    it "renders a published audience post", parity: true do
      post_record = create(:audience_post, :published, seller:, shown_on_profile: true, name: "Hello world", message: "<p>Some words</p>")

      get "/p/#{post_record.slug}"

      expect(response).to be_successful
      expect(inertia_props_of(response)).to include("subject" => "Hello world", "slug" => post_record.slug)
    end

    it "shows the first figure as the social image", parity: true do
      message = '<p>Intro</p><figure><img src="https://example.com/cover.png"><p class="figcaption">A caption</p></figure>'
      post_record = create(:audience_post, :published, seller:, shown_on_profile: true, name: "With image", message:)

      get "/p/#{post_record.slug}"

      expect(response).to be_successful
    end

    it "renders the call to action", parity: true do
      post_record = create(:audience_post, :published, seller:, shown_on_profile: true, name: "CTA", message: "<p>Hi</p>", call_to_action_text: "Buy now", call_to_action_url: "https://example.com/buy")

      get "/p/#{post_record.slug}"

      expect(response).to be_successful
    end

    it "lists the seller's other posts as recent posts", parity: true do
      create(:audience_post, :published, seller:, shown_on_profile: true, name: "Older", message: "<p>Older body that is long enough to be truncated later on in the list of recent posts</p>", published_at: 2.days.ago)
      create(:audience_post, :published, seller:, shown_on_profile: true, name: "Newer", message: "<p>Newer body</p>", published_at: 1.day.ago)
      post_record = create(:audience_post, :published, seller:, shown_on_profile: true, name: "Current", message: "<p>Current</p>")

      get "/p/#{post_record.slug}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["recent_posts"].size).to eq(2)
    end

    it "renders the comments of a post that allows them", parity: true do
      post_record = create(:audience_post, :published, seller:, shown_on_profile: true, name: "Discussed", message: "<p>Talk</p>")
      post_record.update!(allow_comments: true)
      root = create(:comment, commentable: post_record, content: "First", author: create(:user, name: "Commenter"))
      create(:comment, commentable: post_record, content: "A reply", parent: root, author: create(:user, name: "Replier"))

      get "/p/#{post_record.slug}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["paginated_comments"]["comments"].size).to eq(2)
    end

    it "marks a seller with a posts section", parity: true do
      create(:seller_profile_posts_section, seller:)
      post_record = create(:audience_post, :published, seller:, shown_on_profile: true, name: "Sectioned", message: "<p>Body</p>")

      get "/p/#{post_record.slug}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["has_posts_on_profile"]).to eq(true)
    end

    it "uses the seller's profile theme", parity: true do
      seller.seller_profile.update!(font: "Domine", highlight_color: "#ff0000", background_color: "#00ff00")
      post_record = create(:audience_post, :published, seller:, shown_on_profile: true, name: "Themed", message: "<p>Body</p>")

      get "/p/#{post_record.slug}"

      expect(response).to be_successful
      expect(inertia_props_of(response)["custom_styles"]).to be_present
    end

    it "is a 404 for an unpublished post", parity: true do
      post_record = create(:audience_post, seller:, name: "Draft", message: "<p>Body</p>")

      get "/p/#{post_record.slug}"

      expect(response).to have_http_status(:not_found)
    end

    it "is a 404 for an unknown slug", parity: true do
      get "/p/no-such-post"

      expect(response).to have_http_status(:not_found)
    end

    it "renders another seller's post on this host", parity: true do
      other_post = create(:audience_post, :published, seller: create(:user, username: "otherseller"), shown_on_profile: true, name: "Other", message: "<p>Body</p>")

      get "/p/#{other_post.slug}"

      expect(response).to be_successful
    end

    it "answers an Inertia visit with the page as JSON", parity: true do
      post_record = create(:audience_post, :published, seller:, shown_on_profile: true, name: "Visited", message: "<p>Body</p>")

      get "/p/#{post_record.slug}", headers: { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest" }

      expect(response).to be_successful
      expect(response.parsed_body["component"]).to eq("Posts/Show")
    end
  end

  describe "on a custom domain" do
    it "renders the post", parity: true do
      create(:custom_domain, user: seller, domain: "parity-seller.example.com")
      post_record = create(:audience_post, :published, seller:, shown_on_profile: true, name: "Custom domain post", message: "<p>Body</p>")
      host! "parity-seller.example.com"

      get "/p/#{post_record.slug}"

      expect(response).to be_successful
    end
  end

  describe "the Gumroad blog" do
    let(:blog_owner) { create(:user, username: "gumroad") }

    before { host! DOMAIN }

    it "renders a post", parity: true do
      post_record = create(:audience_post, :published, seller: blog_owner, shown_on_profile: true, name: "Blog post", message: "<p>Body</p>")

      get "/blog/p/#{post_record.slug}"

      expect(response).to be_successful
    end
  end
end
