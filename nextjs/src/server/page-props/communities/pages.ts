// CommunitiesController#index and #show. The chat itself (posting, reactions, read markers, the cable
// channels) stays in Rails and the browser's cable connection; these pages are the first render.
import { db } from "../../../lib/db.ts";
import { decrypt, encrypt } from "../../../lib/obfuscate-ids.ts";
import { type ActionOptions, RoutingError, type Redirected } from "../../controllers/application-controller.ts";
import { signedInFilters } from "../../controllers/buyer-pages.ts";
import { isPresent, queryParam, type RailsRequest } from "../../controllers/rails-request.ts";
import { accessibleCommunitiesIds } from "../../models/community.ts";
import type { AuthorizedSellerContext } from "../../policies/seller-context.ts";
import { lazy, scroll } from "../lazy-props.ts";
import type { ActionContext } from "../load-page.ts";
import type { PageSpec } from "../pages.ts";
import { notAllowedMessage } from "../settings/guard.ts";
import { hasAccessibleCommunities } from "../signed-in/reads.ts";
import { communitiesReader, hasProducts, lastReadTimestamp, paginatedMessages, type FetchType } from "./communities.ts";

const PATH = /^\/communities\/([^/.]+)\/([^/.]+)$/u;

const decode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const idFromExternal = (value: string): bigint | null => {
  const id = decrypt(decode(value));
  return id === null ? null : BigInt(id);
};

// set_community: User.find_by_external_id!, Community.alive.find_by_external_id!, then the seller must match.
async function findCommunity(sellerParam: string, communityParam: string) {
  const communityId = idFromExternal(communityParam);
  // User.find_by_external_id!: users carry their (numeric) external id in a column.
  const seller = await db.user.findFirst({ where: { external_id: decode(sellerParam) } });
  const community = communityId === null ? null : await db.community.findFirst({ where: { id: communityId, deleted_at: null } });
  if (!seller || !community || community.seller_id !== seller.id) throw new RoutingError("Not Found");
  return community;
}

// PunditAuthorization#default_user_not_authorized
function notAuthorized(chain: { request: { queryString: string } }, context: AuthorizedSellerContext): Redirected {
  const switched = new URLSearchParams(chain.request.queryString).has("account_switched");
  return { status: 302, location: "/dashboard", rescued: true, ...(switched ? {} : { flash: { alert: notAllowedMessage(context) } }) };
}

const INDEX_OPTIONS: ActionOptions = {
  filters: signedInFilters({
    authorize: () => true,
    // authorize Community => CommunityPolicy#index?
    beforeAction: async (chain, context) => ((await hasAccessibleCommunities(context.user)) ? null : notAuthorized(chain, context)),
    // The first community, or the empty page.
    action: async (_, context) => {
      const first = (await communitiesReader(context.seller!)).firstCommunity;
      if (!first) return null;
      const owner = await db.user.findUnique({ where: { id: BigInt(first.seller_id) } });
      return { status: 302, location: `/communities/${owner!.external_id!}/${encrypt(first.id)}` };
    },
  }),
};

const SHOW_OPTIONS: ActionOptions = {
  filters: signedInFilters({
    authorize: () => true,
    beforeAction: async (chain, context) => {
      const [, sellerParam, communityParam] = PATH.exec(chain.request.path) ?? [];
      const community = await findCommunity(sellerParam!, communityParam!);
      // authorize @community => CommunityPolicy#show?
      const ids = await accessibleCommunitiesIds(context.user);
      return ids.some((id) => BigInt(id) === community.id) ? null : notAuthorized(chain, context);
    },
  }),
};

const query = (action: ActionContext, name: string) => queryParam({ queryString: action.url.search.replace(/^\?/u, "") } as RailsRequest, name);

async function indexProps(action: ActionContext) {
  // The controller declares set_default_page_title again, which moves it to the end of the chain.
  action.meta.moveToEnd(["title"]).set({ title: "Communities" });
  const seller = action.context.currentSeller!;
  const reader = await communitiesReader(seller);
  return {
    has_products: lazy(() => hasProducts(seller)),
    communities: lazy(() => reader.communitiesProps()),
    notification_settings: lazy(() => reader.notificationSettingsProps()),
  };
}

const MERGE_INTENT = { prepend: "older", append: "newer" } as const;

export const COMMUNITY_PAGES: Record<string, PageSpec> = {
  "/communities": {
    component: "Communities/Index",
    options: INDEX_OPTIONS,
    props: (_, action) => indexProps(action),
  },
  "/communities/:seller_id/:community_id": {
    component: "Communities/Index",
    options: SHOW_OPTIONS,
    props: async ({ seller_id, community_id }, action) => {
      const base = await indexProps(action);
      const community = await findCommunity(seller_id!, community_id!);
      const seller = action.context.currentSeller!;

      const intent = action.headers.get("x-inertia-infinite-scroll-merge-intent");
      const fetchType: FetchType = intent === "prepend" || intent === "append" ? MERGE_INTENT[intent] : "around";
      const cursorParam = query(action, "cursor");
      const cursor = isPresent(cursorParam) ? cursorParam : ((await lastReadTimestamp(seller.id, community.id)) ?? new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"));

      let data: ReturnType<typeof paginatedMessages> | null = null;
      const page = () => (data ??= paginatedMessages(community.id, community.seller_id, cursor, fetchType));
      return {
        ...base,
        selectedCommunityId: encrypt(community.id),
        messages: scroll(
          async () => {
            const { nextOlderTimestamp, nextNewerTimestamp } = await page();
            return { pageName: "cursor", previousPage: nextOlderTimestamp, nextPage: nextNewerTimestamp, currentPage: cursor };
          },
          async () => (await page()).messages,
        ),
      };
    },
  },
};
