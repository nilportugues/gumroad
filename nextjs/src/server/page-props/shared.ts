// The props every Inertia page receives from ApplicationController: InertiaRendering's inertia_share
// blocks, RenderingExtension#custom_context, and the meta tags set by PageMeta before_actions.
import { randomBytes } from "node:crypto";

import type { RequestContext } from "@/server/auth/context";
import { getConfig } from "@/server/infra/config";

import { requestCookies } from "../controllers/rack-cookies.ts";
import { detectedBuyerCurrency } from "../infra/buyer-currency-countries.ts";
import { remoteIp } from "./audience/events.ts";
import { formAuthenticityToken } from "./csrf.ts";
import { assetHost, type DomainConfig } from "./domain.ts";
import { MetaTagBuilder, defaultPageTitle, pageTitle } from "./meta-tags.ts";
import type { SharedPropsPorts } from "./ports.ts";

const STRIPE_API_VERSION_TEST = "2023-10-16";
const STRIPE_API_VERSION = "2023-10-16; risk_in_requirements_beta=v1; retrieve_tax_forms_beta=v1;";
const STRIPE_PUBLIC_KEY_PROD_DEFAULT = "pk_live_Db80xIzLPWhKo1byPrnERmym";
const STRIPE_PUBLIC_KEY_TEST_DEFAULT = "pk_test_ehGPKw3JPRHYiqEEjgJ02ULC";
const DEFAULT_LOCALE = "en-US";
const MOBILE_APP_COOKIE = "is_gumroad_mobile_app";

// InertiaRendering::FLASH_STATUSES, loudest first.
const FLASH_STATUSES = [
  ["alert", "danger"],
  ["warning", "warning"],
  ["info", "info"],
  ["notice", "success"],
] as const;

// ActionView asset helpers without an asset pipeline: public/ paths behind config.asset_host.
export function publicAssetUrl(config: DomainConfig, directory: "images" | "fonts", file: string): string {
  return `${assetHost(config) ?? ""}/${directory}/${file}`;
}

// http_accept_language 2.1 `user_preferred_languages`: territory upcased, sorted by quality.
export function preferredLanguages(header: string | null): string[] {
  try {
    return (header ?? "")
      .replace(/\s+/gu, "")
      .split(",")
      .filter((entry) => entry !== "")
      .map((entry) => {
        const [tag = "", quality] = entry.split(";q=");
        if (!/^[a-z\-0-9]+|\*$/iu.test(tag)) throw new Error("Not correctly formatted");
        const locale = tag.toLowerCase().replace(/-[a-z0-9]+$/iu, (territory) => territory.toUpperCase());
        return { locale: locale === "*" ? null : locale, quality: quality === undefined ? 1 : Number.parseFloat(quality) || 0 };
      })
      .sort((left, right) => right.quality - left.quality)
      .flatMap(({ locale }) => (locale === null ? [] : [locale]));
  } catch {
    return [];
  }
}

// ApplicationController#is_mobile?
export function isMobile(mobileParam: unknown, userAgent: string | null): boolean {
  // Ruby truthiness: an empty string still counts as set.
  if (mobileParam !== undefined && mobileParam !== null && mobileParam !== false) return mobileParam === "1";
  return userAgent !== null && userAgent !== "" && /Mobile|webOS/u.test(userAgent);
}

export type RequestInfo = { headers: Headers; url: URL };

// before_actions in ApplicationController that set meta tags, in their declared order.
export async function applicationMetaTags(
  meta: MetaTagBuilder,
  { context, config, csrfToken, ports, analyticsEnabled: analyticsOverride, analyticsFirst }: { context: RequestContext; config: DomainConfig; csrfToken: string; ports: SharedPropsPorts; analyticsEnabled?: boolean; analyticsFirst?: boolean },
) {
  const env = config.railsEnv;
  // A controller that re-declares set_default_page_title, set_csrf_meta_tags and set_default_meta_tags (Devise's) moves them
  // behind set_analytics_meta_tags, so the analytics tags come first.
  const setAnalytics = async () => {
    // PageMeta::Analytics#analytics_enabled? with seller = current_seller (no @user on these pages).
    const seller = context.currentSeller;
    let analyticsEnabled = true;
    if (analyticsOverride !== undefined) analyticsEnabled = analyticsOverride;
    else if (seller) analyticsEnabled = (env === "production" || env === "staging") && !(await ports.presenters.thirdPartyAnalyticsDisabled(seller));
    const loggedInUser = context.impersonatedUser ?? context.loggedInUser;
    meta.set({ property: "gr:google_analytics:enabled", content: String(analyticsEnabled) });
    meta.set({ property: "gr:fb_pixel:enabled", content: String(analyticsEnabled) });
    meta.set({ property: "gr:tiktok_pixel:enabled", content: String(analyticsEnabled) });
    meta.set({ property: "gr:logged_in_user:id", content: loggedInUser ? loggedInUser.external_id : "" });
    meta.set({ property: "gr:page:type", content: "" });
  };
  if (analyticsFirst) await setAnalytics();
  meta.set({ title: defaultPageTitle(env) });

  meta.set({ name: "csrf-param", content: "authenticity_token" });
  meta.set({ name: "csrf-token", content: csrfToken });

  const stripePublicKey =
    env === "production"
      ? (getConfig("STRIPE_PUBLIC_KEY_PROD") ?? STRIPE_PUBLIC_KEY_PROD_DEFAULT)
      : (getConfig("STRIPE_PUBLIC_KEY_TEST") ?? STRIPE_PUBLIC_KEY_TEST_DEFAULT);
  meta.set({ charset: "utf-8" });
  meta.set({ property: "fb:app_id", content: getConfig("FACEBOOK_APP_ID") ?? null });
  meta.set({ property: "fb:page_id", content: "http://www.facebook.com/gumroad" });
  meta.set({ property: "gr:environment", content: env });
  meta.set({ property: "og:image", content: publicAssetUrl(config, "images", "opengraph_image.png") });
  meta.set({ property: "og:image:alt", content: "Gumroad" });
  meta.set({ property: "og:title", content: "Gumroad" });
  meta.set({ property: "og:site_name", content: "Gumroad" });
  meta.set({ name: "viewport", content: "initial-scale = 1.0, width = device-width" });
  meta.set({ property: "stripe:pk", value: stripePublicKey });
  meta.set({ property: "stripe:api_version", value: env === "test" ? STRIPE_API_VERSION_TEST : STRIPE_API_VERSION });
  meta.set({ property: "twitter:site", content: "@gumroad" });
  meta.set({ tag_name: "link", rel: "search", href: "/opensearch.xml", type: "application/opensearchdescription+xml", title: "Gumroad" });
  meta.set({ tag_name: "link", rel: "shortcut icon", href: publicAssetUrl(config, "images", "pink-icon.png"), head_key: "shortcut-icon" });
  meta.set({ tag_name: "link", rel: "apple-touch-icon", href: publicAssetUrl(config, "images", "pink-icon.png"), head_key: "apple-touch-icon" });

  if (!analyticsFirst) await setAnalytics();
}

export async function sharedProps({
  context,
  config,
  request,
  meta,
  csrfToken,
  ports,
  mobileAppWebView,
  buyerCurrencyFooter = false,
}: {
  context: RequestContext;
  config: DomainConfig;
  request: RequestInfo;
  meta: MetaTagBuilder;
  csrfToken: string;
  ports: SharedPropsPorts;
  // Controllers that call `enable_mobile_app_web_view` share is_mobile_app_web_view.
  mobileAppWebView: boolean;
  buyerCurrencyFooter?: boolean;
}): Promise<Record<string, unknown>> {
  // pundit_user.user is logged_in_user: the impersonated user while impersonating.
  const pundit = { user: context.impersonatedUser ?? context.loggedInUser, seller: context.currentSeller };
  const flash = await ports.session.consumeFlash();
  const flashStatus = FLASH_STATUSES.find(([key]) => (flash[key] ?? "").trim() !== "");

  const props: Record<string, unknown> = {
    // view_context.font_url: absolute, on the request's own host where no asset_host is configured (test).
    design_settings: { font: { name: "ABC Favorit", url: `${assetHost(config) ?? request.url.origin}/fonts/ABCFavorit-Regular.woff2` } },
    domain_settings: {
      scheme: config.protocol,
      app_domain: config.domain,
      root_domain: config.rootDomain,
      short_domain: config.shortDomain,
      discover_domain: config.discoverDomain,
      third_party_analytics_domain: config.thirdPartyAnalyticsDomain,
      api_domain: config.apiDomain,
    },
    user_agent_info: { is_mobile: isMobile(await ports.session.value("mobile_param"), request.headers.get("user-agent")) },
    logged_in_user: pundit.user ? await ports.presenters.loggedInUser(context) : null,
    current_seller: pundit.seller ? await ports.presenters.currentSeller(context) : null,
    // Rails' SecureHeaders nonce; meaningful once Next.js sends its own CSP header.
    csp_nonce: randomBytes(32).toString("base64"),
    locale: preferredLanguages(request.headers.get("accept-language"))[0] ?? DEFAULT_LOCALE,
    feature_flags: { disable_stripe_signup: await ports.flags.isActive("disable_stripe_signup") },
    authenticity_token: csrfToken,
    flash: flashStatus ? { message: flash[flashStatus[0]], status: flashStatus[1] } : null,
    title: pageTitle(meta, config.railsEnv),
    // `inertia_share if: -> { buyer_currency_footer_actions.include?(action_name) }`
    ...(buyerCurrencyFooter ? { detected_buyer_currency: detectedBuyerCurrency(remoteIp(request.headers)) } : {}),
  };

  // `inertia_share if: :user_signed_in?`: Devise's current_user, the admin while impersonating.
  if (context.loggedInUser) {
    props.current_user = await ports.presenters.currentUser(context);
    props.prompt_passkey_setup = await ports.presenters.showPasskeySetupPrompt(context, {
      promptedUserId: await ports.session.value("prompt_passkey_setup"),
      mobileAppCookie: requestCookies(request.headers.get("cookie")).get(MOBILE_APP_COOKIE),
    });
  }
  if (mobileAppWebView) {
    const searchDisplay = request.url.searchParams.get("display");
    props.is_mobile_app_web_view = searchDisplay === "mobile_app" || (await ports.session.value("mobile_app_web_view")) === true;
  }
  return props;
}

export async function authenticityToken(ports: SharedPropsPorts): Promise<string> {
  const raw = await ports.session.rawCsrfToken();
  return raw === null ? "" : formAuthenticityToken(raw);
}
