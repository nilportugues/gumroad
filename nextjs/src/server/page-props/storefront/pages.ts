// The storefront pages (WS-68): what a seller's subdomain and custom domain serve, and the Gumroad blog's
// post page. Keys with a `seller:` prefix exist only on those hosts (see route-table.ts).
import type { PageSpec } from "../pages.ts";
import { POST_PAGES } from "./post-pages.ts";
import { PROFILE_PAGES } from "./profile-pages.ts";

export const STOREFRONT_PAGES: Record<string, PageSpec> = {
  ...POST_PAGES,
  ...PROFILE_PAGES,
};
