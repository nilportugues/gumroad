// The Inertia pages Next.js serves, keyed by their routes.json pattern. A page's props and redirects
// live here, not in page.tsx, because two places render them: the App Router page (HTML) and the
// X-Inertia route handler (JSON), and both must answer exactly as the Rails action does.
import * as Routes from "@/lib/navigation/routes";

import type { Redirected } from "../controllers/application-controller.ts";
import { assetHost } from "./domain.ts";
import {
  articleProps,
  categoryProps,
  findArticleBySlug,
  findCategoryBySlug,
  indexProps,
  LEGACY_ARTICLE_REDIRECTS,
} from "./help-center.ts";
import type { ActionContext } from "./load-page.ts";

type Params = Record<string, string>;

export type PageSpec = {
  component: string;
  // Redirects Rails sends before it renders: before_actions and rescue_from. `rescued` skips the
  // after_actions, as it does for a halted chain and for a rescued exception.
  redirect?: (params: Params) => Redirected | null;
  props: (params: Params, action: ActionContext) => Record<string, unknown>;
  mobileAppWebView?: boolean;
};

const helpCenterRoot = (): Redirected => ({ status: 302, location: Routes.help_center_root_path(), rescued: true });

// HelpCenter::BaseController before_action
const baseMetaTags = ({ meta }: ActionContext) => {
  meta.set({ property: "og:type", content: "website" });
  meta.set({ name: "twitter:card", content: "summary" });
};

export const PAGES: Record<string, PageSpec> = {
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

// Params for a path that matches `pattern` (`:name` is one segment, as in route-table.ts).
export function matchPagePath(pathname: string): { pattern: string; params: Params } | null {
  for (const pattern of Object.keys(PAGES)) {
    const names: string[] = [];
    const source = pattern
      .split("/")
      .map((segment) => {
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
