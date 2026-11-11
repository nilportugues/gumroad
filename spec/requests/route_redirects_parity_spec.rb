# frozen_string_literal: true

require "spec_helper"

# The redirect-only routes of config/routes.rb (`to: redirect(...)`, no controller), recorded for the Next.js
# port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/route-redirects.replay.test.ts. No controller runs, so
# a signed-in visitor gets the same answer (route_redirects_signed_in_spec.rb).
describe "Route redirects", type: :request do
  def location_path
    URI.parse(response.location).then { |uri| [[uri.path, uri.query].compact.join("?"), uri.fragment].compact.join("#") }
  end

  def expect_redirect(from, to, status: :moved_permanently)
    get from
    expect(response).to have_http_status(status)
    expect(location_path).to eq(to)
  end

  describe "on the Gumroad domain" do
    before { host! DOMAIN }

    {
      "/careers" => "/gumclaw",
      "/careers/designer" => "/gumclaw",
      "/careers/designer?ref=board" => "/gumclaw",
      "/jobs" => "/gumclaw",
      "/jobs?utm_source=x" => "/gumclaw",
      "/taxes" => "/pricing",
      "/taxes?plan=pro" => "/pricing",
      "/affiliate_requests/onboarding_form" => "/affiliates/onboarding",
      "/settings/profiles" => "/settings",
      "/settings/profiles?tab=a" => "/settings",
      "/settings/profile" => "/profile",
      "/settings/profile?" => "/profile",
      "/settings/profile?section=bio&x=a+b" => "/profile?section=bio&x=a+b",
      "/purchases" => "/library",
      "/purchases?query=x" => "/library",
      "/l/product-name/offer-code" => "/guide/basics/reach-your-audience#offers",
      "/bundles/abc/edit" => "/bundles/abc/product/edit",
      "/bundles/abc/edit?x=1" => "/bundles/abc/product/edit",
      "/bundles/abc/edit/content" => "/bundles/abc/content/edit",
      "/bundles/abc/edit/share" => "/bundles/abc/share/edit",
      "/bundles/a%20b/edit" => "/bundles/a%20b/product/edit",
      "/links/abc/edit" => "/products/abc/edit",
      "/links/abc/edit?x=1" => "/products/abc/edit",
      "/products/abc" => "/l/abc",
      "/products/abc?affiliate_id=1&x=a+b" => "/l/abc",
      "/product/abc" => "/l/abc",
      "/products/abc/OFFER" => "/l/abc/OFFER",
      "/products/abc/OFFER?x=1" => "/l/abc/OFFER",
      "/product/abc/OFFER" => "/l/abc/OFFER",
      "/products/a%20b" => "/l/a%20b",
      "/products/a%2Fb" => "/l/a/b",
      "/products/a+b" => "/l/a+b",
      "/products/a%25b" => "/l/a%25b",
      "/products/caf%C3%A9" => "/l/caf%C3%A9",
      "/products/a:b@c" => "/l/a:b@c",
      "/products/a%3Fb" => "/l/a%3Fb",
      "/products/a%23b" => "/l/a%23b",
      "/products/a%26b%3Dc" => "/l/a&b=c",
      "/products/a%21%24%27%28%29%2A%2C%3B%7E" => "/l/a!$'()*,;~",
      "/products/a%3Cb%3E" => "/l/a%3Cb%3E",
      "/analytics" => "/dashboard/sales",
      "/analytics?x=1" => "/dashboard/sales",
      "/audience" => "/dashboard/audience",
      "/dashboard/consumption" => "/dashboard/audience",
      "/subscriptions/cancel_subscription/abc" => "/subscriptions/abc/manage",
      "/subscriptions/cancel_subscription/abc?token=t" => "/subscriptions/abc/manage?token=t",
      "/subscriptions/abc/cancel_subscription?token=t&a=1" => "/subscriptions/abc/manage?a=1&token=t",
      "/subscriptions/abc/cancel_subscription?x=a+b" => "/subscriptions/abc/manage?x=a+b",
      "/subscriptions/abc/cancel_subscription?x=a%20b%26c" => "/subscriptions/abc/manage?x=a+b%26c",
      "/subscriptions/abc/cancel_subscription?x=" => "/subscriptions/abc/manage?x=",
      "/subscriptions/abc/cancel_subscription?x" => "/subscriptions/abc/manage",
      "/subscriptions/abc/cancel_subscription?" => "/subscriptions/abc/manage",
      "/subscriptions/abc/cancel_subscription?x=~*.-_!'()" => "/subscriptions/abc/manage?x=~%2A.-_%21%27%28%29",
      "/subscriptions/abc/cancel_subscription?x=caf%C3%A9" => "/subscriptions/abc/manage?x=caf%C3%A9",
      "/subscriptions/abc/cancel_subscription?x=1&x=2" => "/subscriptions/abc/manage?x=2",
      "/subscriptions/abc/cancel_subscription?a=1&&b=2" => "/subscriptions/abc/manage?a=1&b=2",
      "/subscriptions/abc/cancel_subscription?x=1;y=2" => "/subscriptions/abc/manage?x=1%3By%3D2",
      "/subscriptions/abc/cancel_subscription" => "/subscriptions/abc/manage",
      "/subscriptions/abc/edit_card" => "/subscriptions/abc/manage",
      "/subscriptions/a%20b/edit_card" => "/subscriptions/a%20b/manage",
      "/posts" => "/emails",
      "/posts?x=1" => "/emails",
      "/utm_links" => "/dashboard/utm_links",
      "/webhooks" => "/ping",
      "/overlay" => "/widgets",
      "/embed" => "/widgets",
      "/modal" => "/widgets",
      "/button" => "/widgets",
      "/button?x=1" => "/widgets",
      "/CHARGE" => "/charge",
      "/docs/cli/pages" => "/api#custom-html",
      "/blackfriday" => "/discover?offer_code=BLACKFRIDAY2025",
      "/blackfriday?x=1" => "/discover?offer_code=BLACKFRIDAY2025",
      "/janedoe/posts" => "/janedoe",
      "/janedoe/posts?x=1" => "/janedoe",
      "/janedoe/updates" => "/janedoe/posts",
      "/jane%20doe/updates" => "/jane%20doe/posts",
      "/jane_doe/posts" => "/jane_doe",
      "/products/posts" => "/l/posts",
      "/links/posts" => "/links",
    }.each do |from, to|
      it "answers #{from.sub(/\?\z/, " with an empty query string")} with a 301 to #{to}", parity: true do
        expect_redirect(from, to)
      end
    end

    it "answers /install-cli.sh with a 301 to the CLI install script", parity: true do
      get "/install-cli.sh"

      expect(response).to have_http_status(:moved_permanently)
      expect(response.location).to eq("https://raw.githubusercontent.com/antiwork/gumroad-cli/refs/heads/main/script/install.sh")
    end

    it "hands an array query on a subscription link to Rails, which rebuilds it with to_query", parity: true do
      expect_redirect("/subscriptions/abc/cancel_subscription?a[]=1&a[]=2", "/subscriptions/abc/manage?a%5B%5D=1&a%5B%5D=2")
    end

    it "hands a nested query on a subscription link to Rails, which rebuilds it with to_query", parity: true do
      expect_redirect("/subscriptions/abc/edit_card?a[b]=1", "/subscriptions/abc/manage?a%5Bb%5D=1")
    end

    it "answers /users/sign_in with the query string kept", parity: true do
      expect_redirect("/users/sign_in?next=%2Fdashboard", "/login?next=%2Fdashboard")
    end

    it "answers /users/sign_in with an empty query string", parity: true do
      expect_redirect("/users/sign_in?", "/login")
    end

    it "answers /users/sign_up with the query string kept", parity: true do
      expect_redirect("/users/sign_up?referrer=alice", "/signup?referrer=alice")
    end

    it "answers a HEAD request the way a GET is answered", parity: true do
      head "/analytics"

      expect(response).to have_http_status(:moved_permanently)
      expect(location_path).to eq("/dashboard/sales")
    end
  end

  describe "on the Discover domain" do
    before { host! VALID_DISCOVER_REQUEST_HOST }

    {
      "/animation" => "/3d",
      "/animation/scene?x=1" => "/3d/scene?x=1",
      "/animationfoo" => "/3dfoo",
      "/animation/a%20b?q=a+b" => "/3d/a%20b?q=a+b",
    }.each do |from, to|
      it "answers #{from} with a 301 to #{to}", parity: true do
        expect_redirect(from, to)
      end
    end
  end

  describe "on a seller subdomain" do
    let(:seller) { create(:named_seller) }

    before { host! seller.subdomain }

    {
      "/posts" => "/",
      "/posts?x=1" => "/",
      "/updates" => "/posts",
      "/updates?x=1" => "/posts",
      "/follow" => "/subscribe",
      "/follow?x=1" => "/subscribe",
    }.each do |from, to|
      it "answers #{from} with a 301 to #{to}", parity: true do
        expect_redirect(from, to)
      end
    end
  end
end
