import { describe, expect, it, vi } from "vitest";

import type { RequestContext } from "@/server/auth/context";

import { formAuthenticityToken, globalCsrfToken, maskToken, unmaskToken } from "./csrf.ts";
import { domainConfig } from "./domain.ts";
import { categoryProps, enumConstant, findCategoryBySlug, helpCenterData } from "./help-center.ts";
import { deepMerge } from "./load-page.ts";
import { MetaTag, MetaTagBuilder, pageTitle, parameterize } from "./meta-tags.ts";
import type { SharedPropsPorts } from "./ports.ts";
import { applicationMetaTags, isMobile, preferredLanguages, sharedProps } from "./shared.ts";

const signedOut: RequestContext = { loggedInUser: null, currentSeller: null, impersonatedUser: null };

const ports = (overrides: Partial<SharedPropsPorts> = {}): SharedPropsPorts => ({
  session: {
    rawCsrfToken: async () => null,
    consumeFlash: async () => ({}),
    consumeInertiaErrors: async () => ({}),
    value: async () => undefined,
  },
  flags: { isActive: async () => false },
  presenters: {
    loggedInUser: vi.fn(),
    currentSeller: vi.fn(),
    currentUser: vi.fn(),
    showPasskeySetupPrompt: vi.fn(),
    thirdPartyAnalyticsDisabled: vi.fn(),
  },
  ...overrides,
});

describe("InertiaRails::MetaTag port", () => {
  it("generates head keys the way inertia_rails does", () => {
    expect(new MetaTag({ title: "Hi" }).toJSON()).toEqual({ tagName: "title", headKey: "title", innerContent: "Hi" });
    expect(new MetaTag({ name: "twitter:card", content: "summary" }).headKey).toBe("meta-name-twitter-card");
    expect(new MetaTag({ property: "og:image:alt", content: "Gumroad" }).headKey).toBe("meta-property-og-image-alt");
    expect(new MetaTag({ charset: "utf-8" }).headKey).toBe("meta-charset");
    expect(new MetaTag({ tag_name: "link", rel: "canonical", href: "/x", head_key: "canonical" }).headKey).toBe("canonical");
    // md5("href=/opensearch.xml&rel=search&title=Gumroad&type=application/opensearchdescription+xml")[0, 8]
    expect(new MetaTag({ tag_name: "link", rel: "search", href: "/opensearch.xml", type: "application/opensearchdescription+xml", title: "Gumroad" }).headKey).toMatch(/^link-[0-9a-f]{8}$/u);
  });

  it("serialises camelCased keys and drops blank values", () => {
    expect(new MetaTag({ property: "gr:page:type", content: "" }).toJSON()).toEqual({ tagName: "meta", headKey: "meta-property-gr-page-type", property: "gr:page:type" });
    expect(new MetaTag({ http_equiv: "refresh", content: "5" }).toJSON()).toEqual({ tagName: "meta", headKey: "meta-http_equiv-refresh", httpEquiv: "refresh", content: "5" });
  });

  it("replaces a tag with the same head key in place", () => {
    const meta = new MetaTagBuilder().set({ title: "First" }).set({ name: "a", content: "1" }).set({ title: "Second" });
    expect(meta.toJSON().map((tag) => tag.headKey)).toEqual(["title", "meta-name-a"]);
    expect(pageTitle(meta, "production")).toBe("Second");
    expect(pageTitle(new MetaTagBuilder(), "staging")).toBe("Staging Gumroad");
  });

  it("parameterizes like ActiveSupport", () => {
    expect(parameterize("og:image:alt")).toBe("og-image-alt");
    expect(parameterize("Crème Brûlée!")).toBe("creme-brulee");
  });
});

describe("CSRF token masking", () => {
  const session = Buffer.alloc(32, 7).toString("base64");

  it("masks the HMAC of the session token with a one-time pad, as Rails does", () => {
    const pad = Buffer.alloc(32, 1);
    const masked = maskToken(globalCsrfToken(session), pad);
    expect(Buffer.from(masked, "base64url").subarray(0, 32)).toEqual(pad);
    expect(unmaskToken(masked)).toEqual(globalCsrfToken(session));
  });

  it("produces a different but equivalent token on every call", () => {
    const first = formAuthenticityToken(session);
    const second = formAuthenticityToken(session);
    expect(first).not.toBe(second);
    expect(unmaskToken(first)).toEqual(unmaskToken(second));
    expect(first).toMatch(/^[A-Za-z0-9_-]{86}$/u);
  });
});

describe("request helpers", () => {
  it("orders Accept-Language like http_accept_language", () => {
    expect(preferredLanguages("fr-ch, fr;q=0.9, en;q=0.8, *;q=0.5")).toEqual(["fr-CH", "fr", "en"]);
    expect(preferredLanguages(null)).toEqual([]);
  });

  it("detects mobile from the session override, then the user agent", () => {
    expect(isMobile(undefined, "Mozilla/5.0 (iPhone) Mobile/15E148")).toBe(true);
    expect(isMobile("0", "Mozilla/5.0 (iPhone) Mobile/15E148")).toBe(false);
    expect(isMobile("1", "Mozilla/5.0 (Macintosh)")).toBe(true);
    expect(isMobile(undefined, null)).toBe(false);
  });

  it("deep merges like Hash#deep_merge: hashes merge, arrays are replaced", () => {
    expect(deepMerge({ a: { b: 1, c: [1, 2] }, d: 1 }, { a: { c: [3] }, d: null })).toEqual({ a: { b: 1, c: [3] }, d: null });
  });
});

describe("shared props", () => {
  const config = domainConfig({ RAILS_ENV: "production" });
  const request = { headers: new Headers({ "accept-language": "es-es,es;q=0.9", "user-agent": "Mozilla/5.0 (Macintosh)" }), url: new URL("https://gumroad.com/help") };

  it("renders the signed-out shared props and default meta tags", async () => {
    const meta = new MetaTagBuilder();
    const flash = { notice: "Saved", info: "FYI" };
    const sharedPorts = ports({ session: { ...ports().session, consumeFlash: async () => flash } });
    await applicationMetaTags(meta, { context: signedOut, config, csrfToken: "tok", ports: sharedPorts });
    meta.set({ title: "Page - Gumroad Help Center" });

    const props = await sharedProps({ context: signedOut, config, request, meta, csrfToken: "tok", ports: sharedPorts, mobileAppWebView: false });

    expect(props).toMatchObject({
      design_settings: { font: { name: "ABC Favorit", url: "https://assets.gumroad.com/fonts/ABCFavorit-Regular.woff2" } },
      domain_settings: { scheme: "https", app_domain: "gumroad.com", api_domain: "api.gumroad.com" },
      user_agent_info: { is_mobile: false },
      logged_in_user: null,
      current_seller: null,
      locale: "es-ES",
      feature_flags: { disable_stripe_signup: false },
      authenticity_token: "tok",
      // info outranks notice in FLASH_STATUSES.
      flash: { message: "FYI", status: "info" },
      title: "Page - Gumroad Help Center",
    });
    expect(props).not.toHaveProperty("current_user");
    expect(props).not.toHaveProperty("is_mobile_app_web_view");

    const tags = Object.fromEntries(meta.toJSON().map((tag) => [tag.headKey, tag]));
    expect(tags["meta-name-csrf-token"]).toMatchObject({ content: "tok" });
    expect(tags["meta-property-og-image"]).toMatchObject({ content: "https://assets.gumroad.com/images/opengraph_image.png" });
    expect(tags["meta-property-gr-google_analytics-enabled"]).toMatchObject({ content: "true" });
    expect(tags["meta-property-gr-logged_in_user-id"]).not.toHaveProperty("content");
  });

  it("shares is_mobile_app_web_view for controllers that enable it", async () => {
    const props = await sharedProps({
      context: signedOut,
      config,
      request: { ...request, url: new URL("https://gumroad.com/settings?display=mobile_app") },
      meta: new MetaTagBuilder(),
      csrfToken: "",
      ports: ports(),
      mobileAppWebView: true,
    });
    expect(props.is_mobile_app_web_view).toBe(true);
  });
});

describe("help center", () => {
  it("resolves every article's ERB category reference", () => {
    const { categories, articles } = helpCenterData();
    expect(categories).toHaveLength(11);
    expect(articles).toHaveLength(130);
    const ids = new Set(categories.map((category) => category.id));
    for (const article of articles) expect(ids.has(article.category_id)).toBe(true);
    expect(enumConstant("Issues with your purchase")).toBe("ISSUES_WITH_YOUR_PURCHASE");
  });

  it("builds HelpCenterPresenter#category_props", () => {
    const category = findCategoryBySlug("316-open-an-account")!;
    const props = categoryProps(category);

    expect(props.category).toMatchObject({ title: "Open an account", slug: "316-open-an-account" });
    expect(props.category.articles).toHaveLength(10);
    expect(props.category.articles[0]?.url).toMatch(/^\/help\/article\/[\w-]+$/u);
    expect(props.sidebar_categories.every((sidebar) => sidebar.url.startsWith("/help/category/"))).toBe(true);
    expect(props.sidebar_categories.map((sidebar) => sidebar.title)).toContain("Open an account");
    expect(props.sidebar_categories.map((sidebar) => sidebar.title)).not.toContain("Before you buy");
    expect(findCategoryBySlug("nope")).toBeNull();
  });
});
