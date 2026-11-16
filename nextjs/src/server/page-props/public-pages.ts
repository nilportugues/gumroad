// PublicController's Inertia pages (WS-55). Registered in pages.ts.
import { GUMROAD_BLOG_PAGES } from "./gumroad-blog.ts";
import type { PageSpec } from "./pages.ts";
import { POSTS_PAGES } from "./posts.ts";
import { SELLER_PAGES } from "./seller-pages.ts";
import { widgetProps } from "./widgets.ts";

// `before_action { opt_out_of_header(:csp) }`: external JS runs on these pages.
const publicPage = (component: string, title: string): PageSpec => ({
  component,
  options: { optOutOfCsp: true },
  props: (_, { meta }) => {
    meta.set({ title });
    return {};
  },
});

export const PUBLIC_PAGES: Record<string, PageSpec> = {
  ...GUMROAD_BLOG_PAGES,
  ...POSTS_PAGES,
  ...SELLER_PAGES,
  "/widgets": {
    component: "Public/Widgets",
    options: { optOutOfCsp: true },
    props: async (_, { meta, context }) => {
      meta.set({ title: "Widgets" });
      return widgetProps(context.currentSeller);
    },
  },
  "/api": publicPage("Public/Api", "API"),
  "/ping": publicPage("Public/Ping", "Ping"),
  "/charge": publicPage("Public/Charge", "Why is there a charge on my account?"),
  "/license-key-lookup": publicPage("Public/LicenseKeyLookup", "Find your download or license key"),
};
