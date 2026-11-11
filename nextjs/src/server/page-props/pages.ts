// The Inertia pages Next.js serves, keyed by their routes.json pattern. A page's props and redirects
// live here, not in page.tsx, because two places render them: the App Router page (HTML) and the
// X-Inertia route handler (JSON), and both must answer exactly as the Rails action does.
import { splitScopedPattern } from "@/lib/navigation/proxy/route-table";
import * as Routes from "@/lib/navigation/routes";

import type { ActionOptions, Redirected } from "../controllers/application-controller.ts";
import { LOGIN_OPTIONS, SECURE_REDIRECT_OPTIONS, SIGNUP_OPTIONS, TWO_FACTOR_OPTIONS } from "../controllers/auth-pages.ts";
import { REVIEW_REMINDER_OPTIONS, reviewReminderProps } from "../controllers/review-reminders.ts";
import { loginPageProps, secureRedirectPageProps, signupPageProps, twoFactorPageProps } from "./auth-pages.ts";
import { BUYER_PAGES } from "./buyer/pages.ts";
import { assetHost } from "./domain.ts";
import {
  articleProps,
  categoryProps,
  findArticleBySlug,
  findCategoryBySlug,
  indexProps,
  LEGACY_ARTICLE_REDIRECTS,
} from "./help-center.ts";
import type { PageGuard } from "./guards.ts";
import type { PreflightOutcome, PreflightRequest } from "./preflight.ts";
import { PUBLIC_PAGES } from "./public-pages.ts";
import { AUDIENCE_PAGES } from "./audience/pages.ts";
import { ANALYTICS_PAGES } from "./analytics/pages.ts";
import { EMAILS_PAGES } from "./emails/pages.ts";
import { PIRACY_REPORT_PAGES } from "./piracy-reports/pages.ts";
import { DISPUTE_EVIDENCE_PAGES } from "./dispute-evidence/pages.ts";
import type { ActionContext } from "./load-page.ts";
import { DASHBOARD_PAGES } from "./dashboard-pages.ts";
import { OAUTH_APPLICATION_PAGES, SETTINGS_PAGES } from "./settings/pages.ts";
import { STOREFRONT_PAGES } from "./storefront/pages.ts";
import { PRODUCT_PAGES } from "./product-pages.ts";
import { PAYOUTS_PAGES } from "./payouts/pages.ts";
import { CHECKOUT_PAGES } from "./checkout-pages.ts";
import { CHECKOUT_DISCOUNTS_PAGES } from "./checkout-discounts-pages.ts";
import { AGENT_PAGES } from "./agent/pages.ts";
import { SELLER_PRODUCTS_PAGES } from "./seller-products/pages.ts";
import { BUNDLES_PAGES } from "./bundles/pages.ts";
import { URL_REDIRECT_PAGES } from "./url-redirects/pages.ts";
import { COMMUNITY_PAGES } from "./communities/pages.ts";
import { DISCOVER_PAGES } from "./discover/pages.ts";
import { DASHBOARD_HOME_PAGES } from "./dashboard-home/pages.ts";
import { CUSTOMERS_PAGES } from "./customers/pages.ts";

type Params = Record<string, string>;

export type PageSpec = {
  component: string;
  // Redirects Rails sends before it renders: before_actions and rescue_from. `rescued` skips the
  // after_actions, as it does for a halted chain and for a rescued exception.
  // May look things up (a record that must exist) and answer `NOT_FOUND` for `e404`, which the
  // /gr-inertia handler turns into Rails' 404 page. `request` is the visitor's URL and headers.
  redirect?: (params: Params, request: PreflightRequest) => PreflightOutcome | null | Promise<PreflightOutcome | null>;
  // The before_actions that need who is acting (authentication, authorization, a record lookup that
  // 404s by throwing RoutingError); run after `redirect`. A redirect carries `rescued: true`.
  guard?: PageGuard;
  props: (params: Params, action: ActionContext) => Record<string, unknown> | Promise<Record<string, unknown>>;
  mobileAppWebView?: boolean;
  // A controller that overrides `analytics_enabled?` (CheckoutController: always true).
  analyticsEnabled?: boolean;
  // The controller's filters beyond ApplicationController's (see ActionOptions): both the proxy's
  // envelope and the X-Inertia handler run the chain with them.
  options?: ActionOptions;
};

const helpCenterRoot = (): Redirected => ({ status: 302, location: Routes.help_center_root_path(), rescued: true });

// HelpCenter::BaseController before_action
const baseMetaTags = ({ meta }: ActionContext) => {
  meta.set({ property: "og:type", content: "website" });
  meta.set({ name: "twitter:card", content: "summary" });
};

export const PAGES: Record<string, PageSpec> = {
  ...AUDIENCE_PAGES,
  ...ANALYTICS_PAGES,
  ...DASHBOARD_HOME_PAGES,
  ...CUSTOMERS_PAGES,
  ...CHECKOUT_DISCOUNTS_PAGES,
  ...EMAILS_PAGES,
  "/help": {
    component: "HelpCenter/Articles/Index",
    props: (_, action) => {
      baseMetaTags(action);
      return articlesIndex(action);
    },
  },
  "/help/article": {
    component: "HelpCenter/Articles/Index",
    props: (_, action) => {
      baseMetaTags(action);
      return articlesIndex(action);
    },
  },
  "/help/article/:slug": {
    component: "HelpCenter/Articles/Show",
    redirect: ({ slug }) => {
      const legacy = LEGACY_ARTICLE_REDIRECTS[slug!];
      if (legacy !== undefined) return { status: 301, location: legacy, rescued: true };
      return findArticleBySlug(slug!) ? null : helpCenterRoot();
    },
    props: ({ slug }, action) => {
      baseMetaTags(action);
      // `redirect` has already sent unknown slugs away.
      const article = findArticleBySlug(slug!)!;
      const { meta, urlOptions } = action;

      const title = `${article.title} - Gumroad Help Center`;
      const canonicalUrl = Routes.help_center_article_url(article.slug, urlOptions);
      meta.set({ title });
      meta.set({ tag_name: "link", rel: "canonical", href: canonicalUrl, head_key: "canonical" });
      meta.set({ name: "description", content: article.description });
      meta.set({ property: "og:title", content: title });
      meta.set({ property: "og:description", content: article.description });
      meta.set({ property: "og:url", content: canonicalUrl });
      meta.set({ name: "twitter:title", content: title });
      meta.set({ name: "twitter:description", content: article.description });
      return articleProps(article, { urlOptions, assetHost: assetHost(action.config) });
    },
  },
  // LoginsController#new, Signup, two-factor and secure redirect: filters in controllers/auth-pages.ts.
  "/login": { component: "Logins/New", options: LOGIN_OPTIONS, props: (_, action) => loginPageProps(action) },
  "/oauth/login": { component: "Logins/New", options: LOGIN_OPTIONS, props: (_, action) => loginPageProps(action) },
  "/signup": { component: "Signup/New", options: SIGNUP_OPTIONS, props: (_, action) => signupPageProps(action) },
  "/two-factor": { component: "TwoFactorAuthentication/Show", options: TWO_FACTOR_OPTIONS, props: (_, action) => twoFactorPageProps(action) },
  // Users::ReviewRemindersController: the opt-out is written by the filters (controllers/review-reminders.ts).
  "/users/subscribe_review_reminders": { component: "Users/ReviewReminders/Subscribe", options: REVIEW_REMINDER_OPTIONS.subscribe, props: () => ({}) },
  "/users/unsubscribe_review_reminders": { component: "Users/ReviewReminders/Unsubscribe", options: REVIEW_REMINDER_OPTIONS.unsubscribe, props: () => ({}) },
  "/users/subscribe_review_reminders/:id": { component: "Users/ReviewReminders/Subscribe", options: REVIEW_REMINDER_OPTIONS.subscribeByToken, props: () => ({}) },
  "/users/unsubscribe_review_reminders/:id": {
    component: "Users/ReviewReminders/Unsubscribe",
    options: REVIEW_REMINDER_OPTIONS.unsubscribeByToken,
    props: (_, action) => reviewReminderProps(action.state),
  },
  "/secure_url_redirect": { component: "SecureRedirect/New", options: SECURE_REDIRECT_OPTIONS, props: (_, action) => secureRedirectPageProps(action) },
  "/help/category/:slug": {
    component: "HelpCenter/Categories/Show",
    redirect: ({ slug }) => (findCategoryBySlug(slug!) ? null : helpCenterRoot()),
    props: ({ slug }, action) => {
      baseMetaTags(action);
      // `redirect` has already sent unknown slugs away.
      const category = findCategoryBySlug(slug!)!;
      action.meta.set({ title: `${category.title} - Gumroad Help Center` });
      action.meta.set({
        tag_name: "link",
        rel: "canonical",
        href: Routes.help_center_category_url(category.slug, action.urlOptions),
        head_key: "canonical",
      });
      return categoryProps(category);
    },
  },
  ...SETTINGS_PAGES,
  // Before PUBLIC_PAGES: `/blog/p/:slug` must match ahead of `/:username/p/:slug`, as config/routes.rb orders them.
  ...STOREFRONT_PAGES,
  ...PUBLIC_PAGES,
  ...DASHBOARD_PAGES,
  ...BUYER_PAGES,
  ...OAUTH_APPLICATION_PAGES,
  ...PRODUCT_PAGES,
  ...PAYOUTS_PAGES,
  ...CHECKOUT_PAGES,
  ...DISPUTE_EVIDENCE_PAGES,
  ...PIRACY_REPORT_PAGES,
  ...AGENT_PAGES,
  ...SELLER_PRODUCTS_PAGES,
  ...BUNDLES_PAGES,
  ...URL_REDIRECT_PAGES,
  ...COMMUNITY_PAGES,
  ...DISCOVER_PAGES,
};

// ArticlesController#index
function articlesIndex({ meta, urlOptions }: ActionContext) {
  const title = "Gumroad Help Center";
  const description = "Common questions and support documentation";
  const canonicalUrl = Routes.help_center_root_url(urlOptions);

  meta.set({ title });
  meta.set({ tag_name: "link", rel: "canonical", href: canonicalUrl, head_key: "canonical" });
  meta.set({ name: "description", content: description });
  meta.set({ property: "og:title", content: title });
  meta.set({ property: "og:description", content: description });
  meta.set({ property: "og:url", content: canonicalUrl });
  meta.set({ name: "twitter:title", content: title });
  meta.set({ name: "twitter:description", content: description });
  return indexProps();
}

const decodeSegment = (segment: string) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

// Where a page is served: the Gumroad domain, or a seller's or product's host. A page that is not on the
// Gumroad domain is keyed "seller:/path" or "product:/path" (see route-table.ts).
export type PageScope = "gumroad" | "seller" | "product";

export const scopeOfPattern = (pattern: string): PageScope => (splitScopedPattern(pattern).scope as PageScope | null) ?? "gumroad";

// Params for a path that matches `pattern` (`:name` is one segment, as in route-table.ts).
export function matchPagePath(pathname: string, scope: PageScope = "gumroad"): { pattern: string; params: Params } | null {
  // A glob (`/*taxonomy`) is every path, so it matches after the others.
  const patterns = Object.keys(PAGES).sort((a, b) => Number(a.includes("/*")) - Number(b.includes("/*")));
  for (const pattern of patterns) {
    const { scope: patternScope, path } = splitScopedPattern(pattern);
    if ((patternScope ?? "gumroad") !== scope) continue;
    const names: string[] = [];
    const source = path
      .split("/")
      .map((segment) => {
        // `*name` takes the rest of the path, as in route-table.ts.
        if (segment.startsWith("*")) {
          names.push(segment.slice(1));
          // Rails reads a trailing `.ext` as the format, so a glob never spans one.
          return "([^.?]+)";
        }
        if (!segment.startsWith(":")) return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        names.push(segment.slice(1));
        return "([^/.?]+)";
      })
      .join("/");
    const match = new RegExp(`^${source}$`).exec(pathname);
    if (match) return { pattern, params: Object.fromEntries(names.map((name, i) => [name, decodeSegment(match[i + 1]!)])) };
  }
  return null;
}
