// EmailsController#index, #published, #scheduled, #drafts, #new and #edit (GET renders only).
import type { Installment, User } from "@prisma/client";

import { RoutingError } from "../../controllers/application-controller.ts";
import { authorize } from "../../policies/authorize.ts";
import { installmentPolicy } from "../../policies/installment.ts";
import { decrypt } from "../../../lib/obfuscate-ids.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { Prisma } from "@prisma/client";
import { createUserEvent } from "../audience/events.ts";
import { sellerGuard } from "../audience/seller-guard.ts";
import { present, stringParam } from "../audience/support.ts";
import { lazy, merge } from "../lazy-props.ts";
import type { PageSpec } from "../pages.ts";
import {
  emailsListParams,
  findInstallmentByExternalId,
  hasPosts,
  hasScheduledEmails,
  installmentFormContext,
  installmentPropsFor,
  notClickedPostIdOf,
  paginatedInstallmentsProps,
} from "./emails.ts";
import type { InstallmentListType } from "./installment-search.ts";

const seller = (context: { currentSeller: User | null }) => context.currentSeller!;
const queryOf = (url: URL) => ({ queryString: url.search.replace(/^\?/, "") });

const listPage = (component: string, type: InstallmentListType): PageSpec => ({
  component,
  guard: (info) => sellerGuard(info, (context) => authorize(installmentPolicy.index, context)),
  props: async (_, { context, meta, url, headers, renderState }) => {
    meta.set({ title: "Emails" });
    // Load more and search are partial reloads of a page the seller already viewed.
    if (!headers.has("x-inertia-partial-component")) await createUserEvent("emails_view", { context, headers, url, state: renderState });
    const props = await paginatedInstallmentsProps(seller(context), type, emailsListParams(queryOf(url)));
    return {
      installments: merge(() => props.installments),
      pagination: props.pagination,
      has_posts: lazy(() => hasPosts(seller(context), type)),
    };
  },
});

// `authorize Installment` and the redirect to the tab the seller last had content in.
const emailsIndex: PageSpec = {
  component: "Emails/Index",
  guard: async (info) => {
    let target = "";
    const denied = await sellerGuard(info, async (context) => {
      authorize(installmentPolicy.index, context);
      target = (await hasScheduledEmails(context.seller!)) ? "/emails/scheduled" : "/emails/published";
    });
    return denied ?? { status: 301, location: target };
  },
  props: () => {
    throw new Error("EmailsController#index always redirects");
  },
};

const FROM_TABS = ["published", "scheduled", "drafts"] as const;

const emailsNew: PageSpec = {
  component: "Emails/New",
  guard: (info) => sellerGuard(info, (context) => authorize(installmentPolicy.new, context)),
  props: async (_, { context, meta, url, headers, urlOptions }) => {
    meta.set({ title: "Emails" });
    const origin = `${urlOptions.protocol}://${urlOptions.host}`;
    const referer = headers.get("referer");
    const fromTab = FROM_TABS.find((tab) => referer === `${origin}/emails/${tab}`) ?? "drafts";
    const query = queryOf(url);
    const copyFrom = stringParam(query, "copy_from");
    const purchaseId = stringParam(query, "purchase_id");

    let reference: Installment | null = null;
    if (present(copyFrom)) {
      const found = await findInstallmentByExternalId(seller(context), copyFrom);
      // not_workflow_installment
      reference = found && found.workflow_id === null ? found : null;
    }
    const installment = reference ? (({ external_id: _removed, ...rest }) => rest)(await installmentPropsFor(seller(context), reference)) : null;
    return {
      context: await installmentFormContext(seller(context), { notClickedPostId: notClickedPostIdOf(reference), fromTab }),
      installment,
      single_customer_recipient: await singleCustomerRecipient(seller(context), purchaseId),
    };
  },
};

// InstallmentPresenter#single_customer_recipient_props
async function singleCustomerRecipient(seller: User, purchaseId: string) {
  if (!present(purchaseId)) return null;
  const id = decrypt(purchaseId);
  if (id === null) return null;
  const [purchase] = await selectRows<{ id: number; email: string | null }>(
    Prisma.sql`SELECT ${column("purchases", "id")}, ${column("purchases", "email")} FROM ${table("purchases")} WHERE ${column("purchases", "seller_id")} = ${seller.id} AND ${column("purchases", "id")} = ${id} LIMIT 1`,
  );
  return purchase ? { purchase_id: purchaseId, email: purchase.email } : null;
}

const emailsEdit: PageSpec = {
  component: "Emails/Edit",
  guard: (info) =>
    sellerGuard(info, async (context) => {
      // set_installment, then the action's authorize.
      const installment = await findInstallmentByExternalId(context.seller!, info.params.id!);
      if (!installment) throw new RoutingError("Not Found");
      authorize(installmentPolicy.edit, context);
    }),
  props: async (params, { context, meta }) => {
    meta.set({ title: "Emails" });
    const installment = (await findInstallmentByExternalId(seller(context), params.id!))!;
    return {
      context: await installmentFormContext(seller(context), { notClickedPostId: notClickedPostIdOf(installment), fromTab: null }),
      installment: await installmentPropsFor(seller(context), installment),
    };
  },
};

export const EMAILS_PAGES: Record<string, PageSpec> = {
  "/emails": emailsIndex,
  "/emails/published": listPage("Emails/Published", "published"),
  "/emails/scheduled": listPage("Emails/Scheduled", "scheduled"),
  "/emails/drafts": listPage("Emails/Drafts", "draft"),
  "/emails/new": emailsNew,
  "/emails/:id/edit": emailsEdit,
};
