// The signed-in audience pages: UTM links, followers, workflows and emails. Each is the GET render
// of a Sellers::BaseController action; the guard is `authenticate_user!` plus the action's
// `authorize`, the props are the action's `render inertia:` hash.
import type { User } from "@prisma/client";

import { RoutingError } from "../../controllers/application-controller.ts";
import { authorize } from "../../policies/authorize.ts";
import { audienceFollowerPolicy } from "../../policies/audience-follower.ts";
import { loadSellerContext, type SellerContext } from "../../policies/seller-context.ts";
import { workflowPolicy } from "../../policies/workflow.ts";
import type { GuardInput } from "../guards.ts";
import { findWorkflowByExternalId, workflowFormContext, workflowLinkBelongsToSeller, workflowPropsFor, workflowsIndexProps } from "./workflows.ts";
import { utmLinkPolicy } from "../../policies/utm-link.ts";
import type { PageSpec } from "../pages.ts";
import { lazy, merge, optional } from "../lazy-props.ts";
import { createUserEvent } from "./events.ts";
import { followersParams, pagedFollowers, totalCount } from "./followers.ts";
import { sellerGuard } from "./seller-guard.ts";
import { generateUniquePermalink, editPageProps, findUtmLinkByExternalId, indexParams, newPageProps, paginatedUtmLinks, utmLinksStats } from "./utm-links.ts";
import { rackParam, stringParam } from "./support.ts";

const seller = (context: { currentSeller: User | null }) => context.currentSeller!;
const queryOf = (url: URL) => ({ queryString: url.search.replace(/^\?/, "") });

const utmLinksIndex: PageSpec = {
  component: "UtmLinks/Index",
  guard: (info) => sellerGuard(info, (context) => authorize(utmLinkPolicy.index, context)),
  props: (_, { context, meta, url }) => {
    meta.set({ title: "UTM Links" });
    const request = queryOf(url);
    const params = indexParams(request);
    let presented: ReturnType<typeof paginatedUtmLinks> | undefined;
    const presenter = () => (presented ??= paginatedUtmLinks(seller(context), params));
    return {
      utm_links: lazy(async () => (await presenter()).utm_links),
      pagination: lazy(async () => (await presenter()).pagination),
      query: params.query,
      sort: params.sort,
      utm_links_stats: merge(() => utmLinksStats(seller(context), rackParam(request, "ids"))),
    };
  },
};

const utmLinksNew: PageSpec = {
  component: "UtmLinks/New",
  guard: (info) => sellerGuard(info, (context) => authorize(utmLinkPolicy.new, context)),
  props: (_, { context, meta, url }) => {
    meta.set({ title: "UTM Links" });
    let presented: ReturnType<typeof newPageProps> | undefined;
    const presenter = () => (presented ??= newPageProps(seller(context), stringParam(queryOf(url), "copy_from")));
    return {
      utm_link: lazy(async () => (await presenter()).utm_link),
      context: lazy(async () => (await presenter()).context),
      additional_metadata: optional(async () => ({ new_permalink: await generateUniquePermalink() })),
    };
  },
};

const utmLinksEdit: PageSpec = {
  component: "UtmLinks/Edit",
  guard: (info) =>
    sellerGuard(info, async (context) => {
      const params = info.params;
      // set_utm_link, then the action's authorize.
      const link = await findUtmLinkByExternalId(context.seller!, params.id!);
      if (!link) throw new RoutingError("Not Found");
      authorize(utmLinkPolicy.edit, context);
    }),
  props: async (params, { context, meta }) => {
    meta.set({ title: "UTM Links" });
    const link = (await findUtmLinkByExternalId(seller(context), params.id!))!;
    return await editPageProps(seller(context), link);
  },
};

// FollowersController < ApplicationController: it authenticates itself and has no account email filter.
const followersIndex: PageSpec = {
  component: "Followers/Index",
  guard: (info) => sellerGuard(info, (context) => authorize(audienceFollowerPolicy.index, context), { requireAccountEmail: false }),
  props: async (_, { context, meta, url, headers, renderState }) => {
    // Load more and search are partial reloads of a page the seller already viewed.
    if (!headers.has("x-inertia-partial-component")) await createUserEvent("followers_view", { context, headers, url, state: renderState });
    meta.set({ title: "Subscribers" });
    meta.set({ property: "og:title", content: "Posts" });

    const params = followersParams(queryOf(url));
    const paged = await pagedFollowers(seller(context), params, await loadSellerContext(context));
    return {
      followers: merge(() => paged.followers),
      total_count: lazy(() => totalCount(seller(context))),
      page: paged.page,
      has_more: paged.hasMore,
      email: params.email,
    };
  },
};

// WorkflowsController and Workflows::EmailsController: `set_workflow` (404, also for a product the
// seller does not own), then `authorize @workflow`.
const workflowGuard =
  (workflowParam: string, query: (context: SellerContext) => boolean) =>
  (info: GuardInput) =>
    sellerGuard(info, async (context) => {
      const params = info.params;
      const workflow = await findWorkflowByExternalId(context.seller!, params[workflowParam]!);
      if (!workflow || !(await workflowLinkBelongsToSeller(context.seller!, workflow))) throw new RoutingError("Not Found");
      authorize(query, context);
    });

const workflowsIndex: PageSpec = {
  component: "Workflows/Index",
  guard: (info) => sellerGuard(info, (context) => authorize(workflowPolicy.index, context)),
  props: async (_, { context, meta, url, headers, renderState }) => {
    meta.set({ title: "Workflows" });
    await createUserEvent("workflows_view", { context, headers, url, state: renderState });
    return await workflowsIndexProps(seller(context));
  },
};

const workflowsNew: PageSpec = {
  component: "Workflows/New",
  guard: (info) => sellerGuard(info, (context) => authorize(workflowPolicy.new, context)),
  props: (_, { context, meta }) => {
    meta.set({ title: "Workflows" });
    return { context: lazy(() => workflowFormContext(seller(context))) };
  },
};

const workflowsEdit: PageSpec = {
  component: "Workflows/Edit",
  guard: workflowGuard("id", workflowPolicy.edit),
  props: async (params, { context, meta }) => {
    meta.set({ title: "Workflows" });
    const workflow = (await findWorkflowByExternalId(seller(context), params.id!))!;
    return {
      workflow: lazy(() => workflowPropsFor(seller(context), workflow)),
      context: lazy(() => workflowFormContext(seller(context))),
    };
  },
};

const workflowEmailsIndex: PageSpec = {
  component: "Workflows/Emails/Index",
  guard: workflowGuard("workflow_id", workflowPolicy.index),
  props: async (params, { context, meta }) => {
    const workflow = (await findWorkflowByExternalId(seller(context), params.workflow_id!))!;
    meta.set({ title: workflow.name ?? "" });
    return {
      workflow: lazy(() => workflowPropsFor(seller(context), workflow)),
      context: lazy(() => workflowFormContext(seller(context))),
    };
  },
};

export const AUDIENCE_PAGES: Record<string, PageSpec> = {
  "/followers": followersIndex,
  "/workflows": workflowsIndex,
  "/workflows/new": workflowsNew,
  "/workflows/:id/edit": workflowsEdit,
  "/workflows/:workflow_id/emails": workflowEmailsIndex,
  "/dashboard/utm_links": utmLinksIndex,
  "/dashboard/utm_links/new": utmLinksNew,
  "/dashboard/utm_links/:id/edit": utmLinksEdit,
};
