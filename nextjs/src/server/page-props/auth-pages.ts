// The props of the authentication pages: AuthPresenter, LoginsController#new, SignupController#new,
// TwoFactorAuthenticationController#show and SecureRedirectController#new. The filters that run before
// them (redirects, the OAuth application, the passkey challenge) are in controllers/auth-pages.ts and
// hand their findings over as `action.state`.
import { db } from "../../lib/db.ts";
import { teamInvitationEmail } from "../controllers/auth-pages.ts";
import { isPresent, queryParam, type RailsRequest } from "../controllers/rails-request.ts";
import { requestCookies } from "../controllers/rack-cookies.ts";
import { getRedis } from "../infra/redis.ts";
import type { ActionContext } from "./load-page.ts";

const MOBILE_APP_COOKIE = "is_gumroad_mobile_app";
const NUMBER_OF_CREATORS_KEY = "company_page:number_of_creators";
const TOTAL_MADE_KEY = "homepage:total_made";
// User::DEFAULT_AUTH_TOKEN, shown outside production so the form can be filled in.
const DEFAULT_AUTH_TOKEN = "000000";
const LOGIN_DESCRIPTION = "Log in to your Gumroad account to access your dashboard, library, and sales.";
const SIGNUP_DESCRIPTION = "Create a free Gumroad account. Sell digital products, memberships, and courses with no monthly fee. Direct sales: 10% + 50¢. Discover: 30%.";

// The tags PageMeta::Analytics sets, which stay where ApplicationController declares them while the
// subclasses' re-declared callbacks (title, CSRF, defaults) move to the end of the chain.
const ANALYTICS_META_KEYS = [
  "meta-property-gr-google_analytics-enabled",
  "meta-property-gr-fb_pixel-enabled",
  "meta-property-gr-tiktok_pixel-enabled",
  "meta-property-gr-logged_in_user-id",
  "meta-property-gr-page-type",
];

// params[name] for a flat query key; a bracketed one was handed back to Rails by the filters.
const queryValue = (action: ActionContext, name: string) => queryParam({ queryString: action.url.search.replace(/^\?/u, "") } as RailsRequest, name);

const mobileApp = (action: ActionContext) => isPresent(requestCookies(action.headers.get("cookie")).get(MOBILE_APP_COOKIE));

const loginProps = (action: ActionContext) => ({
  email: queryValue(action, "email") ?? teamInvitationEmail(queryValue(action, "next") ?? null),
  application_name: action.state.application_name ?? null,
});

const canonical = (action: ActionContext, path: string) => ({
  tag_name: "link",
  rel: "canonical",
  href: `${action.config.protocol}://${action.config.domain}${path}`,
  head_key: "canonical",
});

// LoginsController re-declares set_csrf_meta_tags and set_default_meta_tags, which moves them behind
// the analytics tags; the title stays first.
export function loginPageProps(action: ActionContext) {
  const { meta } = action;
  meta.moveToEnd(meta.keys().filter((key) => key !== "title" && !ANALYTICS_META_KEYS.includes(key)));
  meta.set({ title: "Log in to Gumroad" });
  meta.set({ name: "description", content: LOGIN_DESCRIPTION });
  meta.set(canonical(action, "/login"));
  return { ...loginProps(action), is_gumroad_mobile_app: mobileApp(action), passkey_login_options: action.state.passkey_login_options };
}

// SignupController also re-declares set_default_page_title, so the title moves too.
export async function signupPageProps(action: ActionContext) {
  const { meta } = action;
  meta.moveToEnd(meta.keys().filter((key) => !ANALYTICS_META_KEYS.includes(key)));
  meta.set({ title: "Sign up for Gumroad" });
  meta.set({ name: "description", content: SIGNUP_DESCRIPTION });
  meta.set(canonical(action, "/signup"));

  const referrerName = queryValue(action, "referrer");
  const referrer = isPresent(referrerName) ? await db.user.findFirst({ where: { username: referrerName } }) : null;
  const [numberOfCreators, totalMade] = await signupStats();
  return {
    ...loginProps(action),
    referrer: referrer ? { id: referrer.external_id, name: isPresent(referrer.name) ? referrer.name : isPresent(referrer.username) ? referrer.username : referrer.external_id } : null,
    stats: { number_of_creators: rubyToI(numberOfCreators), total_made: rubyToI(totalMade) },
    is_gumroad_mobile_app: mobileApp(action),
  };
}

// A presenter is rebuilt on every request, so the last values this process read live here; a stalled
// Redis read serves those instead of rendering zeros.
const lastSignupStats: { numberOfCreators?: string | null; totalMade?: string | null } = {};

async function signupStats(): Promise<[string | null | undefined, string | null | undefined]> {
  try {
    const [numberOfCreators = null, totalMade = null] = await getRedis("main").mget(NUMBER_OF_CREATORS_KEY, TOTAL_MADE_KEY);
    Object.assign(lastSignupStats, { numberOfCreators, totalMade });
    return [numberOfCreators, totalMade];
  } catch {
    return [lastSignupStats.numberOfCreators, lastSignupStats.totalMade];
  }
}

// String#to_i (nil.to_i is 0): optional sign, then digits with single underscores between them.
export function rubyToI(value: string | null | undefined): number {
  const match = /^\s*([+-]?\d+(?:_\d+)*)/u.exec(value ?? "");
  return match ? Number(match[1]!.replaceAll("_", "")) : 0;
}

export function twoFactorPageProps(action: ActionContext) {
  action.meta.set({ title: "Two-Factor Authentication" });
  const { state } = action;
  return {
    user_id: state.user_id,
    email: state.email,
    token: action.config.railsEnv === "production" ? null : DEFAULT_AUTH_TOKEN,
    two_factor_method: state.two_factor_method,
    token_sent_at: state.token_sent_at,
    resend_cooldown_seconds: state.resend_cooldown_seconds,
  };
}

export function secureRedirectPageProps({ state }: ActionContext) {
  return { message: state.message, field_name: state.field_name, error_message: state.error_message, encrypted_payload: state.encrypted_payload };
}
