// Seller dashboard pages (Sellers::BaseController descendants). Merged into PAGES by pages.ts.
import * as Routes from "@/lib/navigation/routes";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { RoutingError } from "../controllers/application-controller.ts";
import { queryParam, type RailsRequest } from "../controllers/rails-request.ts";
import { balancePolicy } from "../policies/balance.ts";
import { collaboratorPolicy } from "../policies/collaborator.ts";
import { directAffiliatePolicy } from "../policies/direct-affiliate.ts";
import { loadSellerContext, type SellerContext } from "../policies/seller-context.ts";
import {
  affiliatesIndexProps,
  editAffiliateProps,
  findDirectAffiliate,
  hasEnabledSelfServiceAffiliateProducts,
  newAffiliateProps,
  onboardingProps,
  SORT_KEYS,
  type IndexInput,
  type Sort,
} from "./dashboard/affiliates.ts";
import { collaboratorsIndexProps, incomingCollaboratorsProps, collaboratorsSharedProps, editCollaboratorProps, findAliveCollaborator, newCollaboratorProps } from "./dashboard/collaborators.ts";
import { rubyToI, taxCenterEnabled, taxCenterProps } from "./dashboard/tax-center.ts";
import type { PageSpec } from "./pages.ts";
import type { GuardInput } from "./guards.ts";
import { settingsGuard } from "./settings/guard.ts";

// AffiliatesController#index: string_param(:page), params[:query] and extract_sort_params.
function affiliatesIndexInput(request: RailsRequest): IndexInput {
  const page = Math.max(rubyToI(queryParam(request, "page") ?? ""), 1);
  const query = queryParam(request, "query") ?? null;
  const column = queryParam(request, "column");
  const direction = queryParam(request, "sort");
  const sort: Sort | null = (SORT_KEYS as readonly (string | null | undefined)[]).includes(column) ? { key: column as Sort["key"], direction: direction === "desc" ? "desc" : "asc" } : null;
  return { page, query: query !== null && query.trim() === "" ? null : query, sort, shouldGetAffiliateRequests: page === 1 };
}

// Sellers::BaseController's authenticate_user! and require_account_email, then Pundit's refusal handler.
const sellerGuard = (input: GuardInput, authorize: (context: SellerContext) => boolean | Promise<boolean>) => settingsGuard({ authorize })(input);

// The :id of `/…/:id/edit`.
const editId = (input: GuardInput) => decodeURIComponent(/\/([^/.?]+)\/edit$/.exec(input.url.pathname)![1]!);

const queryOf = (url: URL) => ({ queryString: url.search.replace(/^\?/, "") }) as RailsRequest;

const affiliateFromParams = async (sellerId: bigint, id: string) => {
  const decoded = decrypt(id);
  const affiliate = decoded === null ? null : await findDirectAffiliate(sellerId, decoded);
  if (!affiliate) throw new RoutingError("Not Found");
  return affiliate;
};

const collaboratorFromParams = async (id: string) => {
  const decoded = decrypt(id);
  const collaborator = decoded === null ? null : await findAliveCollaborator(decoded);
  if (!collaborator) throw new RoutingError("Not Found");
  return collaborator;
};

export const DASHBOARD_PAGES: Record<string, PageSpec> = {
  // Collaborators::MainController#index
  "/collaborators": {
    component: "Collaborators/Index",
    guard: (input) => sellerGuard(input, collaboratorPolicy.index),
    props: async (_, { context, meta }) => {
      // Collaborators::BaseController redefines set_default_page_title.
      meta.set({ title: "Collaborators" });
      return { ...(await collaboratorsSharedProps(context.currentSeller!)), ...(await collaboratorsIndexProps(context.currentSeller!)) };
    },
  },

  // Collaborators::IncomingsController#index
  "/collaborators/incomings": {
    component: "Collaborators/Incomings/Index",
    guard: (input) => sellerGuard(input, collaboratorPolicy.index),
    props: async (_, { context, meta }) => {
      meta.set({ title: "Collaborators" });
      return { ...(await collaboratorsSharedProps(context.currentSeller!)), ...(await incomingCollaboratorsProps(context.currentSeller!)) };
    },
  },

  // Collaborators::MainController#new
  "/collaborators/new": {
    component: "Collaborators/New",
    guard: (input) => sellerGuard(input, collaboratorPolicy.new),
    props: async (_, { context, meta }) => {
      meta.set({ title: "Collaborators" });
      return { ...(await collaboratorsSharedProps(context.currentSeller!)), ...(await newCollaboratorProps(context.currentSeller!)) };
    },
  },

  // Collaborators::MainController#edit
  "/collaborators/:id/edit": {
    component: "Collaborators/Edit",
    // set_collaborator is a prepend_before_action: an unknown id is a 404 even before the sign-in check.
    guard: async (input) => {
      const collaborator = await collaboratorFromParams(editId(input));
      return sellerGuard(input, (context) => collaboratorPolicy.edit(context, collaborator));
    },
    props: async ({ id }, { context, meta }) => {
      meta.set({ title: "Collaborators" });
      const seller = context.currentSeller!;
      return { ...(await collaboratorsSharedProps(seller)), ...(await editCollaboratorProps(seller, await collaboratorFromParams(id!))) };
    },
  },

  // AffiliatesController#index
  "/affiliates": {
    component: "Affiliates/Index",
    guard: async (input) => {
      const halted = await sellerGuard(input, directAffiliatePolicy.index);
      if (halted) return halted;
      const seller = input.context.currentSeller!;
      const context = await loadSellerContext(input.context);
      const index = affiliatesIndexInput(queryOf(input.url));
      const data = await affiliatesIndexProps(seller, context, index);
      // A seller with nothing to show and nothing set up yet is sent to the onboarding page.
      if (data.affiliates.length === 0 && data.affiliate_requests.length === 0 && index.page === 1 && index.query === null && !(await hasEnabledSelfServiceAffiliateProducts(seller.id))) {
        return { status: 302, location: Routes.onboarding_affiliates_path() };
      }
      return null;
    },
    props: async (_, { context, meta, url }) => {
      // AffiliatesController declares set_default_page_title again, so it runs after the other callbacks.
      meta.moveToEnd(["title"]).set({ title: "Affiliates" });
      return affiliatesIndexProps(context.currentSeller!, await loadSellerContext(context), affiliatesIndexInput(queryOf(url)));
    },
  },

  // AffiliatesController#onboarding
  "/affiliates/onboarding": {
    component: "Affiliates/Onboarding",
    guard: (input) => sellerGuard(input, directAffiliatePolicy.index),
    props: async (_, { context, meta }) => {
      // AffiliatesController declares set_default_page_title again, so it runs after the other callbacks.
      meta.moveToEnd(["title"]).set({ title: "Affiliates" });
      return onboardingProps(context.currentSeller!);
    },
  },

  // AffiliatesController#new
  "/affiliates/new": {
    component: "Affiliates/New",
    guard: (input) => sellerGuard(input, directAffiliatePolicy.create),
    props: async (_, { context, meta }) => {
      // AffiliatesController declares set_default_page_title again, so it runs after the other callbacks.
      meta.moveToEnd(["title"]).set({ title: "Affiliates" });
      return newAffiliateProps(context.currentSeller!);
    },
  },

  // AffiliatesController#edit
  "/affiliates/:id/edit": {
    component: "Affiliates/Edit",
    guard: async (input) => {
      const halted = await sellerGuard(input, () => true);
      if (halted) return halted;
      // set_affiliate is a before_action: an unknown id is a 404 before the authorization runs.
      await affiliateFromParams(input.context.currentSeller!.id, editId(input));
      return sellerGuard(input, directAffiliatePolicy.update);
    },
    props: async ({ id }, { context, meta }) => {
      // AffiliatesController declares set_default_page_title again, so it runs after the other callbacks.
      meta.moveToEnd(["title"]).set({ title: "Affiliates" });
      const seller = context.currentSeller!;
      return editAffiliateProps(seller, await affiliateFromParams(seller.id, id!));
    },
  },

  // TaxCenterController#index
  "/payouts/taxes": {
    component: "TaxCenter/Index",
    guard: async (input) => {
      const halted = await sellerGuard(input, () => true);
      if (halted) return halted;
      // ensure_tax_center_enabled is a before_action, so it runs ahead of the action's authorize.
      if (!(await taxCenterEnabled(input.context.currentSeller!.id))) {
        return { status: 302, location: Routes.dashboard_path(), rescued: true, flash: { alert: "Tax center is not enabled for your account." } };
      }
      return sellerGuard(input, balancePolicy.index);
    },
    props: async (_, { context, meta, url }) => {
      meta.set({ title: "Payouts" });
      const requested = url.searchParams.getAll("year").at(-1);
      const now = new Date();
      return taxCenterProps(context.currentSeller!, requested === undefined ? now.getUTCFullYear() - 1 : rubyToI(requested), now);
    },
  },
};
