// PiracyReportsController#index, #new and #show (GET renders); the writes are in controllers/piracy-reports-mutations.ts.
import type { Link, PiracyReport, User } from "@prisma/client";

import * as Routes from "@/lib/navigation/routes";

import { db } from "../../../lib/db.ts";
import { RoutingError } from "../../controllers/application-controller.ts";
import { domainConfig } from "../domain.ts";
import { isFeatureEnabled, userActor } from "../../infra/flipper.ts";
import { isBlank } from "../../models/compliance-countries.ts";
import { aliveUserComplianceInfoRow, legalEntityName } from "../../models/user-compliance-info.ts";
import { LinkFlags } from "../../models/link.ts";
import { RISK_STATES } from "../../models/user.ts";
import { loadSellerContext, NotAuthorizedError, requireUser, roleAdminFor, type SellerContext } from "../../policies/seller-context.ts";
import { MIN_SALES_CENTS_VALUE_FOR_STORE_AGENT } from "../../search/purchase-sales.ts";
import { sellerGuard } from "../audience/seller-guard.ts";
import { userSubdomainWithProtocol } from "../audience/support.ts";
import type { GuardInput } from "../guards.ts";
import type { PageSpec } from "../pages.ts";
import { eligibleForStoreAgent } from "../signed-in/policy-props.ts";
import { railsEnv } from "../../infra/rails-env.ts";

export const MONTHLY_LIMIT = 5;
const MIN_SUCCESSFUL_SALES = 1;
export const SIGNATURE_STATEMENT_VERSION = "2026-10-07";
export const SIGNATURE_CONFIRMATIONS: [string, string][] = [
  ["details_shared", "The notice shows my legal name and email address. The site can share the notice with the person who posted the page, and the notice may be published, for example on Lumen."],
  ["own_statements", "I have read this notice, and I make its statements myself, including the statement under penalty of perjury."],
  ["misrepresentation_liability", "If I knowingly misrepresent that this page infringes my work, I can be liable for damages, costs and attorneys' fees under 17 U.S.C. § 512(f)."],
  ["fair_use_considered", "I considered whether the page could be a licensed use or a fair use of my work, such as a review, a commentary or a short excerpt."],
  ["authorize_gumroad", "I authorize Gumroad to send this notice by email for me, and to put my typed name on it as my signature."],
];
export const CANCELLABLE_STATES = ["requested", "screening", "awaiting_signature", "signed"];
const SKIP_SALES_CHECKS_FLAG = "piracy_reports_skip_sales_checks";

const feature = (name: string, seller: User) => isFeatureEnabled(name, userActor(seller.id));

// ISO 8601 as Rails prints a UTC time: whole seconds, "Z".
const iso8601 = (value: Date) => value.toISOString().replace(/\.\d+Z$/u, "Z");
const isoDate = (value: Date) => value.toISOString().slice(0, 10);

// Link#long_url
export function longUrl(product: Link, owner: User): string {
  const config = domainConfig(process.env);
  const host = userSubdomainWithProtocol(owner) ?? `${config.protocol}://${config.domain}`;
  const permalink = product.custom_permalink !== null && !isBlank(product.custom_permalink) ? product.custom_permalink : (product.unique_permalink ?? "");
  return `${host}/l/${encodeURIComponent(permalink)}`;
}

// PiracyReportPolicy#create? (also #new?)
export const policyCreate = async (context: SellerContext) => {
  const c = requireUser(context);
  return roleAdminFor(c) && (await feature("piracy_reports", c.seller!));
};

// PiracyReportPolicy#index? and #show? (the record always belongs to the seller: it was looked up through them).
export const policyAdmin = (context: SellerContext) => roleAdminFor(requireUser(context));

async function authorizeAsync(query: (context: SellerContext) => boolean | Promise<boolean>, context: SellerContext): Promise<void> {
  if (!(await query(context))) throw new NotAuthorizedError();
}

// PiracyReports::Eligibility#errors
export async function eligibilityErrors(seller: User, product: Link): Promise<string[]> {
  const errors: string[] = [];
  const suspended = (RISK_STATES.SUSPENDED as readonly (string | null)[]).includes(seller.user_risk_state);
  const skipSalesChecks = await feature(SKIP_SALES_CHECKS_FLAG, seller);
  if (!(await feature("piracy_reports", seller))) errors.push("Piracy reports are not enabled for this seller");
  if (suspended) errors.push("The seller's account is suspended");
  if (!suspended && !skipSalesChecks && !(await eligibleForStoreAgent(seller, railsEnv() === "development"))) {
    // MoneyFormatter.format(..., :usd, no_cents_if_whole: true, symbol: true)
    errors.push(`Piracy reports unlock with the Agent: confirm your email, complete a payout and reach $${MIN_SALES_CENTS_VALUE_FOR_STORE_AGENT / 100} in sales`);
  }
  const info = await aliveUserComplianceInfoRow(seller.id);
  const legalName = info ? legalEntityName(info) : null;
  if (legalName === null || isBlank(legalName)) errors.push("The seller's payout record has no legal name to print in the notice");
  if (product.user_id !== seller.id) errors.push("The product does not belong to the seller");
  if (!(product.deleted_at === null && product.purchase_disabled_at === null && !product.draft)) errors.push("The product is not published");
  if (await hasConfirmedCollaborator(product.id)) errors.push("The product has a collaborator");
  if (!skipSalesChecks && !((await successfulSalesCount(product.id)) >= MIN_SUCCESSFUL_SALES)) errors.push("The product has no successful sales");
  return errors;
}

// Link#confirmed_collaborator: an alive Collaborator on the product whose invitation was accepted.
async function hasConfirmedCollaborator(productId: bigint): Promise<boolean> {
  const rows = await db.$queryRaw<unknown[]>`
    SELECT 1 FROM affiliates
    INNER JOIN affiliates_links ON affiliates_links.affiliate_id = affiliates.id
    LEFT OUTER JOIN collaborator_invitations ON collaborator_invitations.collaborator_id = affiliates.id
    WHERE affiliates_links.link_id = ${productId} AND affiliates.type = 'Collaborator'
      AND collaborator_invitations.id IS NULL AND affiliates.deleted_at IS NULL LIMIT 1`;
  return rows.length > 0;
}

async function successfulSalesCount(productId: bigint): Promise<number> {
  return db.purchase.count({ where: { link_id: productId, purchase_state: "successful" } });
}

async function archivedProductsCount(seller: User): Promise<number> {
  const rows = await db.$queryRaw<{ count: bigint }[]>`SELECT COUNT(*) AS count FROM links WHERE user_id = ${seller.id} AND deleted_at IS NULL AND ${LinkFlags.condition("archived")}`;
  return Number(rows[0]?.count ?? 0);
}

const seller = (context: { currentSeller: User | null }) => context.currentSeller!;

export const productsRedirect = (alert: string) => ({ status: 302, location: Routes.products_path(), flash: { alert }, rescued: true }) as const;

// set_product: the seller's alive product by unique permalink, else back to the products list.
export async function findProduct(owner: User, permalink: string | null): Promise<Link | null> {
  return db.link.findFirst({ where: { user_id: owner.id, unique_permalink: permalink ?? "", purchase_disabled_at: null, banned_at: null, deleted_at: null } });
}

const productIdParam = (url: URL) => url.searchParams.getAll("product_id").at(-1) ?? null;

export async function findReport(owner: User, externalId: string): Promise<PiracyReport | null> {
  return db.piracyReport.findFirst({ where: { external_id: externalId, seller_id: owner.id } });
}

// Sellers::BaseController runs authenticate_user! and require_account_email ahead of the page's own
// before_actions; authorization comes last, in the action.
export async function guard(info: GuardInput, lookup: (context: SellerContext) => Promise<ReturnType<typeof productsRedirect> | null>, query: (context: SellerContext) => boolean | Promise<boolean>) {
  let missing: ReturnType<typeof productsRedirect> | null = null;
  const halted = await sellerGuard(info, async (context) => {
    missing = await lookup(context);
  });
  if (halted) return halted;
  if (missing) return missing;
  return sellerGuard(info, (context) => authorizeAsync(query, context));
}

function history(report: PiracyReport) {
  const screened = (report.screening_verdict === "pass" || report.screening_verdict === "fail") && report.state !== "screening" ? report.screened_at : null;
  const events: [string, Date | null][] = [
    ["filed", report.created_at],
    [report.state === "declined" ? "declined" : "confirmed", screened],
    ["signed", report.signed_at],
    ["sent", report.sent_at],
    ["delivered", report.delivered_at],
    ["counter_notice", report.counter_notice_received_on],
    ["resolved", report.state === "resolved" ? report.resolved_at : null],
    ["closed", report.state === "cancelled" ? report.updated_at : null],
  ];
  return events.flatMap(([event, at]) => (at ? [{ event, at: event === "counter_notice" ? isoDate(at) : iso8601(at) }] : []));
}

// PiracyReport#restoration_window: weekdays only, 10 and 14 business days after the counter-notice.
function restorationWindow(report: PiracyReport): string[] | null {
  if (report.counter_notice_received_on === null) return null;
  const add = (days: number) => {
    const day = new Date(report.counter_notice_received_on!.getTime());
    for (let i = 0; i < days; i++) {
      day.setUTCDate(day.getUTCDate() + 1);
      while (day.getUTCDay() === 0 || day.getUTCDay() === 6) day.setUTCDate(day.getUTCDate() + 1);
    }
    return isoDate(day);
  };
  return [add(10), add(14)];
}

export const PIRACY_REPORT_PAGES: Record<string, PageSpec> = {
  "/dashboard/piracy_reports": {
    component: "PiracyReports/Index",
    guard: (info) => sellerGuard(info, (context) => authorizeAsync(policyAdmin, context)),
    props: async (_, { context }) => {
      const owner = seller(context);
      const reports = await db.piracyReport.findMany({ where: { seller_id: owner.id }, orderBy: { id: "desc" } });
      const products = new Map((await db.link.findMany({ where: { id: { in: [...new Set(reports.map((report) => report.product_id))] } } })).map((product) => [product.id, product]));
      return {
        archived_tab_visible: (await archivedProductsCount(owner)) > 0,
        can_report: await policyCreate(await loadSellerContext(context)),
        reports: reports.map((report) => ({
          id: report.external_id,
          product_name: products.get(report.product_id)!.name,
          url: report.url,
          state: report.state,
          outcome: report.outcome,
          updated_at: iso8601(report.updated_at),
        })),
      };
    },
  },
  "/dashboard/piracy_reports/new": {
    component: "PiracyReports/New",
    guard: (info) =>
      guard(
        info,
        async (context) => ((await findProduct(context.seller!, productIdParam(info.url))) ? null : productsRedirect("Product not found")),
        policyCreate,
      ),
    props: async (_, { context, url }) => {
      const owner = seller(context);
      const product = (await findProduct(owner, productIdParam(url)))!;
      const startOfMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
      return {
        product: { id: product.unique_permalink, name: product.name, url: longUrl(product, owner) },
        eligibility_errors: await eligibilityErrors(owner, product),
        reports_this_month: await db.piracyReport.count({ where: { seller_id: owner.id, created_at: { gte: startOfMonth } } }),
        monthly_limit: MONTHLY_LIMIT,
      };
    },
  },
  "/dashboard/piracy_reports/:id": {
    component: "PiracyReports/Show",
    guard: (info) =>
      guard(
        info,
        async (context) => ((await findReport(context.seller!, info.params.id!)) ? null : productsRedirect("Report not found")),
        policyAdmin,
      ),
    props: async (params, { context }) => {
      const owner = seller(context);
      const report = (await findReport(owner, params.id!))!;
      const product = await db.link.findUnique({ where: { id: report.product_id } });
      if (!product) throw new RoutingError("Not Found");
      return {
        report: {
          id: report.external_id,
          state: report.state,
          url: report.url,
          created_at: iso8601(report.created_at),
          notice_text: report.notice_text,
          notice_digest: report.notice_digest,
          signed_at: report.signed_at && iso8601(report.signed_at),
          signed_by_name: report.signed_by_name,
          can_cancel: CANCELLABLE_STATES.includes(report.state),
          sent_at: report.sent_at && iso8601(report.sent_at),
          recipient_name: report.recipient_name,
          restoration_window: restorationWindow(report),
          waiting_on_person: report.state === "screening" && report.screening_verdict !== null && report.screening_verdict !== "",
          history: history(report),
          counter_notice_received_on: report.counter_notice_received_on && isoDate(report.counter_notice_received_on),
          outcome: report.outcome,
        },
        product: { name: product.name, url: longUrl(product, (await db.user.findUnique({ where: { id: product.user_id ?? -1n } }))!) },
        confirmations: SIGNATURE_CONFIRMATIONS.map(([key, text]) => ({ key, text })),
        confirmations_version: SIGNATURE_STATEMENT_VERSION,
        monthly_limit: MONTHLY_LIMIT,
      };
    },
  },
};
